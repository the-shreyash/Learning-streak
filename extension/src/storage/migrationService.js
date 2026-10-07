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
import { normalizeSessions } from '../core/learningSession.js';
import { normalizePlatformTotals } from '../core/dailyAggregation.js';
import { normalizeLibrary } from '../core/learningLibrary.js';

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

// V2.1 Learning Engine data is additive and does NOT bump SCHEMA_VERSION (the
// format stays readable by V1.2.1). It is normalized on every migrate() call,
// which is idempotent: a missing `sessions` map is created empty — no sessions,
// platforms or subjects are invented for V1 history — and malformed V2 entries
// are dropped. The same holds for the Learning Library (`library`, created empty:
// no YouTube content is ever registered on the user's behalf).

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
    if (rec.platforms !== undefined) {
      const platforms = normalizePlatformTotals(rec.platforms);
      if (platforms) norm.platforms = platforms; else delete norm.platforms;
      if (JSON.stringify(platforms ?? undefined) !== JSON.stringify(rec.platforms)) changed = true;
    }
    dailyHistory[key] = norm;
  }
  const courses = {};
  for (const [key, c] of Object.entries(isObj(state.courses) ? state.courses : {})) {
    if (!isObj(c)) { changed = true; continue; }
    if (c.totalSeconds !== undefined) changed = true;
    courses[key] = normalizeCourse(c);
  }
  if (!isObj(state.sessions)) changed = true;
  const { sessions, dropped } = normalizeSessions(state.sessions);
  if (dropped) changed = true;
  if (!isObj(state.library)) changed = true;
  const { library, dropped: droppedItems } = normalizeLibrary(state.library);
  if (droppedItems || (isObj(state.library) && JSON.stringify(library) !== JSON.stringify(state.library))) changed = true;

  return {
    changed,
    state: {
      ...state,
      schemaVersion: SCHEMA_VERSION,
      settings,
      dailyHistory,
      courses,
      sessions,
      library,
      meta: { ...defaults.meta, ...(isObj(state.meta) ? state.meta : {}) },
      debug: { ...defaults.debug, ...(isObj(state.debug) ? state.debug : {}) },
    },
  };
}
