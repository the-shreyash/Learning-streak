/**
 * Learning Library — the user's explicit list of learning content on platforms
 * that are never detected automatically (YouTube). Registration is the ONLY
 * authority for whether such content may produce learning time.
 *
 * state.library: { [id]: LibraryItem }
 *   {
 *     id,          // deterministic: `${platform}:${type}:${targetId}` → one entry per target
 *     platform,    // 'youtube'
 *     type,        // 'video'
 *     targetId,    // YouTube video id (11 chars)
 *     title,       // user-given title, or null (the page title is used for display)
 *     subject,     // user-given subject, or null (never inferred)
 *     enabled,     // false = kept in the library but produces no learning time
 *     createdAt,   // ms
 *   }
 *
 * All functions are pure: they return a new library map and never mutate input.
 */

import { getPlatform } from '../platforms/registry.js';
import { parseYouTubeVideoUrl, isYouTubeVideoId } from '../platforms/youtube.js';

export const MAX_LIBRARY_ITEMS = 500;
const MAX_STR = 200;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, MAX_STR);
  return s || null;
}

export const libraryItemId = (platform, type, targetId) => `${platform}:${type}:${targetId}`;

function validTarget(platform, type, targetId) {
  const p = getPlatform(platform);
  if (!p || !Array.isArray(p.registrableTypes) || !p.registrableTypes.includes(type)) return false;
  if (platform === 'youtube' && type === 'video') return isYouTubeVideoId(targetId);
  return false;
}

/** Parse a stored / imported item. Returns a clean item or null. */
export function normalizeLibraryItem(raw) {
  if (!isObj(raw)) return null;
  const { platform, type, targetId } = raw;
  if (!validTarget(platform, type, targetId)) return null;
  const createdAt = Number(raw.createdAt);
  return {
    id: libraryItemId(platform, type, targetId),
    platform,
    type,
    targetId,
    title: cleanStr(raw.title),
    subject: cleanStr(raw.subject),
    enabled: raw.enabled !== false,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
  };
}

/** Normalize a whole library map; malformed or mis-keyed entries are dropped. */
export function normalizeLibrary(raw) {
  const library = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(isObj(raw) ? raw : {})) {
    const item = normalizeLibraryItem(value);
    if (!item || item.id !== key || Object.keys(library).length >= MAX_LIBRARY_ITEMS) { dropped += 1; continue; }
    library[key] = item;
  }
  return { library, dropped };
}

const PARSE_ERRORS = {
  'not-a-url': 'That doesn\'t look like a URL. Paste a YouTube video link.',
  'not-youtube': 'Only YouTube video links can be added.',
  'playlist': 'Playlists can\'t be added yet — paste a link to a single video.',
  'shorts': 'YouTube Shorts aren\'t supported — paste a regular video link.',
  'no-video-id': 'Couldn\'t find a valid video ID in that link.',
};

/**
 * Register a YouTube video from a pasted URL.
 * @returns {{ok:true, library, item, playlistIgnored:boolean} | {ok:false, code, error, item?}}
 */
export function addYouTubeVideo(library, { url, title, subject } = {}, nowMs = Date.now()) {
  const parsed = parseYouTubeVideoUrl(url);
  if (!parsed.ok) return { ok: false, code: parsed.reason, error: PARSE_ERRORS[parsed.reason] || 'Invalid link.' };
  const id = libraryItemId('youtube', 'video', parsed.videoId);
  const current = isObj(library) ? library : {};
  if (current[id]) return { ok: false, code: 'duplicate', error: 'This video is already in your Learning Library.', item: current[id] };
  if (Object.keys(current).length >= MAX_LIBRARY_ITEMS) return { ok: false, code: 'full', error: `The Learning Library is limited to ${MAX_LIBRARY_ITEMS} items.` };
  const item = normalizeLibraryItem({ platform: 'youtube', type: 'video', targetId: parsed.videoId, title, subject, enabled: true, createdAt: nowMs });
  return { ok: true, library: { ...current, [id]: item }, item, playlistIgnored: !!parsed.playlistId };
}

export function setLibraryItemEnabled(library, id, enabled) {
  if (!isObj(library) || !library[id]) return { ok: false, code: 'not-found', error: 'Item not found.' };
  return { ok: true, library: { ...library, [id]: { ...library[id], enabled: !!enabled } } };
}

export function removeLibraryItem(library, id) {
  if (!isObj(library) || !library[id]) return { ok: false, code: 'not-found', error: 'Item not found.' };
  const next = { ...library };
  delete next[id];
  return { ok: true, library: next };
}

/** The library item registered for exactly this target (enabled or not), or null. */
export function findLibraryItem(library, platform, type, targetId) {
  if (!isObj(library) || !targetId) return null;
  const item = library[libraryItemId(platform, type, targetId)];
  return item && item.platform === platform && item.type === type && item.targetId === targetId ? item : null;
}

/**
 * Authorization for a target: 'registered' (enabled), 'disabled', or 'not-registered'.
 * This is the single rule both the content-script gate and the credit gate use.
 */
export function targetStatus(library, platform, type, targetId) {
  const item = findLibraryItem(library, platform, type, targetId);
  if (!item) return { status: 'not-registered', item: null };
  return { status: item.enabled ? 'registered' : 'disabled', item };
}

/** Newest first (UI order). */
export const libraryItemsOf = (library) => Object.values(isObj(library) ? library : {}).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

/** Merge an imported library into the current one; current entries win on conflicts. */
export function mergeLibraries(current, imported) {
  const out = { ...(isObj(imported) ? imported : {}), ...(isObj(current) ? current : {}) };
  return normalizeLibrary(out).library;
}
