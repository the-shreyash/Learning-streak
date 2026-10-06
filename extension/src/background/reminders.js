/** Daily reminder + midnight refresh, using chrome.alarms (survives worker restarts). */
import { nextLocalMidnight } from '../core/dateUtils.js';
import { isDayCompleted } from '../core/streakEngine.js';
import { todayKeyFor, nowFor } from '../core/clock.js';
import { notifyReminder } from './notifications.js';

export const REMINDER_ALARM = 'daily-reminder';
export const MIDNIGHT_ALARM = 'midnight-refresh';

/** Next timestamp (local time) at HH:MM strictly in the future. */
export function nextOccurrence(hhmm, fromMs = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(fromMs);
  let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  if (t <= fromMs + 1000) t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, h, m, 0, 0).getTime();
  return t;
}

export async function syncReminderAlarm(state) {
  const { reminderEnabled, notificationsEnabled, reminderTime } = state.settings;
  await chrome.alarms.clear(REMINDER_ALARM);
  if (reminderEnabled && notificationsEnabled) {
    // One-shot alarm, re-armed after each firing — stays correct across DST changes.
    await chrome.alarms.create(REMINDER_ALARM, { when: nextOccurrence(reminderTime) });
  }
}

export async function scheduleMidnight() {
  await chrome.alarms.create(MIDNIGHT_ALARM, { when: nextLocalMidnight(Date.now()) + 2000 });
}

export async function handleReminder(state) {
  const todayKey = todayKeyFor(state);
  const { reminderEnabled, notificationsEnabled } = state.settings;
  // Skip if the alarm fired very late (e.g. computer was asleep for hours at that time).
  const [h, m] = state.settings.reminderTime.split(':').map(Number);
  const now = new Date(nowFor(state));
  const minutesLate = (now.getHours() * 60 + now.getMinutes()) - (h * 60 + m);
  const fresh = minutesLate >= 0 && minutesLate <= 120;
  if (reminderEnabled && notificationsEnabled && fresh && !isDayCompleted(state.dailyHistory[todayKey])) {
    await notifyReminder(state, todayKey);
  }
  await syncReminderAlarm(state);
}
