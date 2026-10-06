/**
 * Calendar-day helpers.
 *
 * A "day key" is the user's LOCAL calendar date formatted as YYYY-MM-DD.
 * Day keys are computed from the local clock at the moment learning time is
 * recorded. All day arithmetic (yesterday, +N days, differences) is done on the
 * keys themselves via UTC math, so it is immune to DST transitions and to the
 * user changing time zones later.
 */

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const pad2 = (n) => String(n).padStart(2, '0');

/** Local calendar day key for a timestamp (ms) or Date. */
export function toDayKey(input = Date.now()) {
  const d = input instanceof Date ? input : new Date(input);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** True if `key` is a well-formed, real calendar date (e.g. rejects 2026-02-30). */
export function isValidDayKey(key) {
  if (typeof key !== 'string') return false;
  const m = DAY_KEY_RE.exec(key);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Parse a day key into {year, month (1-12), day}. Throws on invalid input. */
export function parseDayKey(key) {
  if (!isValidDayKey(key)) throw new Error(`Invalid day key: ${key}`);
  const [y, m, d] = key.split('-').map(Number);
  return { year: y, month: m, day: d };
}

function keyToUtcMs(key) {
  const { year, month, day } = parseDayKey(key);
  return Date.UTC(year, month - 1, day);
}

function utcMsToKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Key for N calendar days after (or before, if negative) `key`. */
export function addDays(key, n) {
  return utcMsToKey(keyToUtcMs(key) + n * MS_PER_DAY);
}

/** Whole calendar days from `a` to `b` (b - a). */
export function diffDays(a, b) {
  return Math.round((keyToUtcMs(b) - keyToUtcMs(a)) / MS_PER_DAY);
}

/** 0 = Monday … 6 = Sunday for a day key. */
export function weekdayMondayFirst(key) {
  const dow = new Date(keyToUtcMs(key)).getUTCDay(); // 0 = Sunday
  return (dow + 6) % 7;
}

/** Monday of the week containing `key`. */
export function startOfWeek(key) {
  return addDays(key, -weekdayMondayFirst(key));
}

/** First day of the month containing `key`. */
export function startOfMonth(key) {
  const { year, month } = parseDayKey(key);
  return `${year}-${pad2(month)}-01`;
}

export function daysInMonth(year, month /* 1-12 */) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function makeDayKey(year, month /* 1-12 */, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Shift a {year, month} pair by `delta` months. */
export function shiftMonth({ year, month }, delta) {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Timestamp (ms) of the next LOCAL midnight strictly after `ms`. DST-safe. */
export function nextLocalMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

/**
 * Split the real-time interval [startMs, endMs) across local calendar days.
 * Returns [{ dayKey, seconds }] in chronological order. Used so a session from
 * 11:40 PM to 12:10 AM is credited 20 min to the first day and 10 min to the next.
 */
export function splitIntervalByDay(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const parts = [];
  let cursor = startMs;
  let guard = 0;
  while (cursor < endMs && guard++ < 400) {
    const boundary = Math.min(nextLocalMidnight(cursor), endMs);
    parts.push({ dayKey: toDayKey(cursor), seconds: (boundary - cursor) / 1000 });
    cursor = boundary;
  }
  return parts;
}

/**
 * Distribute `seconds` of credited time over the interval that ended at `endMs`.
 * The credited amount can be slightly smaller than the wall-clock span (e.g. a
 * buffering stall), so the span is taken as the last `seconds` before `endMs`.
 */
export function splitCreditByDay(endMs, seconds) {
  if (!(seconds > 0)) return [];
  return splitIntervalByDay(endMs - seconds * 1000, endMs);
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatDayKey(key, { withYear = false } = {}) {
  const { year, month, day } = parseDayKey(key);
  const base = `${MONTH_NAMES[month - 1].slice(0, 3)} ${day}`;
  return withYear ? `${base}, ${year}` : base;
}
