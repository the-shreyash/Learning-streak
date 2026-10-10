/**
 * Playlist membership resolver — "is the video playing now really part of
 * playlist P?" — answered ONLY from what YouTube itself rendered on the watch
 * page. No network, no API, no guessing.
 *
 *   resolveMembership(doc, videoId, playlistId) → { status, reason }
 *     status 'member'      YouTube lists this video in P's panel AND marks it as the current item
 *            'not-member'  P's panel is loaded and this video is not in it
 *            'unknown'     anything else (no panel, hidden, loading, stale, other playlist)
 *   Only 'member' may authorize time. 'not-member' and 'unknown' never do.
 *
 *   provenMembers(doc, videoId, playlistId) → video IDs | null
 *     Only while resolveMembership() says 'member' (the panel is P's, visible, and
 *     marks this video as current): the IDs of the items YouTube has rendered in it.
 *     These are persisted as proven members of P (core/playlistMembership.js), so
 *     they count later wherever they are opened. Items YouTube has not loaded (long
 *     playlists render a window) are never inferred.
 *
 * What the page shows (verified on youtube.com, 2026-10-07):
 *  - `list=P` in the URL proves nothing: an unrelated video opened with `list=P`
 *    gets P's real panel ("1/10" included), but the video is NOT among its items
 *    and NO item is marked `selected`.
 *  - For a genuine member, the panel (ytd-playlist-panel-renderer#playlist in
 *    ytd-watch-flexy) lists P's items; each item's link carries `v=<id>&list=P`
 *    and the current video's item has the `selected` attribute. Long playlists
 *    (2,332 videos) load a ~100-item window that YouTube centres on the current
 *    video, so a member is in the loaded items even at position 500.
 *  - SPA navigation inside P: for ~2 s the URL already shows the new video while
 *    `selected` still marks the previous one → 'unknown' until it moves.
 *  - Leaving P: the panel stays in the DOM, `hidden`, with stale items and a
 *    stale `selected` → a hidden panel is never used.
 *  - Opening a member without `list=`: no panel → membership can't be shown here
 *    (descriptions and "From the series" links are the creator's text, not membership).
 * Every check must hold; any missing element or attribute yields 'unknown'.
 */
(function (root) {
  'use strict';
  const NS = (root.__UdemyStreak = root.__UdemyStreak || {});

  const PANEL = 'ytd-watch-flexy ytd-playlist-panel-renderer#playlist';
  const ITEM = 'ytd-playlist-panel-video-renderer';
  const MAX_ITEMS = 1000;
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  const unknown = (reason) => ({ status: 'unknown', reason });

  /** { v, list } of a panel item's own link, or null. */
  function itemTarget(item) {
    try {
      const a = item.querySelector('a#wc-endpoint');
      const href = a && a.getAttribute('href');
      if (!href) return null;
      const p = new URL(href, 'https://www.youtube.com/').searchParams;
      return { v: p.get('v'), list: p.get('list') };
    } catch { return null; }
  }

  /** { status, reason, ids } — `ids`: every rendered item's video ID when 'member'. */
  function inspect(doc, videoId, playlistId) {
    if (!videoId || !playlistId) return unknown('no-playlist');
    let panel; let items;
    try {
      panel = doc.querySelector(PANEL);
      if (!panel) return unknown('no-panel');
      if (panel.hidden || panel.hasAttribute('hidden')) return unknown('panel-hidden');
      items = panel.querySelectorAll(ITEM);
    } catch { return unknown('no-panel'); }
    if (!items || !items.length) return unknown('panel-loading');
    if (items.length > MAX_ITEMS) return unknown('panel-too-large');

    let found = false;
    let current = false;
    const ids = new Set();
    for (const item of items) {
      const t = itemTarget(item);
      // Every item must belong to P: otherwise this panel is (partly) another playlist's.
      if (!t || t.list !== playlistId) return unknown('panel-other-playlist');
      if (VIDEO_ID_RE.test(t.v || '')) ids.add(t.v);
      if (t.v === videoId) {
        found = true;
        if (item.hasAttribute('selected')) current = true;
      }
    }
    if (!found) return { status: 'not-member', reason: 'not-in-panel' };
    // YouTube marks the item it is playing. Until that mark moves to this video
    // (SPA transition), the panel may still describe the previous one.
    if (!current) return unknown('not-selected');
    return { status: 'member', reason: 'panel-selected', ids };
  }

  function resolveMembership(doc, videoId, playlistId) {
    const { status, reason } = inspect(doc, videoId, playlistId);
    return { status, reason };
  }

  function provenMembers(doc, videoId, playlistId) {
    const r = inspect(doc, videoId, playlistId);
    return r.status === 'member' ? [...r.ids] : null;
  }

  /** P's title as YouTube shows it in the panel header — only from a link to P itself. */
  function panelTitle(doc, playlistId) {
    try {
      const panel = doc.querySelector(PANEL);
      if (!panel || panel.hasAttribute('hidden')) return null;
      for (const a of panel.querySelectorAll('a[href*="/playlist?list="]')) {
        if (new URL(a.getAttribute('href'), 'https://www.youtube.com/').searchParams.get('list') !== playlistId) continue;
        const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 200) return t;
      }
    } catch { /* no title */ }
    return null;
  }

  NS.youtubePlaylist = { resolveMembership, provenMembers, panelTitle };
})(globalThis);
