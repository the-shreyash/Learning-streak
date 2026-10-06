/** Dashboard rendering: streak hero, today's progress, course, stat tiles. */
import { computeStreaks } from '../core/streakEngine.js';
import { computeStats, currentWeekDays } from '../core/statisticsEngine.js';
import { formatDuration, formatDurationCompact, formatMinSec, formatRate, wholeMinutes, pluralize } from '../core/format.js';
import { legacySecondsOf } from '../core/records.js';
import { el } from '../shared/stateClient.js';

const $ = (id) => document.getElementById(id);
const WEEK_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * @param {object} state persisted state
 * @param {string} todayKey
 * @param {{learning:number, active:number}} today today's learning (content + legacy) and
 *        actual watch seconds, including unsaved live time
 * @param {object|null} live response from the active tab's tracker (or null)
 */
export function renderDashboard(state, todayKey, today, live) {
  const todaySeconds = today.learning;
  const history = { ...state.dailyHistory };
  const rec = history[todayKey];
  const goalSeconds = Number(rec?.goalSeconds) || state.settings.dailyGoalMinutes * 60;
  // Reflect unsaved live seconds in the derived numbers too.
  const liveRec = {
    ...(rec || { goalSeconds, completed: false }),
    contentSeconds: Math.max(0, todaySeconds - legacySecondsOf(rec)),
    actualActiveSeconds: today.active,
  };
  if (todaySeconds >= goalSeconds) liveRec.completed = true;
  history[todayKey] = liveRec;

  const streaks = computeStreaks(history, todayKey, state.meta.longestStreak);
  const stats = computeStats(history, todayKey);

  // ---- Hero
  const hero = $('hero');
  hero.dataset.flame = streaks.todayCompleted ? 'lit' : streaks.current > 0 ? 'alive' : 'off';
  $('streakNum').textContent = String(streaks.current);
  const sub = $('streakSub');
  const leftMin = Math.max(0, Math.ceil((goalSeconds - todaySeconds) / 60));
  sub.replaceChildren();
  if (streaks.todayCompleted) {
    sub.append('Today\'s goal done — streak secured ', el('b', { text: '✓' }));
  } else if (streaks.atRisk) {
    sub.append(el('b', { text: `${leftMin} min` }), ` left today to reach ${pluralize(streaks.nextIfCompletedToday, 'day')}`);
  } else if (streaks.current === 0 && stats.allTime === 0) {
    sub.append('Watch a lecture to light your first flame');
  } else {
    sub.append(el('b', { text: `${leftMin} min` }), ' today starts a new streak');
  }

  const week = $('weekStrip');
  week.replaceChildren(...currentWeekDays(history, todayKey).map((d, i) => {
    const cls = ['wd-dot', d.completed && 'done', !d.completed && d.seconds > 0 && 'part', d.isToday && 'today', d.isFuture && 'future'].filter(Boolean).join(' ');
    return el('div', { class: 'wd', title: `${d.key}: ${formatDuration(d.seconds)}` },
      el('span', { class: cls, text: d.completed ? '✓' : '' }),
      el('span', { class: 'wd-l', text: WEEK_LETTERS[i] }));
  }));

  // ---- Progress
  const pct = Math.min(100, Math.floor((todaySeconds / goalSeconds) * 100));
  $('pct').textContent = `${pct}%`;
  $('barFill').style.width = `${pct}%`;
  const bar = $('bar');
  bar.setAttribute('aria-valuenow', String(pct));
  bar.classList.toggle('complete', streaks.todayCompleted);
  bar.classList.toggle('tracking', !!live?.counting);
  $('todayMin').textContent = formatMinSec(todaySeconds);
  $('goalMin').textContent = `${wholeMinutes(goalSeconds)}m`;
  $('activeToday').textContent = formatMinSec(today.active);
  const chip = $('speedChip');
  const rate = live?.counting || live?.hasVideo ? Number(live.playbackRate) : NaN;
  chip.hidden = !(rate > 0 && Math.abs(rate - 1) > 0.001);
  if (!chip.hidden) chip.textContent = `${formatRate(rate)} speed`;
  const remaining = $('remaining');
  remaining.classList.toggle('done', streaks.todayCompleted);
  remaining.textContent = streaks.todayCompleted
    ? '🎉 Goal complete'
    : `${leftMin} min to go`;

  // ---- Course
  const liveCourse = live?.onLearnPage && live.course;
  const lastCourse = state.meta.currentCourse;
  $('courseLabel').textContent = liveCourse ? 'Current course' : lastCourse ? 'Last course' : 'Current course';
  $('courseTitle').textContent = (liveCourse || lastCourse)?.title || 'Udemy Learning';
  $('courseTitle').title = $('courseTitle').textContent;

  // ---- Stats
  $('statToday').textContent = formatDuration(stats.today);
  $('statToday').title = `Content ${formatDuration(stats.today)} · actual watch time ${formatDuration(stats.todayActive)}`;
  $('statWeek').textContent = formatDurationCompact(stats.week);
  $('statWeek').title = `Content ${formatDuration(stats.week)} · actual watch time ${formatDuration(stats.weekActive)}`;
  $('statBest').textContent = pluralize(streaks.longest, 'day');
  $('statTotal').textContent = formatDurationCompact(stats.allTime);
  $('statTotal').title = `Learning ${formatDuration(stats.allTime)} · actual watch time ${formatDuration(stats.allTimeActive)}`;

  return { streaks, goalSeconds };
}
