/**
 * Day / course record helpers (schema v2, LearnStreak V1.1).
 *
 * Day record:
 *   {
 *     contentSeconds,       // lecture content consumed while actively watching (PRIMARY)
 *     actualActiveSeconds,  // real time spent actively watching (secondary)
 *     legacySeconds?,       // V1 history: time recorded before V1.1 (real watch time;
 *                           //   playback speed was never recorded, so it is NOT converted)
 *     goalSeconds, completed, completedAt?, celebrationShown?
 *   }
 *
 * "Learning seconds" — what the daily goal, streak, calendar and stats use — is
 * contentSeconds + legacySeconds. Legacy time stays exactly what V1 measured;
 * nothing is invented for days recorded before playback speed was tracked.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const contentSecondsOf = (rec) => num(rec?.contentSeconds);
// A raw (not yet migrated) v1 record still carries `watchedSeconds`; treat it as legacy.
export const activeSecondsOf = (rec) => num(rec?.actualActiveSeconds) + num(rec?.watchedSeconds);
export const legacySecondsOf = (rec) => num(rec?.legacySeconds) + num(rec?.watchedSeconds);
/** Seconds counted toward the daily goal. */
export const learningSecondsOf = (rec) => contentSecondsOf(rec) + legacySecondsOf(rec);
export const hasLegacy = (rec) => legacySecondsOf(rec) > 0;

/**
 * Normalize any day record (v1 or v2) into the v2 shape.
 * v1 `watchedSeconds` (real watch time) → legacySeconds + actualActiveSeconds.
 */
export function normalizeDayRecord(rec, fallbackGoalSeconds) {
  const out = { ...rec };
  if (rec && rec.watchedSeconds !== undefined) {
    out.legacySeconds = legacySecondsOf(rec);      // includes watchedSeconds
    out.actualActiveSeconds = activeSecondsOf(rec);
    delete out.watchedSeconds;
  }
  out.contentSeconds = contentSecondsOf(out);
  out.actualActiveSeconds = activeSecondsOf(out);
  if (legacySecondsOf(out) > 0) out.legacySeconds = legacySecondsOf(out); else delete out.legacySeconds;
  out.goalSeconds = num(out.goalSeconds) || fallbackGoalSeconds;
  out.completed = out.completed === true || learningSecondsOf(out) >= out.goalSeconds;
  return out;
}

/** Course totals: v1 `totalSeconds` (real time) → legacySeconds + actualActiveSeconds. */
export function normalizeCourse(c) {
  const out = { title: c?.title || 'Udemy Learning', contentSeconds: contentSecondsOf(c), actualActiveSeconds: activeSecondsOf(c), lastWatchedAt: Number(c?.lastWatchedAt) || 0 };
  let legacy = legacySecondsOf(c);
  if (c && c.totalSeconds !== undefined) {
    legacy += num(c.totalSeconds);
    out.actualActiveSeconds += num(c.totalSeconds);
  }
  if (legacy > 0) out.legacySeconds = legacy;
  // V2: non-Udemy course totals record their platform. V1 records have none (= Udemy).
  if (typeof c?.platform === 'string' && c.platform) out.platform = c.platform;
  return out;
}

export const courseLearningSecondsOf = (c) => contentSecondsOf(c) + legacySecondsOf(c);
