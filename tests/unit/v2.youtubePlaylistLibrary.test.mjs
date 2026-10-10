/**
 * V2.1 Phase C — playlists in the Learning Library (add / enable / disable /
 * delete / persist / migrate / export-import) and the background credit gate:
 * matching priority, disabled playlists, multiple playlists, sessions and daily totals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const lib = await mod('core/learningLibrary.js');
const { recordCredit } = await mod('core/learningEngine.js');
const { createDefaultState } = await mod('core/schema.js');
const { createStorageService, memoryAdapter } = await mod('storage/storageService.js');
const { migrate } = await mod('storage/migrationService.js');
const { buildExport, validateImport, applyImport } = await mod('core/dataTransfer.js');
const { platformBreakdownOf, dailySummary } = await mod('core/dailyAggregation.js');
const { normalizeSessions } = await mod('core/learningSession.js');

const P = 'PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi';
const Q = 'PLblh5JKOoLUICTaGLRoHQDuF_7q2GfuJF';
const A = 'aircAruvnKk';
const B = 'IHZwWFHWa-w';
const T = localMs(2026, 10, 7, 15, 0);
const DAY = '2026-10-07';
const pl = (id) => `https://www.youtube.com/playlist?list=${id}`;
const addPl = (library, id, extra = {}) => lib.addYouTubePlaylist(library, { url: pl(id), ...extra }, T);

function stateWith({ videos = [], playlists = [] } = {}) {
  let s = createDefaultState(T);
  for (const id of videos) s = { ...s, library: lib.addYouTubeVideo(s.library, { url: `https://youtu.be/${id}` }, T).library };
  for (const [id, title, subject] of playlists) s = { ...s, library: addPl(s.library, id, { title, subject }).library };
  return s;
}
const yt = (id, playlistId, playlistTitle = null) => ({ platform: 'youtube', contentType: 'video', contentId: id, ...(playlistId ? { playlistId, playlistTitle } : {}) });
function play(state, source, { from, n }) {
  let s = state;
  const results = [];
  for (let i = 1; i <= n; i += 1) {
    const r = recordCredit(s, { endMs: from + i * 5000, active: 5, content: 5, source });
    results.push(r);
    s = r.state;
  }
  return { state: s, results };
}

// ---- Library ----------------------------------------------------------------------------
test('library: add a playlist → enabled item of type "playlist" keyed by the playlist ID', () => {
  const r = addPl({}, P, { title: ' Machine  Learning Course ', subject: 'ML' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.item, {
    id: `youtube:playlist:${P}`, platform: 'youtube', type: 'playlist', targetId: P,
    title: 'Machine Learning Course', subject: 'ML', enabled: true, createdAt: T,
  });
  assert.equal(addPl({}, P).item.title, null, 'title optional');
});

test('library: addYouTubeContent routes playlist pages to playlists and video links (even with &list=) to videos', () => {
  const p = lib.addYouTubeContent({}, { url: `${pl(P)}&si=x` }, T);
  assert.equal(p.item.type, 'playlist');
  assert.equal(p.item.targetId, P);
  const v = lib.addYouTubeContent({}, { url: `https://www.youtube.com/watch?v=${A}&list=${P}` }, T);
  assert.equal(v.item.type, 'video');
  assert.equal(v.item.targetId, A, 'the first video is not registered as a playlist, nor the playlist as a video');
  assert.equal(v.playlistIgnored, true);
  for (const [url, code] of [['nope', 'not-youtube'], [pl('RDdQw4w9WgXcQ'), 'auto-playlist'], [pl('WL'), 'auto-playlist'], [`${pl(P)}&list=${Q}`, 'ambiguous'], [pl(''), 'no-playlist-id']]) {
    const r = lib.addYouTubeContent({}, { url }, T);
    assert.equal(r.ok, false, url);
    assert.equal(r.code, code, url);
    assert.ok(r.error.length > 10);
  }
});

test('library: duplicate playlists are rejected; a playlist and a video are different targets', () => {
  const first = addPl({}, P);
  const dup = addPl(first.library, P);
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'duplicate');
  assert.equal(addPl(first.library, P + '').ok, false);
  assert.equal(lib.addYouTubePlaylist(first.library, { url: `https://m.youtube.com/playlist?list=${P}&si=1` }, T).code, 'duplicate', 'same ID, another link form');
  const withVideo = lib.addYouTubeVideo(first.library, { url: `https://youtu.be/${A}` }, T);
  assert.equal(withVideo.ok, true);
  assert.deepEqual(Object.keys(withVideo.library).sort(), [`youtube:playlist:${P}`, `youtube:video:${A}`]);
  assert.equal(addPl(withVideo.library, Q).ok, true, 'a second playlist');
});

test('library: disable / enable / delete a playlist', () => {
  const id = `youtube:playlist:${P}`;
  let library = addPl({}, P).library;
  library = lib.setLibraryItemEnabled(library, id, false).library;
  assert.equal(library[id].enabled, false);
  assert.equal(lib.targetStatus(library, 'youtube', 'playlist', P).status, 'disabled');
  library = lib.setLibraryItemEnabled(library, id, true).library;
  assert.equal(lib.targetStatus(library, 'youtube', 'playlist', P).status, 'registered');
  library = lib.removeLibraryItem(library, id).library;
  assert.deepEqual(library, {});
  assert.equal(lib.targetStatus(library, 'youtube', 'playlist', P).status, 'not-registered');
});

test('library: a playlist ID is never matched as a video and vice versa', () => {
  const library = addPl({}, P).library;
  assert.equal(lib.targetStatus(library, 'youtube', 'video', P).status, 'not-registered');
  assert.equal(lib.normalizeLibraryItem({ platform: 'youtube', type: 'playlist', targetId: A }), null, 'a video ID is not a playlist ID');
  assert.equal(lib.normalizeLibraryItem({ platform: 'youtube', type: 'video', targetId: P }), null);
  assert.equal(lib.normalizeLibraryItem({ platform: 'youtube', type: 'playlist', targetId: 'RDMM' }), null, 'stored Mix entries are dropped');
});

test('persistence: playlists survive a storage round trip next to videos', async () => {
  const storage = createStorageService(memoryAdapter());
  await storage.initialize();
  await storage.update((s) => ({ state: { ...s, library: lib.addYouTubeVideo(addPl(s.library, P, { title: 'ML' }).library, { url: `https://youtu.be/${A}` }, T).library } }));
  const back = await storage.read();
  assert.equal(back.library[`youtube:playlist:${P}`].title, 'ML');
  assert.equal(back.library[`youtube:video:${A}`].type, 'video');
});

test('migration: Phase B libraries (videos only) are untouched; playlist items are kept; junk dropped', () => {
  const phaseB = migrate(stateWith({ videos: [A, B] }), T);
  const again = migrate(phaseB.state, T);
  assert.deepEqual(again.state.library, phaseB.state.library);
  assert.equal(again.changed, false, 'idempotent');
  const withPl = stateWith({ videos: [A], playlists: [[P, 'Course', null]] });
  withPl.library['youtube:playlist:RDMM'] = { platform: 'youtube', type: 'playlist', targetId: 'RDMM', enabled: true, createdAt: T };
  const m = migrate(withPl, T);
  assert.deepEqual(Object.keys(m.state.library).sort(), [`youtube:playlist:${P}`, `youtube:video:${A}`]);
});

test('export / import: playlists and playlist-attributed sessions round trip; merge keeps current items', () => {
  let s = stateWith({ playlists: [[P, 'Course', 'ML']] });
  s = play(s, yt(A, P, 'Neural networks'), { from: T, n: 2 }).state;
  const file = JSON.stringify(buildExport(s, DAY, T));
  const v = validateImport(file);
  assert.equal(v.ok, true, String(v.errors));
  const fresh = applyImport(createDefaultState(T), v.data, 'replace', DAY, T);
  assert.deepEqual(fresh.library, s.library);
  const [session] = Object.values(fresh.sessions);
  assert.equal(session.contentId, A);
  assert.equal(session.playlistId, P);
  assert.equal(session.playlistTitle, 'Course');

  const current = { ...createDefaultState(T), library: lib.setLibraryItemEnabled(addPl({}, P).library, `youtube:playlist:${P}`, false).library };
  const merged = applyImport(current, v.data, 'merge', DAY, T);
  assert.equal(merged.library[`youtube:playlist:${P}`].enabled, false, 'current entry wins on merge');
});

test('sessions: a malformed playlistId is dropped on import, the session itself is kept', () => {
  const { sessions } = normalizeSessions({ s1: { id: 's1', platform: 'youtube', contentType: 'video', contentId: A, playlistId: 'bad id!', playlistTitle: 'x', startedAt: T, endedAt: T + 5000, contentSeconds: 5, actualActiveSeconds: 5 } });
  assert.equal(sessions.s1.contentId, A);
  assert.equal(sessions.s1.playlistId, undefined);
  assert.equal(sessions.s1.playlistTitle, undefined);
});

// ---- Credit gate: matching priority ----------------------------------------------------------
test('gate: proven member of an enabled playlist → credited to the VIDEO, playlist attributed', () => {
  const { state, results } = play(stateWith({ playlists: [[P, 'Machine Learning Course', 'ML']] }), yt(A, P, 'Neural networks'), { from: T, n: 6 });
  assert.ok(results.every((r) => !r.rejected && r.targetStatus === 'registered' && r.playlistStatus === 'registered' && r.videoStatus === 'not-registered'));
  assert.equal(state.dailyHistory[DAY].contentSeconds, 30);
  const sessions = Object.values(state.sessions);
  assert.equal(sessions.length, 1, 'one session');
  assert.equal(sessions[0].platform, 'youtube');
  assert.equal(sessions[0].contentType, 'video');
  assert.equal(sessions[0].contentId, A, 'the video actually learned from, not the playlist');
  assert.equal(sessions[0].playlistId, P);
  assert.equal(sessions[0].playlistTitle, 'Machine Learning Course', 'the user\'s own title wins');
  assert.equal(sessions[0].subject, 'ML');
  assert.equal(sessions[0].contentSeconds, 30);
});

test('gate: without the user\'s title, the playlist title YouTube showed is kept; with neither, none is invented', () => {
  const r1 = play(stateWith({ playlists: [[P]] }), yt(A, P, 'Neural networks'), { from: T, n: 1 });
  assert.equal(Object.values(r1.state.sessions)[0].playlistTitle, 'Neural networks');
  const r2 = play(stateWith({ playlists: [[P]] }), yt(A, P), { from: T, n: 1 });
  assert.equal(Object.values(r2.state.sessions)[0].playlistTitle, undefined);
});

test('gate: a credit without proven membership (no playlistId) for an unregistered video → rejected', () => {
  const s0 = stateWith({ playlists: [[P]] });
  const { state, results } = play(s0, yt(B), { from: T, n: 4 });
  assert.ok(results.every((r) => r.rejected === 'not-registered' && r.appliedSeconds === 0));
  assert.equal(state, s0);
});

test('gate: a playlist that is not registered, or disabled, authorizes nothing', () => {
  const s0 = stateWith({ playlists: [[Q]] });
  assert.equal(play(s0, yt(A, P), { from: T, n: 1 }).results[0].rejected, 'not-registered');
  const off = { ...s0, library: lib.setLibraryItemEnabled(s0.library, `youtube:playlist:${Q}`, false).library };
  const r = play(off, yt(A, Q), { from: T, n: 2 });
  assert.ok(r.results.every((x) => x.rejected === 'disabled' && x.playlistStatus === 'disabled'));
  assert.equal(r.state.dailyHistory[DAY], undefined);
});

test('gate: directly registered video counts even when its playlist is disabled (direct registration first)', () => {
  let s = stateWith({ videos: [A], playlists: [[P]] });
  s = { ...s, library: lib.setLibraryItemEnabled(s.library, `youtube:playlist:${P}`, false).library };
  const direct = play(s, yt(A), { from: T, n: 2 });
  assert.ok(direct.results.every((r) => r.targetStatus === 'registered'));
  const viaDisabled = play(direct.state, yt(A, P), { from: T + 10_000, n: 2 });
  assert.ok(viaDisabled.results.every((r) => r.targetStatus === 'registered' && r.videoStatus === 'registered'));
  assert.equal(viaDisabled.state.dailyHistory[DAY].contentSeconds, 20);
  const [session] = Object.values(viaDisabled.state.sessions);
  assert.equal(session.playlistId, undefined, 'a direct video claims no playlist credit');
});

test('gate: a video the user disabled is not switched back on by an enabled playlist', () => {
  let s = stateWith({ videos: [A], playlists: [[P]] });
  s = { ...s, library: lib.setLibraryItemEnabled(s.library, `youtube:video:${A}`, false).library };
  const r = play(s, yt(A, P), { from: T, n: 2 });
  assert.ok(r.results.every((x) => x.rejected === 'disabled'));
  assert.equal(play(s, yt(B, P), { from: T, n: 1 }).results[0].targetStatus, 'registered', 'other members still count');
});

test('gate: video in two registered playlists → one amount of time, never doubled', () => {
  const s0 = stateWith({ playlists: [[P, 'Machine Learning'], [Q, 'Deep Learning']] });
  // One tab measures one interval once, attributed to the playlist in its URL context.
  let s = play(s0, yt(A, P), { from: T, n: 6 }).state;
  // A replayed chunk for the same instants via the OTHER playlist (e.g. two tabs) adds nothing.
  s = play(s, yt(A, Q), { from: T, n: 6 }).state;
  assert.equal(s.dailyHistory[DAY].contentSeconds, 30);
  assert.equal(platformBreakdownOf(s.dailyHistory[DAY]).youtube.contentSeconds, 30);
});

test('gate: a "playlist" credit (contentType playlist) is never accepted — time belongs to a video', () => {
  const s0 = stateWith({ playlists: [[P]] });
  const r = recordCredit(s0, { endMs: T + 5000, active: 5, content: 5, source: { platform: 'youtube', contentType: 'playlist', contentId: P } });
  assert.equal(r.rejected, 'not-registered');
  assert.equal(r.state, s0);
});

test('sessions: moving between playlist videos → one session per video, no duplicates', () => {
  let s = stateWith({ playlists: [[P]] });
  s = play(s, yt(A, P), { from: T, n: 4 }).state;
  s = play(s, yt(B, P), { from: T + 20_000, n: 4 }).state;
  s = play(s, yt(A, P), { from: T + 40_000, n: 4 }).state;
  const sessions = Object.values(s.sessions).sort((a, b) => a.startedAt - b.startedAt);
  assert.deepEqual(sessions.map((x) => x.contentId), [A, B, A]);
  assert.ok(sessions.every((x) => x.playlistId === P && x.contentSeconds === 20));
  assert.equal(s.dailyHistory[DAY].contentSeconds, 60);
});

// ---- Daily aggregation -----------------------------------------------------------------------
test('daily: Udemy 30 + YouTube direct 10 + YouTube playlist 20 = 60 min → goal complete, no duplicate credit', () => {
  let s = stateWith({ videos: [A], playlists: [[P], [Q]] });
  s = { ...s, settings: { ...s.settings, dailyGoalMinutes: 60 } };
  const MIN = 60_000;
  // Real tabs send ≤ 5 s chunks; `minutes` of them starting at startMs.
  const chunk = (state, source, startMs, minutes) => play(state, source, { from: startMs, n: minutes * 12 }).state;
  s = chunk(s, { platform: 'udemy', contentType: 'course', contentId: 'ml-az', courseTitle: 'ML A-Z' }, T, 30);
  s = chunk(s, yt(A), T + 30 * MIN, 10);
  // The playlist video plays in two tabs at once, under two registered playlists:
  // every 5 s instant arrives twice (P, then Q) — it must count once.
  for (let i = 1; i <= 20 * 12; i += 1) {
    for (const via of [P, Q]) s = recordCredit(s, { endMs: T + 40 * MIN + i * 5000, active: 5, content: 5, source: yt(B, via) }).state;
  }
  const rec = s.dailyHistory[DAY];
  assert.equal(rec.contentSeconds, 3600);
  assert.equal(rec.completed, true);
  const byPlatform = platformBreakdownOf(rec);
  assert.equal(byPlatform.udemy.contentSeconds, 1800);
  assert.equal(byPlatform.youtube.contentSeconds, 1800, 'direct 10 min + playlist 20 min');
  const sessions = Object.values(s.sessions).filter((x) => x.contentId === B);
  assert.equal(sessions.reduce((t, x) => t + x.contentSeconds, 0), 1200, 'the duplicates added no session time');
  assert.ok(sessions.every((x) => x.playlistId === P), 'the duplicate (Q) instants were rejected as overlap');
  assert.equal(dailySummary(s.dailyHistory, DAY, 3600).completed, true);
});
