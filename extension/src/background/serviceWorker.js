/**
 * Background service worker — the ONLY writer of persisted state.
 *
 * Responsibilities
 *  - Receive verified credit chunks from content scripts and record them.
 *  - Reject credit while the screen is locked (chrome.idle).
 *  - Goal-complete notifications, daily reminder, badge.
 *  - Settings / import / reset requests from the popup & options pages.
 *  - Re-inject the tracker into already-open Udemy / YouTube / Coursera tabs after
 *    install/update so tracking continues without reloading the page.
 *  - V2.1: the Learning Library (registered YouTube videos and playlists) — lookups from tabs,
 *    add / enable / disable / delete from extension pages — and the index of video IDs
 *    proven (by YouTube's playlist panel) to be members of registered playlists.
 *
 * All listeners are registered synchronously at top level, as MV3 requires.
 */

import { DEBUG_TOOLS } from '../config/config.js';
import { createStorageService } from '../storage/storageService.js';
import { createDefaultState, normalizeSettings } from '../core/schema.js';
import { applyGoalChange, addSecondsToDay, markCelebrationShown } from '../core/timerEngine.js';
import { recordCredit } from '../core/learningEngine.js';
import { addYouTubeContent, setLibraryItemEnabled, removeLibraryItem, targetStatus, knownMembership } from '../core/learningLibrary.js';
import { addProvenMembers, pruneMembership } from '../core/playlistMembership.js';
import { sourceFromLegacyCourse } from '../platforms/udemy.js';
import { validateImport, applyImport } from '../core/dataTransfer.js';
import { effectiveOffset, todayKeyFor } from '../core/clock.js';
import { addDays, toDayKey } from '../core/dateUtils.js';
import { learningSecondsOf } from '../core/records.js';
import { refreshBadge, setTabStatus, clearTab } from './badge.js';
import { notifyGoalComplete } from './notifications.js';
import { syncReminderAlarm, scheduleMidnight, handleReminder, REMINDER_ALARM, MIDNIGHT_ALARM } from './reminders.js';

const storage = createStorageService();
const UDEMY_TAB_PATTERN = 'https://*.udemy.com/*';
const YOUTUBE_TAB_PATTERN = 'https://www.youtube.com/*';
const COURSERA_TAB_PATTERN = 'https://www.coursera.org/*';
const TRACKED_TAB_PATTERNS = [UDEMY_TAB_PATTERN, YOUTUBE_TAB_PATTERN, COURSERA_TAB_PATTERN];

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

async function broadcastToTabs(message, url = TRACKED_TAB_PATTERNS, exceptTabId = null) {
  try {
    const tabs = (await chrome.tabs.query({ url })).filter((t) => t.id !== exceptTabId);
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, message).catch(() => {})));
  } catch { /* no tabs */ }
}

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
  lockedCache = state === 'locked';
  broadcastToTabs({ type: 'system:lock', locked: lockedCache });
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
  // V2.1: every credit goes through the Learning Engine. A V1-shaped credit (no
  // `source`) comes from the Udemy content script and is mapped by the Udemy adapter.
  // recordCredit() rejects YouTube time unless the video is an ENABLED Library item,
  // or a proven member of an ENABLED Library playlist.
  const source = msg.source !== undefined ? msg.source : sourceFromLegacyCourse(msg.course);
  const result = await storage.update((state) =>
    recordCredit(state, { endMs: msg.endMs, active: msg.active, content: msg.content, seconds: msg.seconds, source }, { clockOffsetMs: effectiveOffset(state) }));
  let state = result.state;
  if (result.completedDays?.length) state = await handleCompletedDays(state, result.completedDays);
  const unauthorized = result.targetStatus !== undefined && result.targetStatus !== 'registered';
  if (typeof msg.counting === 'boolean') await setTabStatus(sender.tab.id, msg.counting && !unauthorized);
  await refreshBadge(state);
  return { ok: true, applied: result.appliedSeconds, appliedContent: result.appliedContent, rejected: result.rejected, targetStatus: result.targetStatus, videoStatus: result.videoStatus, playlistStatus: result.playlistStatus, locked: false };
}

async function onStatus(msg, sender) {
  if (!sender.tab) return { ok: false };
  const locked = await isLocked();
  await setTabStatus(sender.tab.id, !!msg.counting && !locked);
  await refreshBadge(await storage.read());
  return { ok: true, locked };
}

// ---- Learning Library --------------------------------------------------------
const fromExtensionPage = (sender) => typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

/**
 * Is this target registered? Asked by the YouTube content script (read-only).
 * For a video, also: a registered playlist it was proven to be a member of
 * (`known`: the enabled one if any — status 'registered' — else 'disabled').
 */
async function onLibraryLookup(msg, sender) {
  if (!sender.tab) return { ok: false, error: 'lookup must come from a tab' };
  const state = await storage.read();
  const { status, item } = targetStatus(state.library, msg.platform, msg.contentType, msg.targetId);
  const known = msg.platform === 'youtube' && msg.contentType === 'video' ? knownMembership(state.library, state.playlistMembership, msg.targetId) : null;
  return { ok: true, status, title: item?.title || null, subject: item?.subject || null, ...(known ? { known } : {}) };
}

/**
 * Video IDs YouTube's playlist panel proved to be in playlist P (content/youtubePlaylist.js).
 * Merged into the index (never removed); only for playlists in the Library.
 */
async function onPlaylistMembers(msg, sender) {
  if (!sender.tab) return { ok: false, error: 'membership must come from a tab' };
  if (!Array.isArray(msg.videoIds)) return { ok: false, error: 'videoIds must be a list' };
  let added = [];
  await storage.update((state) => {
    const r = addProvenMembers(state.playlistMembership, state.library, msg.playlistId, msg.videoIds.slice(0, 1000));
    added = r.added;
    return added.length ? { state: { ...state, playlistMembership: r.membership } } : undefined;
  });
  // Other YouTube tabs may hold a stale "not registered" answer for a newly proven
  // video (the reporting tab updates its own answers from `added`).
  if (added.length) await broadcastToTabs({ type: 'library:changed' }, YOUTUBE_TAB_PATTERN, sender.tab.id);
  return { ok: true, added };
}

/** Apply a pure library mutation, then tell open YouTube tabs to re-check. */
async function mutateLibrary(sender, fn) {
  if (!fromExtensionPage(sender)) return { ok: false, error: 'library changes must come from the extension' };
  let outcome;
  await storage.update((state) => {
    outcome = fn(state.library || {});
    // A playlist removed from the Library takes its proven members with it.
    return outcome.ok ? { state: { ...state, library: outcome.library, playlistMembership: pruneMembership(state.playlistMembership, outcome.library) } } : undefined;
  });
  if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error };
  await broadcastToTabs({ type: 'library:changed' }, YOUTUBE_TAB_PATTERN);
  return { ok: true, item: outcome.item, playlistIgnored: outcome.playlistIgnored };
}

const onLibraryAdd = (msg, sender) => mutateLibrary(sender, (lib) => addYouTubeContent(lib, { url: msg.url, title: msg.title, subject: msg.subject }));
const onLibrarySetEnabled = (msg, sender) => mutateLibrary(sender, (lib) => setLibraryItemEnabled(lib, msg.id, msg.enabled));
const onLibraryRemove = (msg, sender) => mutateLibrary(sender, (lib) => removeLibraryItem(lib, msg.id));

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
  fresh.library = { ...(current.library || {}) }; // …and the Learning Library (configuration, not statistics)
  fresh.playlistMembership = { ...(current.playlistMembership || {}) }; // …and its proven playlist members (eligibility, not statistics)
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
  'library:lookup': onLibraryLookup,
  'library:add': onLibraryAdd,
  'library:setEnabled': onLibrarySetEnabled,
  'library:remove': onLibraryRemove,
  'playlist:members': onPlaylistMembers,
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
async function injectIntoOpenTabs() {
  for (const cs of chrome.runtime.getManifest().content_scripts || []) {
    const files = cs.js || [];
    if (!files.length) continue;
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: cs.matches }); } catch { continue; }
    for (const tab of tabs) {
      if (tab.discarded || tab.id === undefined) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files }).catch(() => {});
    }
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
  if (details.reason === 'install' || details.reason === 'update') await injectIntoOpenTabs();
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
