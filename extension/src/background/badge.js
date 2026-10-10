/**
 * Toolbar badge: today's minutes, coloured by state.
 *   orange = tracking right now · green = today's goal complete · grey = idle
 */
import { wholeMinutes } from '../core/format.js';
import { isDayCompleted } from '../core/streakEngine.js';
import { learningSecondsOf } from '../core/records.js';
import { todayKeyFor } from '../core/clock.js';

const COLORS = { tracking: '#F97316', complete: '#16A34A', idle: '#3F4651' };
const TRACKING_KEY = 'trackingTabs';
const STALE_MS = 30_000;

export async function setTabStatus(tabId, counting) {
  if (tabId === undefined || tabId === null) return;
  const { [TRACKING_KEY]: tabs = {} } = await chrome.storage.session.get(TRACKING_KEY);
  if (counting) tabs[tabId] = Date.now(); else delete tabs[tabId];
  await chrome.storage.session.set({ [TRACKING_KEY]: tabs });
}

export async function clearTab(tabId) {
  return setTabStatus(tabId, false);
}

async function isAnyTabTracking() {
  const { [TRACKING_KEY]: tabs = {} } = await chrome.storage.session.get(TRACKING_KEY);
  const now = Date.now();
  return Object.values(tabs).some((t) => now - t < STALE_MS);
}

export async function refreshBadge(state) {
  try {
    const todayKey = todayKeyFor(state);
    const rec = state.dailyHistory[todayKey];
    const mins = wholeMinutes(learningSecondsOf(rec)); // lecture content consumed today
    const tracking = await isAnyTabTracking();
    const complete = isDayCompleted(rec);
    let text = '';
    if (mins > 0 || tracking) text = mins >= 1000 ? `${Math.floor(mins / 60)}h` : `${mins}m`;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: tracking ? COLORS.tracking : complete ? COLORS.complete : COLORS.idle });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
    await chrome.action.setTitle({
      title: `LearningStreak — ${mins} min of lecture content today${complete ? ' ✓ goal complete' : ''}${tracking ? ' · tracking' : ''}`,
    });
  } catch (e) {
    console.warn('[streak] badge update failed', e);
  }
}
