/**
 * Clock abstraction. In production this is just Date.now(). With DEBUG_TOOLS
 * enabled, a stored offset lets the developer panel "move to the next day"
 * without touching the system clock.
 */

import { DEBUG_TOOLS } from '../config/config.js';
import { toDayKey } from './dateUtils.js';

export function effectiveOffset(state) {
  if (!DEBUG_TOOLS) return 0;
  const off = Number(state?.debug?.clockOffsetMs);
  return Number.isFinite(off) ? off : 0;
}

export function nowFor(state) {
  return Date.now() + effectiveOffset(state);
}

export function todayKeyFor(state) {
  return toDayKey(nowFor(state));
}
