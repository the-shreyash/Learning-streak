/**
 * Persisted state shape (chrome.storage.local). Only what the streak system needs.
 *
 * {
 *   settings: { dailyGoalMinutes, notificationsEnabled, reminderEnabled, reminderTime },
 *   (V1.2 removed `requireWindowFocus`: playback in a background tab/app always counts;
 *    a stored value from V1.1 is simply ignored and dropped on the next settings save)
 *   schemaVersion: 2,   // v2 = V1.1
 *   dailyHistory: { "YYYY-MM-DD": { contentSeconds, actualActiveSeconds, legacySeconds?, goalSeconds,
 *                                    completed, completedAt?, celebrationShown? } },
 *   courses: { [courseSlug]: { title, contentSeconds, actualActiveSeconds, legacySeconds?, lastWatchedAt } },
 *   (see core/records.js for field meanings)
 *   meta: { longestStreak, currentCourse, installedAt, creditedUntil, lastGoalNotifiedDay, activeSessionId },
 *
 *   V2.1 (additive — schemaVersion stays 2, so V1.2.1 can still read/import the data):
 *   dailyHistory[day].platforms?: { [platformId]: { contentSeconds, actualActiveSeconds } }
 *       per-platform attribution of the day's totals (core/dailyAggregation.js)
 *   courses[key].platform?: set for non-Udemy courses (key "youtube:<type>:<id>")
 *   sessions: { [id]: LearningSession }   (core/learningSession.js)
 *   library: { [id]: LibraryItem }        (core/learningLibrary.js) — user-registered
 *       learning content (YouTube videos). Configuration, not statistics: kept on reset.
 *   debug: { clockOffsetMs }      // only honoured when DEBUG_TOOLS is true
 * }
 */

import {
  SCHEMA_VERSION, DEFAULT_GOAL_MINUTES, MIN_GOAL_MINUTES, MAX_GOAL_MINUTES,
} from '../config/config.js';

export const DEFAULT_SETTINGS = Object.freeze({
  dailyGoalMinutes: DEFAULT_GOAL_MINUTES,
  notificationsEnabled: true,
  reminderEnabled: false,
  reminderTime: '20:00',
});

export function createDefaultState(nowMs = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    dailyHistory: {},
    courses: {},
    sessions: {},
    library: {},
    meta: {
      longestStreak: 0,
      currentCourse: null,
      installedAt: nowMs,
      creditedUntil: 0,
      lastGoalNotifiedDay: null,
      activeSessionId: null,
    },
    debug: { clockOffsetMs: 0 },
  };
}

export function clampGoalMinutes(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_GOAL_MINUTES;
  return Math.min(MAX_GOAL_MINUTES, Math.max(MIN_GOAL_MINUTES, n));
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function isValidTimeOfDay(v) {
  return typeof v === 'string' && TIME_RE.test(v);
}

/** Coerce a (possibly partial / malformed) settings object into a valid one. */
export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS };
  if (input && typeof input === 'object') {
    if (input.dailyGoalMinutes !== undefined) s.dailyGoalMinutes = clampGoalMinutes(input.dailyGoalMinutes);
    if (typeof input.notificationsEnabled === 'boolean') s.notificationsEnabled = input.notificationsEnabled;
    if (typeof input.reminderEnabled === 'boolean') s.reminderEnabled = input.reminderEnabled;
    if (isValidTimeOfDay(input.reminderTime)) s.reminderTime = input.reminderTime;
  }
  return s;
}

export const goalSecondsOf = (settings) => clampGoalMinutes(settings?.dailyGoalMinutes) * 60;
