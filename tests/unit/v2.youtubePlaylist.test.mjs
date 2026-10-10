/**
 * V2.1 Phase C — playlist URLs (what can be registered) and the membership
 * resolver (content/youtubePlaylist.js) against panel DOM shaped like youtube.com's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod } from './helpers.mjs';

const yt = await mod('platforms/youtube.js');
await mod('content/youtubePlaylist.js'); // classic script: sets globalThis.__UdemyStreak.youtubePlaylist
const { resolveMembership, panelTitle } = globalThis.__UdemyStreak.youtubePlaylist;
const det = globalThis.__UdemyStreak.youtubeDetector;

const P = 'PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi'; // 3Blue1Brown "Neural networks" (real ID)
const Q = 'PLblh5JKOoLUICTaGLRoHQDuF_7q2GfuJF';
const UPLOADS = 'UU8butISFwT-Wl7EV0hUK0BQ';      // a channel's uploads (real ID)
const ALBUM = 'OLAK5uy_kXbQ7FvYzT2B0jYVQxSvCqPUAJ9mCdVg4';
const A = 'aircAruvnKk';
const B = 'IHZwWFHWa-w';
const X = 'dQw4w9WgXcQ'; // unrelated

// ---- playlist URLs ----------------------------------------------------------------
test('playlist URL: playlist pages parse to the playlist ID', () => {
  for (const url of [
    `https://www.youtube.com/playlist?list=${P}`,
    `youtube.com/playlist?list=${P}`,
    `https://m.youtube.com/playlist?list=${P}`,
    `https://www.youtube.com/playlist/?list=${P}`,
  ]) assert.deepEqual(yt.parseYouTubePlaylistUrl(url), { ok: true, playlistId: P }, url);
  assert.deepEqual(yt.parseYouTubePlaylistUrl(`https://www.youtube.com/playlist?list=${UPLOADS}`), { ok: true, playlistId: UPLOADS });
  assert.deepEqual(yt.parseYouTubePlaylistUrl(`https://www.youtube.com/playlist?list=${ALBUM}`), { ok: true, playlistId: ALBUM });
});

test('playlist URL: extra query parameters are ignored', () => {
  assert.deepEqual(yt.parseYouTubePlaylistUrl(`https://www.youtube.com/playlist?list=${P}&si=abc123&feature=shared&pp=xyz`), { ok: true, playlistId: P });
  assert.deepEqual(yt.parseYouTubePlaylistUrl(`https://www.youtube.com/playlist?si=x&list=${P}&list=${P}`), { ok: true, playlistId: P }, 'the same list twice is not ambiguous');
});

test('playlist URL: invalid, foreign and ambiguous links are rejected', () => {
  const cases = [
    ['hello there', 'not-a-url'],
    [`https://vimeo.com/playlist?list=${P}`, 'not-youtube'],
    [`https://www.youtube.com.evil.com/playlist?list=${P}`, 'not-youtube'],
    [`https://youtu.be/playlist?list=${P}`, 'not-playlist'],
    ['https://www.youtube.com/playlist', 'no-playlist-id'],
    ['https://www.youtube.com/playlist?list=', 'no-playlist-id'],
    ['https://www.youtube.com/playlist?list=PL<script>', 'no-playlist-id'],
    ['https://www.youtube.com/playlist?list=PL123', 'auto-playlist'], // too short to be a real PL id
    [`https://www.youtube.com/playlist?list=${P}&list=${Q}`, 'ambiguous'],
    [`https://www.youtube.com/playlist?list=${P}&v=${A}`, 'ambiguous'],
    [`https://www.youtube.com/@3blue1brown/playlists`, 'not-playlist'],
  ];
  for (const [url, reason] of cases) assert.deepEqual(yt.parseYouTubePlaylistUrl(url), { ok: false, reason }, url);
});

test('playlist URL: Mixes, Watch later, Liked and queues are refused (they change by themselves)', () => {
  for (const list of [`RD${X}`, 'RDMM', `RDCLAK5uy_${'a'.repeat(33)}`, 'WL', 'LL', 'LM', `TLPQ${'M'.repeat(20)}`, `FL${'a'.repeat(22)}`]) {
    assert.deepEqual(yt.parseYouTubePlaylistUrl(`https://www.youtube.com/playlist?list=${list}`), { ok: false, reason: 'auto-playlist' }, list);
    assert.equal(yt.isYouTubePlaylistId(list), false, list);
  }
});

test('playlist URL: a video URL is never read as a playlist (and keeps its video meaning)', () => {
  for (const url of [`https://www.youtube.com/watch?v=${A}&list=${P}`, `https://youtu.be/${A}?list=${P}`, `https://www.youtube.com/watch?v=${A}&list=${P}&index=1`]) {
    assert.deepEqual(yt.parseYouTubePlaylistUrl(url), { ok: false, reason: 'not-playlist' }, url);
    const v = yt.parseYouTubeVideoUrl(url);
    assert.equal(v.ok, true);
    assert.equal(v.videoId, A, 'the first video is the video, not a playlist');
  }
});

test('page location: the playlist a watch page claims (a claim only)', () => {
  const loc = (href) => { const u = new URL(href); return { href, hostname: u.hostname, pathname: u.pathname }; };
  assert.equal(det.playlistIdFromLocation(loc(`https://www.youtube.com/watch?v=${A}&list=${P}&index=1`)), P);
  assert.equal(det.playlistIdFromLocation(loc(`https://www.youtube.com/watch?v=${A}`)), null);
  assert.equal(det.playlistIdFromLocation(loc(`https://www.youtube.com/watch?v=${A}&list=RD${A}`)), null, 'a Mix is never a registrable context');
  assert.equal(det.playlistIdFromLocation(loc(`https://www.youtube.com/watch?v=${A}&list=${P}&list=${Q}`)), null, 'two lists → ambiguous');
  assert.equal(det.playlistIdFromLocation(loc(`https://www.youtube.com/playlist?list=${P}`)), null, 'not a watch page');
});

// ---- membership resolver --------------------------------------------------------------
/** A watch page whose playlist panel lists `items` of `list` (as hrefs), `selected` marked. */
function page({ list = P, items = [A, B], selected = null, hidden = false, panel = true, hrefs = null, title = 'Neural networks' } = {}) {
  const els = (hrefs || items.map((v, i) => `/watch?v=${v}&list=${list}&index=${i + 1}&pp=x`)).map((href, i) => ({
    hasAttribute: (n) => n === 'selected' && items[i] === selected,
    querySelector: (s) => (s === 'a#wc-endpoint' ? { getAttribute: (n) => (n === 'href' ? href : null) } : null),
  }));
  const panelEl = {
    hidden,
    hasAttribute: (n) => n === 'hidden' && hidden,
    querySelectorAll: (s) => (s === 'ytd-playlist-panel-video-renderer' ? els : s === 'a[href*="/playlist?list="]' ? [{ getAttribute: () => `/playlist?list=${list}`, textContent: `  ${title} ` }] : []),
  };
  return { querySelector: (s) => (panel && s === 'ytd-watch-flexy ytd-playlist-panel-renderer#playlist' ? panelEl : null) };
}

test('membership: the playing video is listed in P\'s panel and selected → member', () => {
  assert.deepEqual(resolveMembership(page({ selected: A }), A, P), { status: 'member', reason: 'panel-selected' });
  assert.equal(resolveMembership(page({ selected: B }), B, P).status, 'member');
});

test('membership: unrelated video opened with list=P (P\'s panel shown, nothing selected) → not-member', () => {
  assert.deepEqual(resolveMembership(page({ selected: null }), X, P), { status: 'not-member', reason: 'not-in-panel' });
});

test('membership: listed but not (yet) selected — SPA transition, selection still on the previous video → unknown', () => {
  assert.deepEqual(resolveMembership(page({ selected: A }), B, P), { status: 'unknown', reason: 'not-selected' });
});

test('membership: no panel, hidden (stale) panel, empty panel → unknown', () => {
  assert.deepEqual(resolveMembership(page({ panel: false }), A, P), { status: 'unknown', reason: 'no-panel' });
  assert.deepEqual(resolveMembership(page({ selected: A, hidden: true }), A, P), { status: 'unknown', reason: 'panel-hidden' }, 'stale panel left after leaving P');
  assert.deepEqual(resolveMembership(page({ items: [] }), A, P), { status: 'unknown', reason: 'panel-loading' });
});

test('membership: a panel for another playlist (or partly another) never proves membership in P', () => {
  assert.deepEqual(resolveMembership(page({ list: Q, selected: A }), A, P), { status: 'unknown', reason: 'panel-other-playlist' });
  const mixed = page({ items: [A, B], selected: A, hrefs: [`/watch?v=${A}&list=${P}`, `/watch?v=${B}&list=${Q}`] });
  assert.equal(resolveMembership(mixed, A, P).status, 'unknown');
  const noLink = page({ items: [A], selected: A, hrefs: [''] });
  assert.equal(resolveMembership(noLink, A, P).status, 'unknown', 'an item without a link');
});

test('membership: no video or no playlist context → unknown; a throwing DOM → unknown', () => {
  assert.equal(resolveMembership(page({ selected: A }), A, null).status, 'unknown');
  assert.equal(resolveMembership(page({ selected: A }), null, P).status, 'unknown');
  assert.equal(resolveMembership({ querySelector() { throw new Error('boom'); } }, A, P).status, 'unknown');
});

test('membership: large windowed panel (~100 of 2,332 items, centred on the video) → member', () => {
  const items = Array.from({ length: 99 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
  items[20] = A;
  assert.equal(resolveMembership(page({ list: UPLOADS, items, selected: A }), A, UPLOADS).status, 'member');
  assert.equal(resolveMembership(page({ list: UPLOADS, items, selected: null }), X, UPLOADS).status, 'not-member');
});

test('panel title: read only from a link to P itself, only while the panel is shown', () => {
  assert.equal(panelTitle(page(), P), 'Neural networks');
  assert.equal(panelTitle(page(), Q), null);
  assert.equal(panelTitle(page({ hidden: true }), P), null);
  assert.equal(panelTitle(page({ panel: false }), P), null);
});
