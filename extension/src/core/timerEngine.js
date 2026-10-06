/**
 * Timer engine — turns verified credit chunks from the content script into
 * per-day records. Pure: takes a state object, returns a new state + events.
 *
 * A credit chunk (V1.1) is { endMs, active, content, course }:
 *   active  — real seconds of genuine, active viewing that ended at `endMs`
 *   content — lecture-content seconds (validated video progress) consumed during
 *             that same span. content is the PRIMARY metric for goals/streaks.
 * (A V1-style chunk { seconds } is accepted as active time with 0 content.)
 *
 * The content script only produces credit while every counting condition holds
 * and flushes every few seconds, so each chunk covers a short real-time span:
 * midnight splitting is exact to the second and crash loss is a few seconds.
 * When a chunk crosses midnight, both metrics are split in proportion to the
 * real time that fell on each calendar day.
 */

import { splitCreditByDay, toDayKey } from './dateUtils.js';
import { isDayCompleted, computeStreaks } from './streakEngine.js';
import { goalSecondsOf, clampGoalMinutes } from './schema.js';
import { learningSecondsOf, normalizeDayRecord, normalizeCourse } from './records.js';
import { MAX_CREDIT_PER_MESSAGE_SECONDS, MAX_CONTENT_PER_MESSAGE_SECONDS, MAX_PLAUSIBLE_PLAYBACK_RATE } from '../config/config.js';

// Keep near-full precision: rounding every 5-second chunk would drift (≈0.2 s/hour).
const roundFine = (n) => Math.round(n * 1e6) / 1e6;
/** If the clock jumps back further than this, we assume a manual clock change. */
const CLOCK_ROLLBACK_TOLERANCE_MS = 10 * 60 * 1000;
const MAX_COURSE_KEY = 200;
const MAX_COURSE_TITLE = 200;

function cloneState(state) {
  return {
    ...state,
    settings: { ...state.settings },
    dailyHistory: { ...state.dailyHistory },
    courses: { ...state.courses },
    meta: { ...state.meta },
    debug: { ...(state.debug || {}) },
  };
}

function ensureDay(state, dayKey) {
  const existing = state.dailyHistory[dayKey];
  const rec = existing
    ? normalizeDayRecord(existing, goalSecondsOf(state.settings))
    : { contentSeconds: 0, actualActiveSeconds: 0, goalSeconds: goalSecondsOf(state.settings), completed: false };
  state.dailyHistory[dayKey] = rec;
  return rec;
}

/** Add active/content seconds to one day; returns true if the day just became completed. */
function addToDay(state, dayKey, activeSeconds, contentSeconds, nowMs) {
  const rec = ensureDay(state, dayKey);
  const wasCompleted = isDayCompleted(rec);
  rec.actualActiveSeconds = roundFine(rec.actualActiveSeconds + Math.max(0, activeSeconds));
  rec.contentSeconds = roundFine(rec.contentSeconds + Math.max(0, contentSeconds));
  if (!wasCompleted && learningSecondsOf(rec) >= rec.goalSeconds) {
    rec.completed = true;
    rec.completedAt = nowMs;
    return true;
  }
  if (wasCompleted) rec.completed = true;
  return false;
}

export function sanitizeCourse(course) {
  if (!course || typeof course !== 'object') return null;
  const key = String(course.key || '').slice(0, MAX_COURSE_KEY).trim();
  if (!key) return null;
  const title = String(course.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_COURSE_TITLE) || 'Udemy Learning';
  return { key, title };
}

function refreshLongest(state, todayKey) {
  const { longest } = computeStreaks(state.dailyHistory, todayKey, state.meta.longestStreak);
  state.meta.longestStreak = longest;
}

/**
 * Apply a credit chunk.
 * @returns {{ state, appliedSeconds, appliedContent, completedDays: string[], rejected?: string }}
 */
export function applyCredit(prevState, credit, { clockOffsetMs = 0 } = {}) {
  const reject = (why) => ({ state: prevState, appliedSeconds: 0, appliedContent: 0, completedDays: [], rejected: why });
  const active = Number(credit?.active ?? credit?.seconds ?? 0);
  const content = Number(credit?.content ?? 0);
  const endMs = Number(credit?.endMs);
  if (!Number.isFinite(active) || !Number.isFinite(content) || active < 0 || content < 0) return reject('invalid');
  if (active <= 0) return reject('non-positive'); // content can only come with active watching
  if (!Number.isFinite(endMs) || endMs <= 0) return reject('bad-timestamp');

  const state = cloneState(prevState);
  let applied = Math.min(active, MAX_CREDIT_PER_MESSAGE_SECONDS);
  // Content must be explainable by real watching time at a plausible speed.
  let appliedContent = Math.min(content, applied * MAX_PLAUSIBLE_PLAYBACK_RATE + 5, MAX_CONTENT_PER_MESSAGE_SECONDS);

  // Never count the same wall-clock instant twice (e.g. two Udemy tabs playing at
  // once, one in the background). `creditedUntil` is a real-time high-water mark.
  let creditedUntil = Number(state.meta.creditedUntil) || 0;
  if (creditedUntil - endMs > CLOCK_ROLLBACK_TOLERANCE_MS) creditedUntil = 0; // clock was set back
  const startMs = endMs - applied * 1000;
  if (startMs < creditedUntil) {
    const clipped = Math.max(0, (endMs - creditedUntil) / 1000);
    appliedContent = applied > 0 ? appliedContent * (clipped / applied) : 0;
    applied = clipped;
  }
  if (applied <= 0.001) return reject('overlap');
  state.meta.creditedUntil = Math.max(creditedUntil, endMs);

  const effectiveEnd = endMs + clockOffsetMs;
  const completedDays = [];
  for (const part of splitCreditByDay(effectiveEnd, applied)) {
    const share = part.seconds / applied;
    if (addToDay(state, part.dayKey, part.seconds, appliedContent * share, effectiveEnd)) completedDays.push(part.dayKey);
  }

  const course = sanitizeCourse(credit.course);
  if (course) {
    const prev = normalizeCourse(state.courses[course.key] || { title: course.title });
    state.courses[course.key] = {
      ...prev,
      title: course.title || prev.title,
      contentSeconds: roundFine(prev.contentSeconds + appliedContent),
      actualActiveSeconds: roundFine(prev.actualActiveSeconds + applied),
      lastWatchedAt: effectiveEnd,
    };
    state.meta.currentCourse = { key: course.key, title: course.title, updatedAt: effectiveEnd };
  }

  refreshLongest(state, toDayKey(effectiveEnd));
  return { state, appliedSeconds: applied, appliedContent, completedDays };
}

/**
 * Change the daily goal. Past days keep the goal they had. Today's record (if it
 * exists and isn't completed yet) adopts the new goal, and completes immediately
 * if it already meets it. A completed day stays completed.
 */
export function applyGoalChange(prevState, goalMinutes, todayKey, nowMs = Date.now()) {
  const state = cloneState(prevState);
  state.settings.dailyGoalMinutes = clampGoalMinutes(goalMinutes);
  const completedDays = [];
  const rec = state.dailyHistory[todayKey];
  if (rec && !isDayCompleted(rec)) {
    const updated = { ...normalizeDayRecord(rec, goalSecondsOf(state.settings)), goalSeconds: goalSecondsOf(state.settings) };
    if (learningSecondsOf(updated) >= updated.goalSeconds) {
      updated.completed = true;
      updated.completedAt = nowMs;
      completedDays.push(todayKey);
    }
    state.dailyHistory[todayKey] = updated;
  }
  refreshLongest(state, todayKey);
  return { state, completedDays };
}

/**
 * Debug helper: add content (and real) seconds directly to a day (no splitting,
 * no overlap check). activeSeconds defaults to contentSeconds (i.e. 1x speed).
 */
export function addSecondsToDay(prevState, dayKey, contentSeconds, activeSeconds = contentSeconds, nowMs = Date.now()) {
  const state = cloneState(prevState);
  const completedDays = [];
  if ((contentSeconds > 0 || activeSeconds > 0) && addToDay(state, dayKey, activeSeconds, contentSeconds, nowMs)) completedDays.push(dayKey);
  refreshLongest(state, dayKey);
  return { state, completedDays };
}

export function markCelebrationShown(prevState, dayKey) {
  const rec = prevState.dailyHistory[dayKey];
  if (!rec || rec.celebrationShown) return { state: prevState, changed: false };
  const state = cloneState(prevState);
  state.dailyHistory[dayKey] = { ...rec, celebrationShown: true };
  return { state, changed: true };
}
