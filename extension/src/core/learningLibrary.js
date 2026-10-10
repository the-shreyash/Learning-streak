/**
 * Learning Library — the user's explicit list of learning content on platforms
 * that are never detected automatically (YouTube). Registration is the ONLY
 * authority for whether such content may produce learning time.
 *
 * state.library: { [id]: LibraryItem }
 *   {
 *     id,          // deterministic: `${platform}:${type}:${targetId}` → one entry per target
 *     platform,    // 'youtube'
 *     type,        // 'video' | 'playlist'
 *     targetId,    // YouTube video id (11 chars) or playlist id (PL… / UU… / OLAK5uy_…)
 *     title,       // user-given title, or null (the page title is used for display)
 *     subject,     // user-given subject, or null (never inferred)
 *     enabled,     // false = kept in the library but produces no learning time
 *     createdAt,   // ms
 *   }
 *
 * All functions are pure: they return a new library map and never mutate input.
 */

import { getPlatform } from '../platforms/registry.js';
import { parseYouTubeVideoUrl, isYouTubeVideoId, parseYouTubePlaylistUrl, isYouTubePlaylistId } from '../platforms/youtube.js';
import { provenPlaylistsOf } from './playlistMembership.js';

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
  if (platform === 'youtube' && type === 'playlist') return isYouTubePlaylistId(targetId);
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
  'not-a-url': 'That doesn\'t look like a URL. Paste a YouTube video or playlist link.',
  'not-youtube': 'Only YouTube video and playlist links can be added.',
  'playlist': 'That\'s a playlist link — add it as a playlist.',
  'shorts': 'YouTube Shorts aren\'t supported — paste a regular video link.',
  'no-video-id': 'Couldn\'t find a valid video ID in that link.',
  // playlists
  'ambiguous': 'That playlist link is ambiguous (several playlists or a video in it) — copy the link from the playlist page.',
  'auto-playlist': 'Only regular playlists, channel uploads and albums can be added — not Mixes, Watch later, Liked videos or queues, which change by themselves.',
  'no-playlist-id': 'Couldn\'t find a valid playlist ID in that link.',
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

/**
 * Register a YouTube playlist from its playlist page URL (youtube.com/playlist?list=…).
 * @returns {{ok:true, library, item} | {ok:false, code, error, item?}}
 */
export function addYouTubePlaylist(library, { url, title, subject } = {}, nowMs = Date.now()) {
  const parsed = parseYouTubePlaylistUrl(url);
  if (!parsed.ok) return { ok: false, code: parsed.reason, error: PARSE_ERRORS[parsed.reason] || 'Invalid playlist link.' };
  const id = libraryItemId('youtube', 'playlist', parsed.playlistId);
  const current = isObj(library) ? library : {};
  if (current[id]) return { ok: false, code: 'duplicate', error: 'This playlist is already in your Learning Library.', item: current[id] };
  if (Object.keys(current).length >= MAX_LIBRARY_ITEMS) return { ok: false, code: 'full', error: `The Learning Library is limited to ${MAX_LIBRARY_ITEMS} items.` };
  const item = normalizeLibraryItem({ platform: 'youtube', type: 'playlist', targetId: parsed.playlistId, title, subject, enabled: true, createdAt: nowMs });
  return { ok: true, library: { ...current, [id]: item }, item };
}

/**
 * Register whatever a pasted YouTube link names: a playlist page
 * (youtube.com/playlist?list=…) → playlist; anything else → video (a watch URL's
 * `&list=` is ignored, exactly as in Phase B).
 */
export function addYouTubeContent(library, fields = {}, nowMs = Date.now()) {
  if (parseYouTubeVideoUrl(fields.url).reason === 'playlist') return addYouTubePlaylist(library, fields, nowMs);
  return addYouTubeVideo(library, fields, nowMs);
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

/**
 * Authorization of a YouTube video, in priority order:
 *   1. the video's own entry decides when there is one: enabled → via 'video'
 *      (whatever its playlists say), disabled → 'disabled' (the user switched off
 *      exactly this video; a playlist doesn't switch it back on)
 *   2. it was PROVEN earlier to be a member of an enabled playlist
 *      (`membership`, core/playlistMembership.js) → via 'playlist' — wherever it
 *      is opened now (search, home, history, direct URL)
 *   3. it plays as a PROVEN member of an enabled playlist right now → via 'playlist'
 *      (`playlistId` is passed only when the page proved membership)
 *   4. otherwise not authorized: 'disabled' if a playlist it belongs to (or the
 *      one it plays in) is disabled, else 'not-registered'.
 * When 2 and 3 both hold, the playlist being played gets the attribution.
 * One enabled playlist is enough; one video is authorized at most once.
 * @returns {{status, via:'video'|'playlist'|null, item, playlistId, videoStatus, playlistStatus, knownPlaylistId}}
 */
export function authorizeYouTubeVideo(library, videoId, playlistId = null, membership = null) {
  const video = targetStatus(library, 'youtube', 'video', videoId);
  const playlist = playlistId ? targetStatus(library, 'youtube', 'playlist', playlistId) : null;
  const known = provenPlaylistsOf(membership, videoId).map((id) => ({ id, ...targetStatus(library, 'youtube', 'playlist', id) }));
  const knownEnabled = known.find((k) => k.status === 'registered') || null;
  const base = { videoStatus: video.status, playlistStatus: playlist ? playlist.status : null, knownPlaylistId: knownEnabled ? knownEnabled.id : null };
  const deny = (status) => ({ ...base, status, via: null, item: null, playlistId: null });
  if (video.status === 'registered') return { ...base, status: 'registered', via: 'video', item: video.item, playlistId: null };
  if (video.status === 'disabled') return deny('disabled');
  if (playlist && playlist.status === 'registered') return { ...base, status: 'registered', via: 'playlist', item: playlist.item, playlistId };
  if (knownEnabled) return { ...base, status: 'registered', via: 'playlist', item: knownEnabled.item, playlistId: knownEnabled.id };
  return deny(playlist?.status === 'disabled' || known.some((k) => k.status === 'disabled') ? 'disabled' : 'not-registered');
}

/**
 * What the proven-membership index says about `videoId`, for the content script:
 *   { status:'registered', playlistId, title }  proven member of an enabled playlist
 *   { status:'disabled', playlistId:null, title:null }  only of disabled playlists
 *   null  never proven a member of a registered playlist
 * (The video's own entry is reported separately and always takes precedence.)
 */
export function knownMembership(library, membership, videoId) {
  const auth = authorizeYouTubeVideo(library, videoId, null, membership);
  if (auth.knownPlaylistId) {
    const p = findLibraryItem(library, 'youtube', 'playlist', auth.knownPlaylistId);
    return { status: 'registered', playlistId: auth.knownPlaylistId, title: p?.title || null };
  }
  if (provenPlaylistsOf(membership, videoId).some((id) => targetStatus(library, 'youtube', 'playlist', id).status === 'disabled')) {
    return { status: 'disabled', playlistId: null, title: null };
  }
  return null;
}

/** Newest first (UI order). */
export const libraryItemsOf = (library) => Object.values(isObj(library) ? library : {}).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));

/** Merge an imported library into the current one; current entries win on conflicts. */
export function mergeLibraries(current, imported) {
  const out = { ...(isObj(imported) ? imported : {}), ...(isObj(current) ? current : {}) };
  return normalizeLibrary(out).library;
}
