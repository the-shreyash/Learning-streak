/** Non-intrusive notifications: at most one goal-complete and one reminder per day. */
import { computeStreaks } from '../core/streakEngine.js';
import { pluralize, wholeMinutes } from '../core/format.js';
import { learningSecondsOf } from '../core/records.js';

const ICON = 'icons/icon128.png';

function show(id, title, message) {
  return new Promise((resolve) => {
    try {
      chrome.notifications.create(id, { type: 'basic', iconUrl: ICON, title, message, priority: 0, silent: false }, () => {
        void chrome.runtime.lastError; // ignore (e.g. notifications blocked at OS level)
        resolve();
      });
    } catch { resolve(); }
  });
}

export async function notifyGoalComplete(state, dayKey) {
  if (!state.settings.notificationsEnabled) return;
  const { current } = computeStreaks(state.dailyHistory, dayKey, state.meta.longestStreak);
  const goalMin = wholeMinutes(state.dailyHistory[dayKey]?.goalSeconds);
  await show(`goal-${dayKey}`, '🎉 Daily goal complete!', `${goalMin} minutes of lecture content done. 🔥 ${pluralize(current, 'day')} streak — keep going!`);
}

export async function notifyReminder(state, todayKey) {
  const rec = state.dailyHistory[todayKey];
  const goal = Number(rec?.goalSeconds) || state.settings.dailyGoalMinutes * 60;
  const left = Math.max(1, Math.ceil((goal - learningSecondsOf(rec)) / 60));
  const { current, atRisk } = computeStreaks(state.dailyHistory, todayKey, state.meta.longestStreak);
  const title = atRisk ? `🔥 Keep your ${pluralize(current, 'day')} streak alive` : '📚 Time to learn';
  await show(`reminder-${todayKey}`, title, `${left} more ${left === 1 ? 'minute' : 'minutes'} of lecture content today to reach your goal.`);
}
