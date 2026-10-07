/**
 * LearningSession — the platform-independent record of one continuous stretch
 * of learning on one piece of content.
 *
 * {
 *   id,                    // deterministic: start time + content key
 *   platform,              // 'udemy' | 'youtube' (see platforms/registry.js)
 *   contentType,           // 'course' | 'video' | 'playlist'
 *   contentId,             // Udemy course slug, YouTube video id or playlist id
 *   courseId, courseTitle, // grouping for course totals (playlist / course)
 *   lessonId, lessonTitle, // the lecture / video inside the course (optional)
 *   subject,               // user-chosen subject (optional, never inferred)
 *   startedAt, endedAt,    // real ms timestamps (debug clock offset applied)
 *   contentSeconds,        // validated content consumed (speed-aware) — PRIMARY
 *   actualActiveSeconds,   // real time spent genuinely playing
 * }
 *
 * Sessions are a log. Daily totals in `dailyHistory` stay the source of truth
 * for goals and streaks (V1 history has no sessions and none are invented).
 */

import { isKnownPlatform, getPlatform } from '../platforms/registry.js';

const MAX_STR = 200;
const CONTENT_TYPES = new Set(['course', 'video', 'playlist']);
const roundFine = (n) => Math.round(n * 1e6) / 1e6;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonNeg = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_STR);
  return s || null;
}

/**
 * Validate a content source (what a platform adapter reports). Returns the
 * normalized source or null if it is unusable (unknown platform, content type
 * the platform does not support, missing content id for registered platforms).
 */
export function normalizeSource(raw) {
  if (!isObj(raw) || !isKnownPlatform(raw.platform)) return null;
  const platform = getPlatform(raw.platform);
  if (!CONTENT_TYPES.has(raw.contentType) || !platform.contentTypes.includes(raw.contentType)) return null;
  const contentId = cleanStr(raw.contentId);
  // Content that must be registered can never be anonymous.
  if (!contentId && platform.detection !== 'automatic') return null;
  return {
    platform: platform.id,
    contentType: raw.contentType,
    contentId,
    courseId: cleanStr(raw.courseId) ?? contentId,
    courseTitle: cleanStr(raw.courseTitle),
    lessonId: cleanStr(raw.lessonId),
    lessonTitle: cleanStr(raw.lessonTitle),
    subject: cleanStr(raw.subject),
  };
}

/** Identity of "the same content" for session continuation. */
export function contentKeyOf(source) {
  return [source.platform, source.contentType, source.contentId ?? '', source.lessonId ?? ''].join('|');
}

function hash36(str) {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function sessionIdFor(source, startedAt) {
  return `ls_${Math.round(startedAt).toString(36)}_${hash36(contentKeyOf(source))}`;
}

export function createSession(source, { startedAt, endedAt, contentSeconds = 0, actualActiveSeconds = 0 }) {
  const src = normalizeSource(source);
  if (!src) throw new TypeError('invalid learning source');
  const start = Number(startedAt);
  const end = Number(endedAt ?? startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new RangeError('invalid session time range');
  return {
    id: sessionIdFor(src, start),
    ...src,
    startedAt: start,
    endedAt: end,
    contentSeconds: roundFine(Math.max(0, Number(contentSeconds) || 0)),
    actualActiveSeconds: roundFine(Math.max(0, Number(actualActiveSeconds) || 0)),
  };
}

/** Returns a NEW session extended to `endedAt` with the added time. */
export function extendSession(session, { endedAt, contentSeconds = 0, actualActiveSeconds = 0 }) {
  return {
    ...session,
    endedAt: Math.max(session.endedAt, Number(endedAt) || session.endedAt),
    contentSeconds: roundFine(session.contentSeconds + Math.max(0, contentSeconds)),
    actualActiveSeconds: roundFine(session.actualActiveSeconds + Math.max(0, actualActiveSeconds)),
  };
}

/** Plain JSON form (stable key order, optional fields omitted when null). */
export function serializeSession(session) {
  const out = {
    id: session.id,
    platform: session.platform,
    contentType: session.contentType,
    contentId: session.contentId,
    courseId: session.courseId,
    courseTitle: session.courseTitle,
    lessonId: session.lessonId,
    lessonTitle: session.lessonTitle,
    subject: session.subject,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    contentSeconds: session.contentSeconds,
    actualActiveSeconds: session.actualActiveSeconds,
  };
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  return out;
}

/** Parse a stored / imported session. Returns a session or null if malformed. */
export function deserializeSession(raw) {
  if (!isObj(raw)) return null;
  const src = normalizeSource(raw);
  const id = cleanStr(raw.id);
  const startedAt = nonNeg(raw.startedAt);
  const endedAt = nonNeg(raw.endedAt);
  const content = nonNeg(raw.contentSeconds);
  const active = nonNeg(raw.actualActiveSeconds);
  if (!src || !id || startedAt === null || endedAt === null || endedAt < startedAt || content === null || active === null) return null;
  return { id, ...src, startedAt, endedAt, contentSeconds: content, actualActiveSeconds: active };
}

/** Normalize a whole `sessions` map; malformed entries are dropped. */
export function normalizeSessions(raw) {
  const sessions = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(isObj(raw) ? raw : {})) {
    const s = deserializeSession(value);
    if (!s || s.id !== key) { dropped += 1; continue; }
    sessions[key] = serializeSession(s);
  }
  return { sessions, dropped };
}
