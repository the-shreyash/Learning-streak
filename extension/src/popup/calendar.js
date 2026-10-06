/** Contribution-style month calendar + per-course breakdown. */
import { buildMonthGrid, rankCourses, earliestMonth } from '../core/statisticsEngine.js';
import { MONTH_NAMES, parseDayKey, shiftMonth, formatDayKey } from '../core/dateUtils.js';
import { formatDuration, wholeMinutes } from '../core/format.js';
import { legacySecondsOf } from '../core/records.js';
import { el } from '../shared/stateClient.js';

const $ = (id) => document.getElementById(id);
const monthIndex = (m) => m.year * 12 + m.month;

export function createCalendar({ getState, getTodayKey, getTodayLive }) {
  let shown = null; // { year, month }

  function bounds() {
    const today = parseDayKey(getTodayKey());
    const max = { year: today.year, month: today.month };
    const earliest = earliestMonth(getState().dailyHistory) || max;
    // Allow browsing a year back even with no data, so the grid never feels empty.
    const yearBack = shiftMonth(max, -11);
    const min = monthIndex(earliest) < monthIndex(yearBack) ? earliest : yearBack;
    return { min, max };
  }

  function cellTitle(c) {
    let t = `${formatDayKey(c.key, { withYear: true })} · ${formatDuration(c.seconds)} / ${wholeMinutes(c.goalSeconds)}m${c.completed ? ' ✓' : ''}`;
    if (c.seconds > 0) t += ` · watched ${formatDuration(c.activeSeconds)}`;
    if (c.legacySeconds > 0) t += ' · V1 record (watch time, speed not tracked)';
    return t;
  }

  function render() {
    const state = getState();
    const todayKey = getTodayKey();
    if (!shown) { const t = parseDayKey(todayKey); shown = { year: t.year, month: t.month }; }
    const { min, max } = bounds();

    const history = { ...state.dailyHistory };
    const live = getTodayLive();
    if (live.learning > 0) {
      const rec = history[todayKey] || { goalSeconds: state.settings.dailyGoalMinutes * 60, completed: false };
      history[todayKey] = {
        ...rec,
        contentSeconds: Math.max(0, live.learning - legacySecondsOf(rec)),
        actualActiveSeconds: live.active,
        completed: rec.completed || live.learning >= rec.goalSeconds,
      };
    }

    const goalSeconds = state.settings.dailyGoalMinutes * 60;
    const grid = buildMonthGrid(history, shown.year, shown.month, todayKey, goalSeconds);
    $('monthTitle').textContent = `${MONTH_NAMES[shown.month - 1]} ${shown.year}`;
    $('calPrev').disabled = monthIndex(shown) <= monthIndex(min);
    $('calNext').disabled = monthIndex(shown) >= monthIndex(max);
    $('calDays').textContent = `${grid.monthCompleted}`;
    $('calTime').textContent = formatDuration(grid.monthSeconds);
    const activeDays = grid.weeks.flat().filter((c) => c && c.seconds > 0).length;
    $('calMonthTotal').textContent = String(activeDays);

    const hover = $('calHover');
    hover.textContent = '';
    $('calGrid').replaceChildren(...grid.weeks.flat().map((c) => {
      if (!c) return el('div', { class: 'cell empty', 'aria-hidden': 'true' });
      const cls = ['cell', `lv${c.level}`, c.isToday && 'today', c.isFuture && 'future'].filter(Boolean).join(' ');
      const node = el('div', { class: cls, title: cellTitle(c), role: 'gridcell', 'aria-label': cellTitle(c) }, String(c.day));
      node.addEventListener('mouseenter', () => { hover.textContent = cellTitle(c); });
      node.addEventListener('mouseleave', () => { hover.textContent = ''; });
      return node;
    }));

    const courses = rankCourses(state.courses).slice(0, 6);
    const top = courses[0]?.totalSeconds || 1;
    const list = $('courseList');
    if (!courses.length) {
      list.replaceChildren(el('li', {}, el('span', { class: 'empty-note', text: 'Course totals appear after your first tracked lecture.' })));
    } else {
      list.replaceChildren(...courses.map((c) => el('li', { title: c.title },
        el('span', { class: 'cl-title', text: c.title }),
        el('span', { class: 'cl-time num', text: formatDuration(c.totalSeconds) }),
        el('span', { class: 'cl-bar' }, el('i', { style: { width: `${Math.max(4, (c.totalSeconds / top) * 100)}%` } })),
      )));
    }
  }

  function step(delta) {
    const { min, max } = bounds();
    const next = shiftMonth(shown, delta);
    if (monthIndex(next) < monthIndex(min) || monthIndex(next) > monthIndex(max)) return;
    shown = next;
    render();
  }

  function resetToToday() { shown = null; }

  return { render, step, resetToToday };
}
