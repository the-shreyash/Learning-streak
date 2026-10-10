/**
 * V2.1 Phase C — YouTube playlist tracking through the REAL content scripts
 * (main.js + sites.js + youtubePlaylist.js), driven by contentHarness.mjs whose
 * playlist panel behaves as observed on youtube.com (see the harness header).
 *
 * Tolerance: as in Phase B, each start/stop may lose up to ≈1 s; entering a
 * playlist video additionally waits for YouTube to mark it as the current item
 * (≈2 s after the URL). Time is never gained.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './contentHarness.mjs';

const P = 'PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi'; // registered playlist
const Q = 'PLblh5JKOoLUICTaGLRoHQDuF_7q2GfuJF'; // another registered playlist (also contains A)
const A = 'aircAruvnKk';   // in P (and Q)
const B = 'IHZwWFHWa-w';   // in P
const X = 'dQw4w9WgXcQ';   // unrelated, never registered
const PLAYLISTS = { [P]: [A, B, 'Ilg3gGewQ5U', 'tIeHLnjs5U8'], [Q]: ['wjZofJX0v4M', A] };
const S = 1000;
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ≈${expected} ±${tol}, got ${actual}`);
const counted = (w) => w.content() + (w.ping().unsavedContent || 0);

async function inPlaylist(id = A, { list = P, registered = [], registeredPlaylists = [P], panel, ...opts } = {}) {
  const w = createWorld({ registered, registeredPlaylists, playlists: PLAYLISTS, ...opts });
  await w.open(id, { list, panel });
  return w;
}
const sessionsOf = (w) => w.sessions().sort((a, b) => a.startedAt - b.startedAt);

// ---- Membership ---------------------------------------------------------------------------
test('member: a video genuinely in the registered playlist counts — as that VIDEO, attributed to the playlist', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  near(w.content(), 60, 1.5);
  near(w.active(), 60, 1.5);
  assert.ok(w.credits.length > 0 && w.credits.every((c) => c.source.contentId === A && c.source.contentType === 'video' && c.source.playlistId === P));
  const [s] = sessionsOf(w);
  assert.equal(w.sessions().length, 1);
  assert.equal(s.platform, 'youtube');
  assert.equal(s.contentId, A);
  assert.equal(s.playlistId, P);
  assert.equal(s.playlistTitle, 'Playlist PLZHQO', 'the Library title');
  const p = w.ping();
  assert.equal(p.registration, 'registered');
  assert.equal(p.via, 'playlist');
  assert.equal(p.playlist.id, P);
});

test('FALSE POSITIVE: unrelated video opened with list=<registered playlist> → zero time, not one credit', async () => {
  const w = await inPlaylist(X);
  assert.ok(w.panel.inDom && !w.panel.hidden && w.panel.list === P, 'YouTube shows P\'s panel next to it');
  w.play();
  await w.advance(120 * S);
  w.pause();
  await w.settle();
  assert.equal(w.content(), 0);
  assert.equal(w.active(), 0);
  assert.equal(w.credits.length, 0);
  const p = w.ping();
  assert.equal(p.counting, false);
  assert.equal(p.reason, 'not-in-playlist');
  assert.equal(p.registration, 'not-in-playlist');
});

test('unknown membership (list=P but no panel rendered) → not counted', async () => {
  const w = await inPlaylist(A, { panel: 'none' }); // e.g. YouTube changed its layout
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  assert.equal(w.credits.length, 0);
  assert.equal(w.ping().reason, 'playlist-unverified');
});

test('unknown membership: the panel never marks the video as current → not counted', async () => {
  const w = await inPlaylist(A, { panel: 'unselected' });
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  assert.equal(w.credits.length, 0);
  assert.equal(w.ping().reason, 'playlist-unverified');
});

test('a playlist video opened directly (no list=) cannot be proven a member → not counted', async () => {
  const w = await inPlaylist(A, { list: null });
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  assert.equal(w.credits.length, 0);
  assert.equal(w.ping().reason, 'not-registered');
});

test('a playlist that is not in the Library authorizes nothing, even for its real members', async () => {
  const w = await inPlaylist(A, { registeredPlaylists: [] });
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  assert.equal(w.credits.length, 0);
  assert.equal(w.ping().reason, 'not-registered');
});

test('directly registered video counts with or without playlist context — no playlist claimed', async () => {
  const w = await inPlaylist(A, { registered: [A], registeredPlaylists: [] });
  w.play();
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 1.5);
  assert.ok(w.credits.every((c) => c.source.playlistId === undefined));
  assert.equal(w.ping().via, 'video');
});

test('direct registered video + disabled playlist → still tracked (direct registration first)', async () => {
  const w = await inPlaylist(A, { registered: [A] });
  w.setPlaylistEnabled(P, false);
  w.play();
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 1.5);
  assert.equal(w.ping().via, 'video');
});

test('disabled playlist: its members stop counting at once; re-enabled → count again', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(20 * S);
  w.setPlaylistEnabled(P, false);
  await w.advance(40 * S);
  assert.equal(w.ping().reason, 'disabled');
  near(counted(w), 20, 1.5, 'nothing while disabled');
  w.setPlaylistEnabled(P, true);
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  near(w.content(), 40, 2.5);
});

test('library: registering the playlist while a member plays starts counting', async () => {
  const w = await inPlaylist(A, { registeredPlaylists: [] });
  w.play();
  await w.advance(20 * S);
  w.registerPlaylist(P);
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  near(w.content(), 20, 1.5);
});

test('library: a missed "disabled" broadcast is caught by the background — credit rejected, tab stops', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(10 * S);
  w.setPlaylistEnabled(P, false, { broadcast: false });
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'disabled');
  w.pause();
  await w.settle();
  near(w.content(), 10, 1.5, 'only the time before disabling (rejected chunk ≤ 5 s)');
});

test('video in two registered playlists → one amount of time, one session', async () => {
  const w = await inPlaylist(A, { registeredPlaylists: [P, Q] });
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  near(w.content(), 60, 1.5);
  assert.equal(w.sessions().length, 1);
  assert.equal(w.sessions()[0].playlistId, P, 'attributed to the playlist being played');
});

// ---- SPA navigation ---------------------------------------------------------------------
test('SPA: playlist A → playlist B (same playlist) → both count; B was proven by the panel that proved A', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(30 * S);
  assert.ok(w.members(P).includes(B), 'B was rendered in P\'s panel while it proved A');
  await w.navigate(B, { list: P });
  await w.advance(1 * S);
  assert.equal(w.ping().reason, 'tracking', 'known member: no wait for YouTube to mark it current');
  await w.advance(59 * S);
  w.pause();
  await w.settle();
  const [sa, sb] = sessionsOf(w);
  assert.equal(w.sessions().length, 2);
  assert.equal(sa.contentId, A);
  assert.equal(sb.contentId, B);
  near(sa.contentSeconds, 30, 1.5);
  near(sb.contentSeconds, 60, 1.5);
  assert.ok(sb.playlistId === P && sa.playlistId === P);
});

test('SPA: playlist A → C, a member of P that the panel never rendered → waits until YouTube marks C current', async () => {
  // Large playlist: P's panel shows a window that does not include C yet.
  const C = 'Ilg3gGewQ5U';
  const w = createWorld({ registeredPlaylists: [P], playlists: { [P]: [A, B] } });
  await w.open(A, { list: P });
  w.play();
  await w.advance(30 * S);
  assert.ok(!w.members(P).includes(C), 'never inferred');
  w.panel.items.push(C); // YouTube loads C's item only when it navigates there
  await w.navigate(C, { list: P });
  await w.advance(1 * S);
  assert.equal(w.ping().reason, 'playlist-unverified', 'C is not trusted until YouTube marks it current');
  await w.advance(59 * S);
  w.pause();
  await w.settle();
  const sc = sessionsOf(w).find((s) => s.contentId === C);
  near(sc.contentSeconds, 58, 2, 'C minus the ≈2 s wait for the panel');
  assert.ok(w.members(P).includes(C), 'C is proven once YouTube marks it current');
});

test('SPA: playlist → unrelated video (list dropped) → stops; the stale hidden panel authorizes nothing', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(30 * S);
  await w.navigate(X);
  await w.advance(90 * S);
  assert.ok(w.panel.inDom && w.panel.hidden && w.panel.selected === A, 'stale panel left behind, like youtube.com');
  w.pause();
  await w.settle();
  near(w.content(), 30, 1.5);
  assert.ok(w.credits.every((c) => c.source.contentId === A));
});

test('SPA: playlist → unrelated video that KEEPS list=P → stops (not in P\'s items)', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(30 * S);
  await w.navigate(X, { list: P });
  await w.advance(90 * S);
  assert.equal(w.ping().reason, 'not-in-playlist');
  w.pause();
  await w.settle();
  near(w.content(), 30, 1.5);
  assert.ok(w.credits.every((c) => c.source.contentId === A));
});

test('SPA: unrelated → playlist video → starts once membership is shown', async () => {
  const w = await inPlaylist(X, { list: null });
  w.play();
  await w.advance(20 * S);
  await w.navigate(A, { list: P });
  await w.advance(40 * S);
  w.pause();
  await w.settle();
  near(w.content(), 38, 2.5);
  assert.ok(w.credits.every((c) => c.source.contentId === A));
});

test('SPA: A → B → A inside the playlist: every new video resolved again, separate sessions', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(20 * S);
  await w.navigate(B, { list: P });
  await w.advance(20 * S);
  await w.navigate(A, { list: P });
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  assert.deepEqual(sessionsOf(w).map((s) => s.contentId), [A, B, A]);
  near(w.content(), 56, 4);
});

test('SPA: A (playlist) → X (unrelated, no list) → A (playlist again) → stop, then track again', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(20 * S);
  await w.navigate(X);
  await w.advance(30 * S);
  near(counted(w), 20, 1.5, 'nothing for X');
  await w.navigate(A, { list: P });
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  near(w.content(), 38, 2.5);
  assert.ok(w.credits.every((c) => c.source.contentId === A));
});

test('SPA: autoplay to a video outside the playlist (no list) is never counted, even right after a member', async () => {
  const w = await inPlaylist(B);
  w.play();
  await w.advance(10 * S);
  await w.navigate(X, { swapDelayMs: 500 }); // YouTube recommendation / autoplay
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  near(w.content(), 10, 1.5);
  assert.ok(w.credits.every((c) => c.source.contentId === B));
});

// ---- Tracking rules (Phase B behaviour preserved through the playlist route) -------------
test('playback: pause / resume / seek / speed', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(20 * S);
  w.pause();
  await w.advance(30 * S);
  near(counted(w), 20, 1.5, 'pause');
  w.play();
  await w.advance(10 * S);
  w.seekTo(w.video.currentTime + 300);
  await w.advance(10 * S);
  near(counted(w), 40, 2.5, 'seek jump not counted');
  w.rate(2);
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  near(w.content(), 100, 4, '2× → content doubles');
  near(w.active(), 70, 3, 'actual = real time');
});

test('background tab with throttled timers and window blur: genuine progress counts', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(10 * S);
  w.hide();
  w.blur();
  w.throttleMs = 60 * S;
  await w.advance(120 * S);
  w.show();
  w.focus();
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 140, 2.5);
});

test('lock, sleep, frozen/stalled: no time; nothing invented on wake', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(10 * S);
  w.lock(true);
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'locked');
  w.lock(false);
  await w.advance(10 * S);
  w.asleep = true;
  await w.advance(10 * 60 * S);
  w.asleep = false;
  await w.advance(10 * S);
  w.stalled = true;
  await w.advance(30 * S);
  w.stalled = false;
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 40, 3);
  assert.ok(w.active() < 44, `no fabricated actual time (${w.active()})`);
});

test('end: counting stops when the playlist video ends', async () => {
  const w = await inPlaylist(A, { duration: 30 });
  w.play();
  await w.advance(90 * S);
  await w.settle();
  near(w.content(), 30, 1.5);
  assert.equal(w.ping().reason, 'ended');
});

test('ads inside a playlist video are not counted', async () => {
  const w = await inPlaylist(A);
  w.play();
  await w.advance(10 * S);
  w.ad(true);
  await w.advance(20 * S);
  w.ad(false);
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 20, 2);
});
