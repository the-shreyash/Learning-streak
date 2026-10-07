/**
 * Learning Engine — the platform-independent path from a verified credit chunk
 * to persisted learning data.
 *
 *   platform adapter (content script) → credit { endMs, active, content, source }
 *        ↓
 *   recordLearning()
 *        ├─ applyCredit()        V1.2.1 accounting, unchanged: overlap guard,
 *        │                       midnight split, day totals, course totals, streak
 *        ├─ day.platforms[p]     per-platform sub-ledger of the SAME seconds
 *        └─ sessions[id]         LearningSession log
 *
 * Every second is added to the day total exactly once (by applyCredit). The
 * platform breakdown and the session are attributions of those already-applied
 * seconds, never additional time. A replayed / overlapping chunk is clipped by
 * applyCredit's `creditedUntil` high-water mark, so it cannot reach either.
 *
 * Nothing in here knows about DOM selectors or platform URLs.
 *
 * recordCredit() is the entry point for credit coming from a tab: it adds the
 * registration gate (platforms with detection 'registered' — YouTube — only count
 * content that is in the Learning Library AND enabled) in front of recordLearning().
 */

import { applyCredit } from './timerEngine.js';
import { normalizeSource, contentKeyOf, createSession, extendSession, serializeSession } from './learningSession.js';
import { getPlatform, LEGACY_PLATFORM } from '../platforms/registry.js';
import { targetStatus } from './learningLibrary.js';

/** A pause longer than this between credits on the same content starts a new session. */
export const SESSION_GAP_MS = 5 * 60 * 1000;
/** Keep the session log bounded (oldest dropped first; daily totals are unaffected). */
export const MAX_SESSIONS = 2000;

const roundFine = (n) => Math.round(n * 1e6) / 1e6;

function courseFor(source) {
  if (!source.courseId) return null;
  const platform = getPlatform(source.platform);
  return { key: platform.courseKey(source), title: source.courseTitle || platform.defaultCourseTitle };
}

function addPlatformTime(state, parts, platformId) {
  for (const part of parts) {
    const rec = state.dailyHistory[part.dayKey];
    if (!rec) continue;
    const platforms = { ...(rec.platforms || {}) };
    const prev = platforms[platformId] || {};
    platforms[platformId] = {
      contentSeconds: roundFine((Number(prev.contentSeconds) || 0) + part.content),
      actualActiveSeconds: roundFine((Number(prev.actualActiveSeconds) || 0) + part.active),
    };
    state.dailyHistory[part.dayKey] = { ...rec, platforms };
  }
}

function pruneSessions(sessions) {
  const ids = Object.keys(sessions);
  if (ids.length <= MAX_SESSIONS) return sessions;
  ids.sort((a, b) => sessions[a].endedAt - sessions[b].endedAt);
  const kept = {};
  for (const id of ids.slice(ids.length - MAX_SESSIONS)) kept[id] = sessions[id];
  return kept;
}

function recordSession(state, source, { startMs, endMs, content, active }) {
  const sessions = { ...(state.sessions || {}) };
  const key = contentKeyOf(source);
  const openId = state.meta.activeSessionId;
  const open = openId ? sessions[openId] : null;
  let session;
  if (open && contentKeyOf(open) === key && startMs - open.endedAt <= SESSION_GAP_MS && endMs >= open.endedAt) {
    // Same content, continuous: keep the session; refresh titles if the adapter learned better ones.
    session = extendSession({ ...open, ...pickTitles(source, open) }, { endedAt: endMs, contentSeconds: content, actualActiveSeconds: active });
  } else {
    session = createSession(source, { startedAt: startMs, endedAt: endMs, contentSeconds: content, actualActiveSeconds: active });
    let n = 1;
    const baseId = session.id;
    while (sessions[session.id]) session = { ...session, id: `${baseId}_${n++}` };
  }
  sessions[session.id] = serializeSession(session);
  state.sessions = pruneSessions(sessions);
  state.meta = { ...state.meta, activeSessionId: session.id };
  return session;
}

function pickTitles(source, open) {
  return {
    courseTitle: source.courseTitle ?? open.courseTitle ?? null,
    lessonTitle: source.lessonTitle ?? open.lessonTitle ?? null,
    subject: source.subject ?? open.subject ?? null,
  };
}

/**
 * Record a credit chunk { endMs, active, content, source }.
 * @returns {{ state, appliedSeconds, appliedContent, completedDays, session?, rejected? }}
 */
export function recordLearning(prevState, credit, opts = {}) {
  const source = normalizeSource(credit?.source);
  if (!source) return { state: prevState, appliedSeconds: 0, appliedContent: 0, completedDays: [], rejected: 'invalid-source' };

  const course = courseFor(source);
  const result = applyCredit(prevState, { ...credit, course }, opts);
  if (result.rejected) return result;

  const { parts, effectiveEnd, appliedSeconds, appliedContent } = result;
  const state = { ...result.state };
  addPlatformTime(state, parts, source.platform);

  if (course && source.platform !== LEGACY_PLATFORM && state.courses[course.key]) {
    // Course totals carry their platform, except the legacy platform's, which keep the exact V1 shape.
    state.courses[course.key] = { ...state.courses[course.key], platform: source.platform };
  }

  const session = recordSession(state, source, {
    startMs: effectiveEnd - appliedSeconds * 1000,
    endMs: effectiveEnd,
    content: appliedContent,
    active: appliedSeconds,
  });
  return { ...result, state, session };
}

/**
 * Record a credit chunk from a tab. For platforms whose content must be
 * registered, the credit is rejected ('not-registered' / 'disabled') unless the
 * exact target is an enabled Learning Library item — checked against the state
 * being written, so a library change can never race a credit. The library
 * item's title/subject (the user's own words) take precedence over the page's.
 * @returns same as recordLearning(), plus `targetStatus` for registered platforms
 */
export function recordCredit(prevState, credit, opts = {}) {
  const source = normalizeSource(credit?.source);
  if (!source) return { state: prevState, appliedSeconds: 0, appliedContent: 0, completedDays: [], rejected: 'invalid-source' };
  if (getPlatform(source.platform).detection !== 'registered') return recordLearning(prevState, { ...credit, source }, opts);

  const { status, item } = targetStatus(prevState.library, source.platform, source.contentType, source.contentId);
  if (status !== 'registered') return { state: prevState, appliedSeconds: 0, appliedContent: 0, completedDays: [], rejected: status, targetStatus: status };
  const authorized = { ...source, courseTitle: item.title ?? source.courseTitle, subject: item.subject ?? null };
  return { ...recordLearning(prevState, { ...credit, source: authorized }, opts), targetStatus: status };
}
