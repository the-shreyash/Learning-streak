/**
 * Daily aggregation across platforms.
 *
 * A day record's top-level totals (contentSeconds, actualActiveSeconds,
 * legacySeconds) are the aggregate over ALL platforms — that is what goals and
 * streaks already consume (records.learningSecondsOf). V2 adds an optional
 * sub-ledger `platforms: { [id]: { contentSeconds, actualActiveSeconds } }`
 * that attributes those same seconds; it is never added on top.
 *
 * Time without a platform attribution (all V1.x history, legacy seconds, and
 * credit applied before V2) was recorded when only Udemy was tracked, so it is
 * attributed to LEGACY_PLATFORM. Nothing is attributed to YouTube that was not
 * recorded as YouTube.
 */

import { learningSecondsOf, contentSecondsOf, activeSecondsOf, legacySecondsOf } from './records.js';
import { isDayCompleted } from './streakEngine.js';
import { PLATFORM_IDS, LEGACY_PLATFORM, platformLabel } from '../platforms/registry.js';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate a stored / imported `platforms` sub-ledger; unknown or bad entries are dropped. */
export function normalizePlatformTotals(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const id of PLATFORM_IDS) {
    const p = raw[id];
    if (!isObj(p)) continue;
    const content = num(p.contentSeconds);
    const active = num(p.actualActiveSeconds);
    if (content > 0 || active > 0) out[id] = { contentSeconds: content, actualActiveSeconds: active };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Per-platform totals for one day record.
 * @returns {{ [platformId]: { contentSeconds, actualActiveSeconds, learningSeconds } }}
 *   Every known platform is present; their learningSeconds sum to learningSecondsOf(rec).
 */
export function platformBreakdownOf(rec) {
  const ledger = normalizePlatformTotals(rec?.platforms) || {};
  const out = {};
  let attributedContent = 0;
  let attributedActive = 0;
  for (const id of PLATFORM_IDS) {
    const p = ledger[id] || { contentSeconds: 0, actualActiveSeconds: 0 };
    out[id] = { contentSeconds: p.contentSeconds, actualActiveSeconds: p.actualActiveSeconds, learningSeconds: p.contentSeconds };
    attributedContent += p.contentSeconds;
    attributedActive += p.actualActiveSeconds;
  }
  // Unattributed remainder (V1 history / legacy time) belongs to the legacy platform.
  // Clamp: the sub-ledger can only ever be ≤ the totals, but never trust stored data.
  const legacy = out[LEGACY_PLATFORM];
  const restContent = Math.max(0, contentSecondsOf(rec) - attributedContent);
  const restActive = Math.max(0, activeSecondsOf(rec) - attributedActive);
  legacy.contentSeconds += restContent;
  legacy.actualActiveSeconds += restActive;
  legacy.learningSeconds += restContent + legacySecondsOf(rec);
  return out;
}

/**
 * Platform-independent summary of one day: what the popup / dashboard show and
 * what the goal uses. `totalLearningSeconds` is exactly the streak engine's value.
 */
export function dailySummary(history, dayKey, fallbackGoalSeconds) {
  const rec = history?.[dayKey];
  const breakdown = platformBreakdownOf(rec);
  const totalLearningSeconds = learningSecondsOf(rec);
  const goalSeconds = num(rec?.goalSeconds) || fallbackGoalSeconds;
  return {
    dayKey,
    platforms: PLATFORM_IDS
      .map((id) => ({ platform: id, label: platformLabel(id), ...breakdown[id] }))
      .filter((p) => p.learningSeconds > 0 || p.actualActiveSeconds > 0),
    totalLearningSeconds,
    totalActualActiveSeconds: activeSecondsOf(rec),
    goalSeconds,
    completed: isDayCompleted(rec),
    progress: goalSeconds > 0 ? Math.min(1, totalLearningSeconds / goalSeconds) : 0,
  };
}
