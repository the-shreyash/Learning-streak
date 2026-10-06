/**
 * Background service worker — the ONLY writer of persisted state.
 *
 * Responsibilities
 *  - Receive verified credit chunks from content scripts and record them.
 *  - Reject credit while the screen is locked (chrome.idle).
 *  - Goal-complete notifications, daily reminder, badge.
 *  - Settings / import / reset requests from the popup & options pages.
 *  - Re-inject the tracker into already-open Udemy tabs after install/update so
 *    tracking continues without reloading the page.
 *
 * All listeners are registered synchronously at top level, as MV3 requires.
 */

import { DEBUG_TOOLS } from '../config/config.js';
import { createStorageService } from '../storage/storageService.js';
import { createDefaultState, normalizeSettings } from '../core/schema.js';
import { applyCredit, applyGoalChange, addSecondsToDay, markCelebrationShown } from '../core/timerEngine.js';
import { validateImport, applyImport } from '../core/dataTransfer.js';
import { effectiveOffset, todayKeyFor } from '../core/clock.js';
import { addDays, toDayKey } from '../core/dateUtils.js';
import { learningSecondsOf } from '../core/records.js';
import { refreshBadge, setTabStatus, clearTab } from './badge.js';
import { notifyGoalComplete } from './notifications.js';
import { syncReminderAlarm, scheduleMidnight, handleReminder, REMINDER_ALARM, MIDNIGHT_ALARM } from './reminders.js';

const storage = createStorageService();
const UDEMY_TAB_PATTERN = 'https://*.udemy.com/*';

// ---------------------------------------------------------------------------
// Screen lock detection
// ---------------------------------------------------------------------------
let lockedCache = false;

async function isLocked() {
  try {
    lockedCache = (await chrome.idle.queryState(60)) === 'locked';
  } catch { /* keep cache */ }
  return lockedCache;
}

async function broadcastToUdemyTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: UDEMY_TAB_PATTERN });
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, message).catch(() => {})));
  } catch { /* no tabs */ }
}

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  lockedCache = state === 'locked';
  broadcastToUdemyTabs({ type: 'system:lock', locked: lockedCache });
});

// ---------------------------------------------------------------------------
// Goal completion side effects
// ---------------------------------------------------------------------------
async function handleCompletedDays(state, completedDays) {
  const todayKey = todayKeyFor(state);
  if (!completedDays.includes(todayKey)) return state;
  if (state.meta.lastGoalNotifiedDay === todayKey) return state;
  const { state: next } = await storage.update((s) => ({ state: { ...s, meta: { ...s.meta, lastGoalNotifiedDay: todayKey } } }));
  await notifyGoalComplete(next, todayKey);
  return next;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------
async function onCredit(msg, sender) {
  if (!sender.tab) return { ok: false, error: 'credit must come from a tab' };
  if (await isLocked()) {
    await setTabStatus(sender.tab.id, false);
    return { ok: false, locked: true, rejected: 'locked' };
  }
  const result = await storage.update((state) =>
    applyCredit(state, { endMs: msg.endMs, active: msg.active, content: msg.content, seconds: msg.seconds, course: msg.course }, { clockOffsetMs: effectiveOffset(state) }));
  let state = result.state;
  if (result.completedDays?.length) state = await handleCompletedDays(state, result.completedDays);
  if (typeof msg.counting === 'boolean') await setTabStatus(sender.tab.id, msg.counting);
  await refreshBadge(state);
  return { ok: true, applied: result.appliedSeconds, appliedContent: result.appliedContent, rejected: result.rejected, locked: false };
}

async function onStatus(msg, sender) {
  if (!sender.tab) return { ok: false };
  const locked = await isLocked();
  await setTabStatus(sender.tab.id, !!msg.counting && !locked);
  await refreshBadge(await storage.read());
  return { ok: true, locked };
}

async function onSettingsUpdate(msg) {
  const result = await storage.update((state) => {
    const merged = normalizeSettings({ ...state.settings, ...(msg.patch || {}) });
    let next = { ...state, settings: merged };
    let completedDays = [];
    if (merged.dailyGoalMinutes !== state.settings.dailyGoalMinutes) {
      ({ state: next, completedDays } = applyGoalChange(next, merged.dailyGoalMinutes, todayKeyFor(state)));
    }
    return { state: next, completedDays };
  });
  let state = result.state;
  if (result.completedDays.length) state = await handleCompletedDays(state, result.completedDays);
  await syncReminderAlarm(state);
  await refreshBadge(state);
  return { ok: true, settings: state.settings };
}

async function onImport(msg) {
  const validation = validateImport(msg.payload);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const mode = msg.mode === 'replace' ? 'replace' : 'merge';
  const { state } = await storage.update((current) => ({
    state: applyImport(current, validation.data, mode, todayKeyFor(current)),
  }));
  await syncReminderAlarm(state);
  await refreshBadge(state);
  return { ok: true, summary: validation.summary, warnings: validation.warnings };
}

async function onReset() {
  const current = await storage.read();
  const fresh = createDefaultState();
  fresh.settings = { ...current.settings }; // "Reset statistics" keeps preferences
  await storage.reset(fresh);
  await refreshBadge(fresh);
  return { ok: true };
}

async function onAckCelebration(msg) {
  const { state } = await storage.update((s) => {
    const r = markCelebrationShown(s, msg.dayKey);
    return r.changed ? { state: r.state } : undefined;
  });
  return { ok: true, celebrationShown: !!state.dailyHistory[msg.dayKey]?.celebrationShown };
}

// Developer tools — inert unless DEBUG_TOOLS is true in config.js.
async function onDebug(msg) {
  if (!DEBUG_TOOLS) return { ok: false, error: 'debug tools disabled' };
  let result;
  switch (msg.action) {
    case 'addMinutes': {
      // `minutes` of lecture content watched at `rate` (default 1x) → real time = content / rate.
      const content = Math.max(0, Number(msg.minutes) || 0) * 60;
      const rate = Number(msg.rate) > 0 ? Number(msg.rate) : 1;
      result = await storage.update((s) => addSecondsToDay(s, todayKeyFor(s), content, content / rate));
      break;
    }
    case 'completeToday':
      result = await storage.update((s) => {
        const key = todayKeyFor(s);
        const rec = s.dailyHistory[key];
        const goal = Number(rec?.goalSeconds) || s.settings.dailyGoalMinutes * 60;
        return addSecondsToDay(s, key, Math.max(0, goal - learningSecondsOf(rec)));
      });
      break;
    case 'nextDay':
      result = await storage.update((s) => ({ state: { ...s, debug: { ...s.debug, clockOffsetMs: (Number(s.debug?.clockOffsetMs) || 0) + 86_400_000 } }, completedDays: [] }));
      break;
    case 'resetClock':
      result = await storage.update((s) => ({ state: { ...s, debug: { ...s.debug, clockOffsetMs: 0 } }, completedDays: [] }));
      break;
    case 'seedHistory': {
      result = await storage.update((s) => {
        let next = s;
        const today = todayKeyFor(s);
        for (let i = 90; i >= 1; i -= 1) {
          const r = Math.random();
          if (r < 0.25) continue;
          const mins = r < 0.45 ? 10 + Math.random() * 20 : r < 0.6 ? 30 + Math.random() * 25 : 60 + Math.random() * 60;
          next = addSecondsToDay(next, addDays(today, -i), mins * 60).state;
        }
        for (const [key, rec] of Object.entries(next.dailyHistory)) next.dailyHistory[key] = { ...rec, celebrationShown: true };
        return { state: next, completedDays: [] };
      });
      break;
    }
    default:
      return { ok: false, error: 'unknown action' };
  }
  let state = result.state;
  if (result.completedDays?.length) state = await handleCompletedDays(state, result.completedDays);
  await refreshBadge(state);
  return { ok: true, todayKey: todayKeyFor(state), clockOffsetMs: effectiveOffset(state) };
}

const HANDLERS = {
  'tracker:credit': onCredit,
  'tracker:status': onStatus,
  'settings:update': onSettingsUpdate,
  'data:import': onImport,
  'data:reset': onReset,
  'ui:ackCelebration': onAckCelebration,
  'debug:action': onDebug,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || !HANDLERS[msg.type]) return false;
  HANDLERS[msg.type](msg, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[streak] handler failed', msg.type, err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
  return true; // async response
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function injectIntoOpenUdemyTabs() {
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js || [];
  if (!files.length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: UDEMY_TAB_PATTERN }); } catch { return; }
  for (const tab of tabs) {
    if (tab.discarded || tab.id === undefined) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files }).catch(() => {});
  }
}

async function boot() {
  const state = await storage.initialize();
  await syncReminderAlarm(state);
  await scheduleMidnight();
  await refreshBadge(state);
  return state;
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await boot();
  if (details.reason === 'install' || details.reason === 'update') await injectIntoOpenUdemyTabs();
});

chrome.runtime.onStartup.addListener(() => { boot(); });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const state = await storage.read();
  if (alarm.name === REMINDER_ALARM) await handleReminder(state);
  if (alarm.name === MIDNIGHT_ALARM) {
    await refreshBadge(state);
    await scheduleMidnight();
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearTab(tabId);
  refreshBadge(await storage.read());
});

chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  if (id.startsWith('reminder-')) chrome.tabs.create({ url: 'https://www.udemy.com/home/my-courses/learning/' });
});

// Exposed for debugging from the service-worker console only.
globalThis.__streakDebug = { storage, toDayKey };
