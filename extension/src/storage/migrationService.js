/**
 * Schema migrations. `migrate(raw)` always returns a complete, valid state object
 * for the current SCHEMA_VERSION, filling defaults for anything missing. Never
 * drops history: unknown future fields are preserved untouched.
 *
 * To add a migration: bump SCHEMA_VERSION in config.js and add an entry to
 * MIGRATIONS keyed by the version it upgrades FROM.
 */

import { SCHEMA_VERSION } from '../config/config.js';
import { createDefaultState, normalizeSettings, goalSecondsOf } from '../core/schema.js';
import { isValidDayKey } from '../core/dateUtils.js';
import { normalizeDayRecord, normalizeCourse } from '../core/records.js';

const MIGRATIONS = {
  // 0 → 1: pre-release / empty storage. Nothing to transform beyond defaults.
  0: (s) => s,
  // 1 → 2 (V1.1): day records gain contentSeconds / actualActiveSeconds.
  //   V1 `watchedSeconds` was REAL watch time; playback speed was never recorded,
  //   so it cannot be converted to content. It is preserved as `legacySeconds`
  //   (still counts toward that day's goal, so past streaks are unchanged) and
  //   as `actualActiveSeconds`. Course `totalSeconds` is treated the same way.
  //   The per-record conversion is done by normalizeDayRecord / normalizeCourse
  //   below (idempotent), so nothing extra is needed here.
  1: (s) => s,
};

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

export function migrate(raw, nowMs = Date.now()) {
  const defaults = createDefaultState(nowMs);
  if (!isObj(raw) || Object.keys(raw).length === 0) return { state: defaults, changed: true };

  let state = { ...raw };
  let version = Number.isInteger(state.schemaVersion) ? state.schemaVersion : 0;
  let changed = version !== SCHEMA_VERSION;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (step) state = step(state);
    version += 1;
  }

  const settings = normalizeSettings(state.settings);
  const fallbackGoal = goalSecondsOf(settings);
  const dailyHistory = {};
  for (const [key, rec] of Object.entries(isObj(state.dailyHistory) ? state.dailyHistory : {})) {
    if (!isValidDayKey(key) || !isObj(rec)) { changed = true; continue; }
    const norm = normalizeDayRecord(rec, fallbackGoal);
    if (rec.watchedSeconds !== undefined) changed = true;
    dailyHistory[key] = norm;
  }
  const courses = {};
  for (const [key, c] of Object.entries(isObj(state.courses) ? state.courses : {})) {
    if (!isObj(c)) { changed = true; continue; }
    if (c.totalSeconds !== undefined) changed = true;
    courses[key] = normalizeCourse(c);
  }

  return {
    changed,
    state: {
      ...state,
      schemaVersion: SCHEMA_VERSION,
      settings,
      dailyHistory,
      courses,
      meta: { ...defaults.meta, ...(isObj(state.meta) ? state.meta : {}) },
      debug: { ...defaults.debug, ...(isObj(state.debug) ? state.debug : {}) },
    },
  };
}
