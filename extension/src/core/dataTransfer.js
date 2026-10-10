/**
 * Export / import of all streak data as JSON, with strict validation.
 */

import { APP_ID, SCHEMA_VERSION } from '../config/config.js';
import { isValidDayKey } from './dateUtils.js';
import { computeStreaks, isDayCompleted } from './streakEngine.js';
import { computeStats } from './statisticsEngine.js';
import { normalizeSettings, clampGoalMinutes, goalSecondsOf, createDefaultState } from './schema.js';
import { sanitizeCourse } from './timerEngine.js';
import { learningSecondsOf, normalizeDayRecord, normalizeCourse, courseLearningSecondsOf } from './records.js';
import { normalizePlatformTotals } from './dailyAggregation.js';
import { normalizeSessions } from './learningSession.js';
import { isKnownPlatform } from '../platforms/registry.js';
import { MAX_SESSIONS } from './learningEngine.js';
import { normalizeLibrary, mergeLibraries } from './learningLibrary.js';
import { pruneMembership } from './playlistMembership.js';

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_DAYS = 20_000; // ~55 years
const MAX_COURSES = 2_000;
const SECONDS_PER_DAY = 86_400;
/** Content can exceed 24 h in a day at >1x speed; this bound is just a sanity limit. */
const MAX_CONTENT_PER_DAY = SECONDS_PER_DAY * 4;

export function buildExport(state, todayKey, nowMs = Date.now()) {
  const streaks = computeStreaks(state.dailyHistory, todayKey, state.meta?.longestStreak);
  const stats = computeStats(state.dailyHistory, todayKey);
  return {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    dailyGoalMinutes: state.settings.dailyGoalMinutes,
    currentStreak: streaks.current,
    longestStreak: streaks.longest,
    // V1.1: learning = content consumed (+ V1 legacy time); actual = real watch time
    totalLearningSeconds: Math.round(stats.allTime),
    totalContentSeconds: Math.round(stats.allTimeContent),
    totalActualActiveSeconds: Math.round(stats.allTimeActive),
    totalLegacySeconds: Math.round(stats.allTimeLegacy),
    settings: { ...state.settings },
    dailyHistory: state.dailyHistory,
    courses: state.courses,
    // V2.1 (optional; ignored by V1.2.1 importers)
    sessions: state.sessions || {},
    library: state.library || {},
  };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate parsed JSON (or a JSON string). Returns
 *   { ok: true, data: { settings, dailyHistory, courses, longestStreak }, summary, warnings }
 * or { ok: false, errors }.
 */
export function validateImport(input) {
  const errors = [];
  const warnings = [];
  let obj = input;

  if (typeof input === 'string') {
    if (input.length > MAX_IMPORT_BYTES) return { ok: false, errors: ['File is too large (max 5 MB).'] };
    try { obj = JSON.parse(input); } catch { return { ok: false, errors: ['File is not valid JSON.'] }; }
  }
  if (!isPlainObject(obj)) return { ok: false, errors: ['Top-level value must be a JSON object.'] };
  if (obj.app !== undefined && obj.app !== APP_ID) errors.push(`This file belongs to a different app ("${String(obj.app).slice(0, 40)}").`);
  if (obj.schemaVersion !== undefined && (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion > SCHEMA_VERSION)) {
    errors.push(`Unsupported schemaVersion ${JSON.stringify(obj.schemaVersion)}; this extension supports up to ${SCHEMA_VERSION}.`);
  }
  if (!isPlainObject(obj.dailyHistory)) errors.push('Missing or invalid "dailyHistory" object.');

  // Goal: prefer settings.dailyGoalMinutes, then top-level dailyGoalMinutes.
  const rawGoal = obj.settings?.dailyGoalMinutes ?? obj.dailyGoalMinutes;
  if (rawGoal !== undefined && (!isNum(rawGoal) || rawGoal < 1 || rawGoal > 720)) {
    errors.push('"dailyGoalMinutes" must be a number between 1 and 720.');
  }
  if (obj.settings !== undefined && !isPlainObject(obj.settings)) errors.push('"settings" must be an object.');
  if (obj.courses !== undefined && !isPlainObject(obj.courses)) errors.push('"courses" must be an object.');
  if (obj.sessions !== undefined && !isPlainObject(obj.sessions)) errors.push('"sessions" must be an object.');
  if (obj.library !== undefined && !isPlainObject(obj.library)) errors.push('"library" must be an object.');
  if (obj.longestStreak !== undefined && (!Number.isInteger(obj.longestStreak) || obj.longestStreak < 0)) {
    errors.push('"longestStreak" must be a non-negative integer.');
  }
  if (errors.length) return { ok: false, errors };

  const settings = normalizeSettings({ ...(obj.settings || {}), dailyGoalMinutes: rawGoal ?? obj.settings?.dailyGoalMinutes });
  const fallbackGoalSeconds = goalSecondsOf(settings);

  const entries = Object.entries(obj.dailyHistory);
  if (entries.length > MAX_DAYS) return { ok: false, errors: [`Too many days in history (${entries.length}).`] };

  const dailyHistory = {};
  for (const [key, rec] of entries) {
    if (!isValidDayKey(key)) { errors.push(`Invalid date key "${String(key).slice(0, 20)}".`); continue; }
    if (!isPlainObject(rec)) { errors.push(`${key}: record must be an object.`); continue; }
    // Accept V1 records ({watchedSeconds}) and V1.1 records ({contentSeconds, actualActiveSeconds, legacySeconds}).
    const fields = [
      ['watchedSeconds', SECONDS_PER_DAY], ['actualActiveSeconds', SECONDS_PER_DAY],
      ['legacySeconds', SECONDS_PER_DAY], ['contentSeconds', MAX_CONTENT_PER_DAY],
    ];
    const present = fields.filter(([f]) => rec[f] !== undefined);
    if (!present.length) { errors.push(`${key}: record has no time fields (watchedSeconds or contentSeconds).`); continue; }
    const badField = present.find(([f, max]) => !isNum(rec[f]) || rec[f] < 0 || rec[f] > max);
    if (badField) { errors.push(`${key}: ${badField[0]} must be between 0 and ${badField[1]}.`); continue; }
    let goal = rec.goalSeconds;
    if (goal === undefined) goal = fallbackGoalSeconds;
    if (!isNum(goal) || goal < 60 || goal > 720 * 60) { errors.push(`${key}: goalSeconds must be between 60 and 43200.`); continue; }
    if (rec.completed !== undefined && typeof rec.completed !== 'boolean') { errors.push(`${key}: completed must be true/false.`); continue; }
    const picked = { goalSeconds: goal, completed: rec.completed === true };
    for (const [f] of present) picked[f] = rec[f];
    const clean = normalizeDayRecord(picked, fallbackGoalSeconds);
    const platforms = normalizePlatformTotals(rec.platforms);
    if (platforms) clean.platforms = platforms;
    if (isNum(rec.completedAt)) clean.completedAt = rec.completedAt;
    if (rec.celebrationShown === true || clean.completed) clean.celebrationShown = true; // never re-celebrate imported days
    dailyHistory[key] = clean;
  }
  if (errors.length) {
    const shown = errors.slice(0, 8);
    if (errors.length > 8) shown.push(`…and ${errors.length - 8} more problems.`);
    return { ok: false, errors: shown };
  }

  const courses = {};
  const courseEntries = Object.entries(obj.courses || {});
  if (courseEntries.length > MAX_COURSES) warnings.push('Too many courses; extra entries ignored.');
  for (const [key, c] of courseEntries.slice(0, MAX_COURSES)) {
    if (!isPlainObject(c)) continue;
    const clean = sanitizeCourse({ key, title: c.title });
    const nums = ['totalSeconds', 'contentSeconds', 'actualActiveSeconds', 'legacySeconds'].filter((f) => c[f] !== undefined);
    const valid = nums.length > 0 && nums.every((f) => isNum(c[f]) && c[f] >= 0);
    if (!clean || !valid) { warnings.push(`Skipped invalid course "${String(key).slice(0, 40)}".`); continue; }
    const picked = { title: clean.title, lastWatchedAt: isNum(c.lastWatchedAt) ? c.lastWatchedAt : 0 };
    for (const f of nums) picked[f] = c[f];
    if (isKnownPlatform(c.platform)) picked.platform = c.platform;
    courses[clean.key] = normalizeCourse(picked);
  }

  const { sessions, dropped } = normalizeSessions(obj.sessions);
  if (dropped) warnings.push(`Skipped ${dropped} invalid learning session(s).`);
  if (Object.keys(sessions).length > MAX_SESSIONS) warnings.push('Too many learning sessions; only the most recent are kept.');
  const { library, dropped: droppedItems } = normalizeLibrary(obj.library);
  if (droppedItems) warnings.push(`Skipped ${droppedItems} invalid Learning Library item(s).`);

  const days = Object.keys(dailyHistory).sort();
  const summary = {
    days: days.length,
    completedDays: days.filter((k) => isDayCompleted(dailyHistory[k])).length,
    firstDay: days[0] || null,
    lastDay: days[days.length - 1] || null,
    totalSeconds: days.reduce((a, k) => a + learningSecondsOf(dailyHistory[k]), 0),
    legacyDays: days.filter((k) => dailyHistory[k].legacySeconds > 0).length,
    courses: Object.keys(courses).length,
    sessions: Object.keys(sessions).length,
    libraryItems: Object.keys(library).length,
  };
  return {
    ok: true,
    warnings,
    summary,
    data: { settings, dailyHistory, courses, sessions: keepRecentSessions(sessions), library: obj.library !== undefined ? library : null, longestStreak: Number.isInteger(obj.longestStreak) ? obj.longestStreak : 0 },
  };
}

function keepRecentSessions(sessions) {
  const ids = Object.keys(sessions);
  if (ids.length <= MAX_SESSIONS) return sessions;
  const kept = {};
  for (const id of ids.sort((a, b) => sessions[b].endedAt - sessions[a].endedAt).slice(0, MAX_SESSIONS)) kept[id] = sessions[id];
  return kept;
}

/**
 * Combine validated import data with current state.
 *  - "replace": imported data becomes the new state (settings included).
 *  - "merge":   per day keep the record with more learning time; courses likewise.
 */
export function applyImport(currentState, data, mode = 'merge', todayKey, nowMs = Date.now()) {
  let next;
  if (mode === 'replace') {
    const fresh = createDefaultState(nowMs);
    next = {
      ...fresh,
      settings: { ...data.settings },
      dailyHistory: { ...data.dailyHistory },
      courses: { ...data.courses },
      sessions: { ...(data.sessions || {}) },
      // A file without a library (V1.2.1, or V2.1 before Phase B) leaves the current library alone.
      library: data.library ? { ...data.library } : { ...(currentState.library || {}) },
      meta: { ...fresh.meta, installedAt: currentState.meta?.installedAt || nowMs, longestStreak: data.longestStreak || 0 },
    };
  } else {
    const dailyHistory = { ...currentState.dailyHistory };
    for (const [key, rec] of Object.entries(data.dailyHistory)) {
      const cur = dailyHistory[key];
      if (!cur || learningSecondsOf(rec) > learningSecondsOf(cur)) {
        dailyHistory[key] = { ...rec, completed: rec.completed || isDayCompleted(cur), celebrationShown: true };
      } else if (rec.completed && !cur.completed) {
        dailyHistory[key] = { ...cur, completed: true, celebrationShown: true };
      }
    }
    const courses = { ...currentState.courses };
    for (const [key, c] of Object.entries(data.courses)) {
      if (!courses[key] || courseLearningSecondsOf(c) > courseLearningSecondsOf(courses[key])) courses[key] = { ...c };
    }
    // Sessions merge by id: re-importing the same file never duplicates a session.
    const sessions = keepRecentSessions({ ...(data.sessions || {}), ...(currentState.sessions || {}) });
    next = {
      ...currentState,
      dailyHistory,
      courses,
      sessions,
      library: mergeLibraries(currentState.library, data.library),
      meta: { ...currentState.meta, longestStreak: Math.max(Number(currentState.meta?.longestStreak) || 0, data.longestStreak || 0) },
    };
  }
  // Proven playlist membership is never exported or imported (it is re-proven by
  // watching); this device's index is kept for the playlists still registered.
  next.playlistMembership = pruneMembership(currentState.playlistMembership, next.library);
  next.settings.dailyGoalMinutes = clampGoalMinutes(next.settings.dailyGoalMinutes);
  next.meta.longestStreak = computeStreaks(next.dailyHistory, todayKey, next.meta.longestStreak).longest;
  return next;
}
