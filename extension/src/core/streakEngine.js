/**
 * Streak engine — pure functions over `dailyHistory`.
 *
 * dailyHistory: { [dayKey]: { contentSeconds, actualActiveSeconds, legacySeconds?, goalSeconds, completed, ... } }
 *
 * Rules
 *  - A day is "completed" once its learning seconds (lecture content consumed,
 *    plus any V1 legacy time) >= goalSeconds. Completion is
 *    sticky for that day (continuing to watch, or raising the goal later that
 *    day, never un-completes it).
 *  - Current streak = consecutive completed calendar days ending TODAY, or ending
 *    YESTERDAY if today is not completed yet (the streak is still alive until
 *    today ends, like LeetCode/Duolingo).
 *  - If yesterday was not completed and today isn't either, current streak = 0.
 *    Completing today then starts a new streak of 1.
 *  - Closing the browser never affects anything: streaks are derived from dates.
 */

import { addDays, diffDays, isValidDayKey } from './dateUtils.js';
import { learningSecondsOf } from './records.js';

export function isDayCompleted(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.completed === true) return true;
  const goal = Number(record.goalSeconds) || 0;
  return goal > 0 && learningSecondsOf(record) >= goal;
}

/** Length of the run of completed days ending at `endKey` (inclusive). */
export function runEndingAt(history, endKey) {
  let count = 0;
  let cursor = endKey;
  // Bounded by the number of records, so it can never loop forever.
  const max = Object.keys(history || {}).length;
  while (count <= max && isDayCompleted(history[cursor])) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

/** Longest run of consecutive completed days anywhere in history. */
export function longestRun(history) {
  const keys = Object.keys(history || {})
    .filter((k) => isValidDayKey(k) && isDayCompleted(history[k]))
    .sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const key of keys) {
    run = prev !== null && diffDays(prev, key) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = key;
  }
  return best;
}

/**
 * @param {object} history dailyHistory map
 * @param {string} todayKey local day key for "now"
 * @param {number} storedLongest persisted best streak (never decreases)
 */
export function computeStreaks(history = {}, todayKey, storedLongest = 0) {
  const todayCompleted = isDayCompleted(history[todayKey]);
  const yesterdayKey = addDays(todayKey, -1);
  const yesterdayCompleted = isDayCompleted(history[yesterdayKey]);

  const current = todayCompleted
    ? runEndingAt(history, todayKey)
    : runEndingAt(history, yesterdayKey);

  const longest = Math.max(longestRun(history), Number(storedLongest) || 0, current);

  return {
    current,
    longest,
    todayCompleted,
    /** Streak is alive but will break if today isn't completed. */
    atRisk: !todayCompleted && yesterdayCompleted,
    /** What the streak becomes once today's goal is reached. */
    nextIfCompletedToday: todayCompleted ? current : current + 1,
  };
}
