export const SRC = new URL('../../extension/src/', import.meta.url);
export const mod = (p) => import(new URL(p, SRC).href);

/** Build a (schema v2) dailyHistory where the given keys are completed (60/60 min of content at 1x). */
export function historyOf(completedKeys = [], partial = {}) {
  const h = {};
  for (const k of completedKeys) h[k] = { contentSeconds: 3600, actualActiveSeconds: 3600, goalSeconds: 3600, completed: true };
  for (const [k, s] of Object.entries(partial)) h[k] = { contentSeconds: s, actualActiveSeconds: s, goalSeconds: 3600, completed: s >= 3600 };
  return h;
}

/** Local timestamp helper: localMs(2026, 10, 6, 23, 40) → ms in the CURRENT process TZ. */
export const localMs = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
