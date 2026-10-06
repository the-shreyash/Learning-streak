/**
 * Statistics engine — aggregates over dailyHistory and course totals.
 * Weeks start on Monday (matching the calendar view).
 */

import {
  addDays, startOfWeek, startOfMonth, parseDayKey, daysInMonth, makeDayKey,
  weekdayMondayFirst, isValidDayKey,
} from './dateUtils.js';
import { isDayCompleted } from './streakEngine.js';
import { learningSecondsOf, activeSecondsOf, contentSecondsOf, legacySecondsOf, courseLearningSecondsOf } from './records.js';

/** Learning seconds (content + V1 legacy) — the primary metric. */
const secondsOf = learningSecondsOf;

function sumRange(history, fromKey, toKey, of = secondsOf) {
  let total = 0;
  for (const [key, rec] of Object.entries(history || {})) {
    if (key >= fromKey && key <= toKey) total += of(rec);
  }
  return total;
}

export function computeStats(history = {}, todayKey) {
  let allTime = 0;
  let allTimeActive = 0;
  let allTimeContent = 0;
  let allTimeLegacy = 0;
  let daysLearned = 0;
  let daysCompleted = 0;
  for (const [key, rec] of Object.entries(history)) {
    if (!isValidDayKey(key)) continue;
    const s = secondsOf(rec);
    allTime += s;
    allTimeActive += activeSecondsOf(rec);
    allTimeContent += contentSecondsOf(rec);
    allTimeLegacy += legacySecondsOf(rec);
    if (s > 0) daysLearned += 1;
    if (isDayCompleted(rec)) daysCompleted += 1;
  }
  return {
    // Learning (content consumed + V1 legacy time) — primary
    today: secondsOf(history[todayKey]),
    week: sumRange(history, startOfWeek(todayKey), todayKey),
    month: sumRange(history, startOfMonth(todayKey), todayKey),
    allTime,
    // Actual active watch time — secondary
    todayActive: activeSecondsOf(history[todayKey]),
    weekActive: sumRange(history, startOfWeek(todayKey), todayKey, activeSecondsOf),
    monthActive: sumRange(history, startOfMonth(todayKey), todayKey, activeSecondsOf),
    allTimeActive,
    allTimeContent,
    allTimeLegacy,
    daysLearned,
    daysCompleted,
  };
}

/**
 * Activity level used by the calendar heatmap (relative to that day's goal):
 *   0 → nothing, 1 → under half the goal, 2 → half or more, 3 → goal achieved.
 * With a 60-minute goal: 0 min / 1–29 / 30–59 / 60+.
 */
export function activityLevel(record, fallbackGoalSeconds) {
  const s = secondsOf(record);
  if (s <= 0) return 0;
  if (isDayCompleted(record)) return 3;
  const goal = Number(record?.goalSeconds) || fallbackGoalSeconds || 3600;
  return s >= goal / 2 ? 2 : 1;
}

/** Last 7 days ending today (Mon–Sun of the current week), for the hero strip. */
export function currentWeekDays(history, todayKey) {
  const monday = startOfWeek(todayKey);
  return Array.from({ length: 7 }, (_, i) => {
    const key = addDays(monday, i);
    return {
      key,
      completed: isDayCompleted(history[key]),
      seconds: secondsOf(history[key]),
      isToday: key === todayKey,
      isFuture: key > todayKey,
    };
  });
}

/**
 * Month grid for the calendar (Monday-first). Returns an array of weeks, each an
 * array of 7 cells (null for padding cells outside the month).
 */
export function buildMonthGrid(history, year, month, todayKey, goalSeconds) {
  const firstKey = makeDayKey(year, month, 1);
  const lead = weekdayMondayFirst(firstKey);
  const total = daysInMonth(year, month);
  const cells = Array.from({ length: lead }, () => null);
  let monthSeconds = 0;
  let monthCompleted = 0;
  for (let d = 1; d <= total; d += 1) {
    const key = makeDayKey(year, month, d);
    const rec = history[key];
    const seconds = secondsOf(rec);
    const completed = isDayCompleted(rec);
    monthSeconds += seconds;
    if (completed) monthCompleted += 1;
    cells.push({
      key,
      day: d,
      seconds,
      activeSeconds: activeSecondsOf(rec),
      legacySeconds: legacySecondsOf(rec),
      completed,
      goalSeconds: Number(rec?.goalSeconds) || goalSeconds,
      level: activityLevel(rec, goalSeconds),
      isToday: key === todayKey,
      isFuture: key > todayKey,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { weeks, monthSeconds, monthCompleted, daysInMonth: total };
}

/** Courses sorted by total time, descending. */
export function rankCourses(courses = {}) {
  return Object.entries(courses)
    .map(([key, c]) => ({ key, title: c?.title || 'Udemy Learning', totalSeconds: courseLearningSecondsOf(c) + (Number(c?.totalSeconds) || 0), activeSeconds: activeSecondsOf(c) + (Number(c?.totalSeconds) || 0), lastWatchedAt: c?.lastWatchedAt || 0 }))
    .filter((c) => c.totalSeconds > 0)
    .sort((a, b) => b.totalSeconds - a.totalSeconds);
}

/** Earliest month that has any history (for limiting calendar navigation). */
export function earliestMonth(history = {}) {
  const keys = Object.keys(history).filter(isValidDayKey).sort();
  if (!keys.length) return null;
  const { year, month } = parseDayKey(keys[0]);
  return { year, month };
}
