/** Human-friendly duration formatting. Minutes are always floored (never rounded up). */

export function wholeMinutes(seconds) {
  return Math.floor(Math.max(0, Number(seconds) || 0) / 60);
}

/** 0 → "0m", 2580 → "43m", 23460 → "6h 31m", 7200 → "2h 0m". */
export function formatDuration(seconds) {
  const mins = wholeMinutes(seconds);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

/** Compact variant for tight tiles: drops minutes from 100h upwards ("123h"). */
export function formatDurationCompact(seconds) {
  const mins = wholeMinutes(seconds);
  if (mins >= 100 * 60) return `${Math.floor(mins / 60)}h`;
  return formatDuration(seconds);
}

/** Precise style for today's numbers: 504 → "8m 24s", 3725 → "1h 02m". */
export function formatMinSec(seconds) {
  const total = Math.floor(Math.max(0, Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** "2×", "1.5×", "1.25×" */
export function formatRate(rate) {
  const r = Math.round(Number(rate) * 100) / 100;
  return `${r}×`;
}

/** Live timer style: "42:07" or "1:02:07". */
export function formatClock(seconds) {
  const total = Math.floor(Math.max(0, Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function pluralize(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
