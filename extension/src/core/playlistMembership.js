/**
 * Proven playlist membership — which video IDs YouTube itself has SHOWN to be in
 * a registered playlist (content/youtubePlaylist.js: a visible panel for P whose
 * items all link to P, with the current video marked as P's current item).
 *
 * state.playlistMembership: { [playlistId]: { videoIds: string[], updatedAt } }
 *
 * Eligibility metadata, not learning history: it never creates time or sessions;
 * it only lets a video that was once proven a member of P count when it is
 * opened elsewhere (search, home, history, direct URL) without P's panel.
 *  - Only IDs that were actually rendered in P's panel are ever added. Unseen
 *    items of a large (virtualized) playlist are never inferred.
 *  - Additive: a partial panel window never removes earlier proven members.
 *  - Only playlists registered in the Learning Library are kept; removing a
 *    playlist from the Library forgets its members.
 *  - Bounded: when full, new members are not added (undercount, never a guess).
 *
 * All functions are pure: they return new objects and never mutate input.
 */

import { isYouTubeVideoId, isYouTubePlaylistId } from '../platforms/youtube.js';

/** YouTube's own playlist size limit. */
export const MAX_MEMBERS_PER_PLAYLIST = 5000;
/** Total proven video IDs kept across all playlists (~12 bytes each in storage). */
export const MAX_MEMBERS_TOTAL = 20000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const playlistItemId = (playlistId) => `youtube:playlist:${playlistId}`;
const isRegisteredPlaylist = (library, playlistId) => {
  const item = isObj(library) ? library[playlistItemId(playlistId)] : null;
  return !!item && item.type === 'playlist' && item.targetId === playlistId;
};

function cleanIds(list, cap) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(list) ? list : []) {
    if (out.length >= cap) break;
    if (!isYouTubeVideoId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

const totalOf = (membership) => Object.values(membership).reduce((n, e) => n + e.videoIds.length, 0);

/**
 * Normalize a stored index. Entries for playlists that are not (or no longer)
 * in `library` are dropped, as are invalid IDs and duplicates.
 * @returns {{ membership, dropped:number }}
 */
export function normalizeMembership(raw, library) {
  const membership = {};
  let dropped = 0;
  let total = 0;
  for (const [playlistId, entry] of Object.entries(isObj(raw) ? raw : {})) {
    if (!isYouTubePlaylistId(playlistId) || !isRegisteredPlaylist(library, playlistId) || !isObj(entry)) { dropped += 1; continue; }
    const videoIds = cleanIds(entry.videoIds, Math.min(MAX_MEMBERS_PER_PLAYLIST, MAX_MEMBERS_TOTAL - total));
    if (!videoIds.length) { dropped += 1; continue; }
    if (videoIds.length !== (Array.isArray(entry.videoIds) ? entry.videoIds.length : 0)) dropped += 1;
    const updatedAt = Number(entry.updatedAt);
    membership[playlistId] = { videoIds, updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0 };
    total += videoIds.length;
  }
  return { membership, dropped };
}

/**
 * Merge newly proven members of `playlistId` into the index. Idempotent: IDs
 * already known are not repeated, and nothing is ever removed.
 * @returns {{ membership, added:string[] }}  `added` = IDs that were not known before
 */
export function addProvenMembers(membership, library, playlistId, videoIds, nowMs = Date.now()) {
  const current = isObj(membership) ? membership : {};
  if (!isYouTubePlaylistId(playlistId) || !isRegisteredPlaylist(library, playlistId)) return { membership: current, added: [] };
  const entry = current[playlistId];
  const known = new Set(entry ? entry.videoIds : []);
  const room = Math.min(MAX_MEMBERS_PER_PLAYLIST - known.size, MAX_MEMBERS_TOTAL - totalOf(current));
  const added = cleanIds(videoIds, Number.MAX_SAFE_INTEGER).filter((id) => !known.has(id)).slice(0, Math.max(0, room));
  if (!added.length) return { membership: current, added };
  return {
    membership: { ...current, [playlistId]: { videoIds: [...(entry ? entry.videoIds : []), ...added], updatedAt: nowMs } },
    added,
  };
}

/** Playlist IDs `videoId` has been proven a member of (sorted, deterministic). */
export function provenPlaylistsOf(membership, videoId) {
  if (!isObj(membership) || !videoId) return [];
  return Object.keys(membership).filter((p) => isObj(membership[p]) && Array.isArray(membership[p].videoIds) && membership[p].videoIds.includes(videoId)).sort();
}

/** Keep only playlists still registered in `library` (after a Library change). */
export const pruneMembership = (membership, library) => normalizeMembership(membership, library).membership;
