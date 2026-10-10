/**
 * V2.1 Phase C — a video PROVEN once to be in a registered playlist keeps counting
 * wherever it is opened (search, recommendations, history, direct URL), through
 * the REAL content scripts and the harness's real-engine background.
 *
 * Membership is proven only by YouTube's own playlist panel (the panel is P's,
 * visible, and marks the current video). `list=P` alone proves nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './contentHarness.mjs';

const P = 'PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi';
const Q = 'PLblh5JKOoLUICTaGLRoHQDuF_7q2GfuJF';
const A = 'aircAruvnKk';
const B = 'IHZwWFHWa-w';
const C = 'Ilg3gGewQ5U';
const X = 'dQw4w9WgXcQ'; // unrelated, never in P
const PLAYLISTS = { [P]: [A, B, C, 'tIeHLnjs5U8'], [Q]: ['wjZofJX0v4M', A] };
const S = 1000;
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ≈${expected} ±${tol}, got ${actual}`);
const counted = (w) => w.content() + (w.ping().unsavedContent || 0);
const sessionsOf = (w) => w.sessions().sort((a, b) => a.startedAt - b.startedAt);

async function watch(w, ms) {
  w.play();
  await w.advance(ms);
  w.pause();
  await w.settle();
}

/** Prove P by playing A inside it, then leave the playlist (home). */
async function provenThenLeft(opts = {}) {
  const w = createWorld({ registeredPlaylists: [P], playlists: PLAYLISTS, ...opts });
  await w.open(A, { list: P });
  await watch(w, 20 * S);
  w.leaveToHome();
  await w.advance(2 * S);
  return w;
}

test('A. member opened in the playlist → tracks AND its panel\'s rendered items are persisted', async () => {
  const w = createWorld({ registeredPlaylists: [P], playlists: PLAYLISTS });
  await w.open(A, { list: P });
  await watch(w, 30 * S);
  near(w.content(), 30, 1.5);
  assert.deepEqual([...w.members(P)].sort(), [...PLAYLISTS[P]].sort());
  assert.equal(w.state().playlistMembership[P].videoIds.length, 4);
});

test('B. known member opened from SEARCH (SPA, no list=) → tracks, attributed to the playlist', async () => {
  const w = await provenThenLeft();
  await w.navigate(B); // search result → /watch?v=B
  await w.advance(3 * S);
  assert.ok(!w.panel.inDom || w.panel.hidden, 'no visible playlist panel');
  await watch(w, 40 * S);
  const sb = sessionsOf(w).find((s) => s.contentId === B);
  near(sb.contentSeconds, 40, 1.5);
  assert.equal(sb.playlistId, P);
  assert.equal(w.ping().via, 'playlist');
  assert.ok(w.credits.filter((c) => c.source.contentId === B).every((c) => c.source.playlistId === P));
});

test('C. known member opened from a RECOMMENDATION while another video plays → tracks from the swap on', async () => {
  const w = await provenThenLeft();
  await w.navigate(X);
  await w.advance(3 * S);
  w.play();
  await w.advance(10 * S);
  near(counted(w), 20, 1.5, 'X (unrelated) adds nothing');
  await w.navigate(C, { swapDelayMs: 500 }); // recommendation / autoplay
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  const sc = sessionsOf(w).find((s) => s.contentId === C);
  near(sc.contentSeconds, 29.5, 1.5);
  assert.ok(w.credits.every((c) => c.source.contentId !== X), 'not one credit for X');
});

test('D. known member opened by DIRECT URL (hard load, no list=) in a later visit → tracks', async () => {
  const w = createWorld({ registeredPlaylists: [P], playlists: PLAYLISTS, membership: { [P]: [A, B] } });
  await w.open(B);
  await watch(w, 30 * S);
  near(w.content(), 30, 1.5);
  assert.equal(w.sessions()[0].playlistId, P);
  assert.equal(w.ping().playlist.id, P);
});

test('E. FALSE POSITIVE: unrelated video opened with list=P — even with P\'s members known — never tracks or joins P', async () => {
  const w = createWorld({ registeredPlaylists: [P], playlists: PLAYLISTS, membership: { [P]: [A, B] } });
  await w.open(X, { list: P });
  assert.ok(w.panel.inDom && !w.panel.hidden && w.panel.selected === null, 'P\'s real panel, nothing selected');
  await watch(w, 60 * S);
  assert.equal(w.credits.length, 0);
  assert.equal(w.content(), 0);
  assert.equal(w.ping().reason, 'not-in-playlist');
  assert.ok(!w.members(P).includes(X));
  assert.equal(w.memberReports.length, 0, 'an unproven panel reports nothing');
});

test('F. panel visible but the current video is not the selected item → nothing tracked, nothing persisted', async () => {
  const w = createWorld({ registeredPlaylists: [P], playlists: PLAYLISTS });
  await w.open(A, { list: P, panel: 'unselected' });
  await watch(w, 30 * S);
  assert.equal(w.credits.length, 0);
  assert.deepEqual(w.members(P), []);
});

test('G. unknown video with no playlist proof → nothing', async () => {
  const w = createWorld({ registeredPlaylists: [P], playlists: PLAYLISTS, membership: { [P]: [A] } });
  await w.open(C);
  await watch(w, 30 * S);
  assert.equal(w.credits.length, 0);
  assert.equal(w.ping().reason, 'not-registered');
});

test('H. directly registered + enabled video → tracks as itself, no playlist claimed', async () => {
  const w = createWorld({ registered: [B], registeredPlaylists: [P], playlists: PLAYLISTS, membership: { [P]: [B] } });
  await w.open(B);
  await watch(w, 20 * S);
  near(w.content(), 20, 1.5);
  assert.equal(w.ping().via, 'video');
  assert.ok(w.credits.every((c) => c.source.playlistId === undefined));
});

test('I. directly registered but DISABLED video, known member of an enabled playlist → not tracked (also inside the playlist)', async () => {
  const w = createWorld({ registered: [A], disabledVideos: [A], registeredPlaylists: [P], playlists: PLAYLISTS, membership: { [P]: [A] } });
  await w.open(A);
  await watch(w, 20 * S);
  assert.equal(w.ping().reason, 'disabled');
  await w.navigate(A, { list: P });
  await w.advance(3 * S);
  await watch(w, 20 * S);
  assert.equal(w.content(), 0);
  assert.equal(w.ping().reason, 'disabled');
});

test('J. known member whose containing playlists are all disabled → not tracked', async () => {
  const w = createWorld({ registeredPlaylists: [P, Q], playlists: PLAYLISTS, membership: { [P]: [A], [Q]: [A] } });
  w.setPlaylistEnabled(P, false, { broadcast: false });
  w.setPlaylistEnabled(Q, false, { broadcast: false });
  await w.open(A);
  await watch(w, 20 * S);
  assert.equal(w.credits.length, 0);
  assert.equal(w.ping().reason, 'disabled');
});

test('J. one of its playlists still enabled → tracks, attributed to that one', async () => {
  const w = createWorld({ registeredPlaylists: [P, Q], playlists: PLAYLISTS, membership: { [P]: [A], [Q]: [A] } });
  w.setPlaylistEnabled(P, false, { broadcast: false });
  await w.open(A);
  await watch(w, 20 * S);
  near(w.content(), 20, 1.5);
  assert.equal(w.sessions()[0].playlistId, Q);
});

test('J. disabling the playlist while a known member plays outside it stops counting', async () => {
  const w = await provenThenLeft();
  await w.navigate(B);
  await w.advance(3 * S);
  w.play();
  await w.advance(20 * S);
  w.setPlaylistEnabled(P, false);
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'disabled');
  w.pause();
  await w.settle();
  const sb = sessionsOf(w).find((s) => s.contentId === B);
  assert.ok(sb.contentSeconds <= 20.5, `nothing after disabling (${sb.contentSeconds})`);
});

test('K. the panel disappears (stale and hidden) after proof → the member stays eligible', async () => {
  const w = createWorld({ registeredPlaylists: [P], playlists: PLAYLISTS });
  await w.open(A, { list: P });
  await watch(w, 10 * S);
  await w.navigate(A); // same video, `list=` dropped: the panel is hidden with stale items
  await w.advance(3 * S);
  assert.ok(w.panel.hidden);
  await watch(w, 20 * S);
  near(w.content(), 30, 2);
});

test('L. large/virtualized playlist → only the rendered window is persisted; an unseen member is not trusted', async () => {
  const big = Array.from({ length: 300 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
  const shown = big.slice(100, 200); // YouTube renders ~100 items around the current one
  const w = createWorld({ registeredPlaylists: [P], playlists: { [P]: shown } });
  await w.open(big[150], { list: P });
  await watch(w, 10 * S);
  assert.deepEqual([...w.members(P)].sort(), [...shown].sort());
  const unseen = big[250];
  assert.ok(!w.members(P).includes(unseen));
  await w.navigate(unseen); // a real member of P, but never shown by YouTube
  await w.advance(3 * S);
  await watch(w, 20 * S);
  assert.ok(w.credits.every((c) => c.source.contentId !== unseen));
});

test('M. repeated observation is idempotent — one record per video, no duplicate reports', async () => {
  const w = createWorld({ registeredPlaylists: [P], playlists: PLAYLISTS });
  await w.open(A, { list: P });
  await watch(w, 60 * S);
  await w.navigate(B, { list: P });
  await w.advance(5 * S);
  await watch(w, 30 * S);
  const ids = w.members(P);
  assert.equal(ids.length, new Set(ids).size);
  assert.equal(ids.length, 4);
  assert.equal(w.memberReports.length, 1, 'nothing new → nothing sent again');
});

test('SPA: a known member → unrelated video → the old video\'s membership never carries over', async () => {
  const w = await provenThenLeft();
  await w.navigate(B);
  await w.advance(3 * S);
  w.play();
  await w.advance(15 * S);
  await w.navigate(X, { swapDelayMs: 500 });
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  assert.ok(w.credits.every((c) => c.source.contentId !== X));
  const sb = sessionsOf(w).find((s) => s.contentId === B);
  near(sb.contentSeconds, 15, 1.5, 'the interval across the change is not counted for either video');
});

