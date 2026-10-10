/**
 * V2.1 Phase C — the proven playlist membership index (core/playlistMembership.js)
 * and how it authorizes credit: eligibility precedence, no false positives,
 * bounded / idempotent storage, migration and import/export.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const lib = await mod('core/learningLibrary.js');
const pm = await mod('core/playlistMembership.js');
const { recordCredit } = await mod('core/learningEngine.js');
const { createDefaultState } = await mod('core/schema.js');
const { migrate } = await mod('storage/migrationService.js');
const { createStorageService, memoryAdapter } = await mod('storage/storageService.js');
const { buildExport, validateImport, applyImport } = await mod('core/dataTransfer.js');

const P = 'PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi';
const Q = 'PLblh5JKOoLUICTaGLRoHQDuF_7q2GfuJF';
const R = 'PLoROMvodv4rMiGQp3WXShtMGgzqpfVfbU'; // never registered
const A = 'aircAruvnKk';
const B = 'IHZwWFHWa-w';
const X = 'dQw4w9WgXcQ';
const T = localMs(2026, 10, 7, 15, 0);
const DAY = '2026-10-07';

function stateWith({ videos = [], playlists = [], disabled = [], members = {} } = {}) {
  let s = createDefaultState(T);
  for (const id of videos) s = { ...s, library: lib.addYouTubeVideo(s.library, { url: `https://youtu.be/${id}` }, T).library };
  for (const id of playlists) s = { ...s, library: lib.addYouTubePlaylist(s.library, { url: `https://www.youtube.com/playlist?list=${id}`, title: `Course ${id.slice(0, 4)}` }, T).library };
  for (const id of disabled) s = { ...s, library: lib.setLibraryItemEnabled(s.library, id, false).library };
  for (const [list, ids] of Object.entries(members)) s = { ...s, playlistMembership: pm.addProvenMembers(s.playlistMembership, s.library, list, ids, T).membership };
  return s;
}
const yt = (id, playlistId) => ({ platform: 'youtube', contentType: 'video', contentId: id, ...(playlistId ? { playlistId } : {}) });
const credit = (state, source, endMs = T + 5000) => recordCredit(state, { endMs, active: 5, content: 5, source });

// ---- The index ------------------------------------------------------------------------------
test('index: proven members are stored per registered playlist, with a timestamp', () => {
  const s = stateWith({ playlists: [P] });
  const r = pm.addProvenMembers(s.playlistMembership, s.library, P, [A, B], T);
  assert.deepEqual(r.added, [A, B]);
  assert.deepEqual(r.membership, { [P]: { videoIds: [A, B], updatedAt: T } });
});

test('M. repeated observation is idempotent — no duplicates, no rewrite', () => {
  const s = stateWith({ playlists: [P], members: { [P]: [A, B] } });
  const again = pm.addProvenMembers(s.playlistMembership, s.library, P, [B, A, A], T + 1000);
  assert.deepEqual(again.added, []);
  assert.equal(again.membership, s.playlistMembership, 'unchanged object: nothing to write');
  const more = pm.addProvenMembers(s.playlistMembership, s.library, P, [A, X, X], T + 2000);
  assert.deepEqual(more.added, [X]);
  assert.deepEqual(more.membership[P].videoIds, [A, B, X]);
});

test('L. a partial window never removes earlier proven members; only given IDs are added', () => {
  const window1 = Array.from({ length: 100 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
  const window2 = Array.from({ length: 100 }, (_, i) => `vid${String(i + 60).padStart(8, '0')}`);
  let s = stateWith({ playlists: [P], members: { [P]: window1 } });
  s = { ...s, playlistMembership: pm.addProvenMembers(s.playlistMembership, s.library, P, window2, T).membership };
  assert.equal(s.playlistMembership[P].videoIds.length, 160, 'union of what was shown — nothing more, nothing lost');
  assert.ok(!s.playlistMembership[P].videoIds.includes('vid00000160'), 'unseen items never inferred');
});

test('index: only registered playlists, valid IDs; bounded per playlist and in total', () => {
  const s = stateWith({ playlists: [P] });
  assert.deepEqual(pm.addProvenMembers(s.playlistMembership, s.library, R, [A], T).added, [], 'not in the Library');
  assert.deepEqual(pm.addProvenMembers(s.playlistMembership, s.library, P, ['bad', '', null, 'x'.repeat(12), A], T).added, [A]);
  const many = Array.from({ length: pm.MAX_MEMBERS_PER_PLAYLIST + 10 }, (_, i) => `v${String(i).padStart(10, '0')}`);
  const full = pm.addProvenMembers(s.playlistMembership, s.library, P, many, T).membership;
  assert.equal(full[P].videoIds.length, pm.MAX_MEMBERS_PER_PLAYLIST);
  assert.deepEqual(pm.addProvenMembers(full, s.library, P, [A], T).added, [], 'full: undercount, never evict');
});

test('index: removing a playlist from the Library forgets its members; disabling keeps them', () => {
  const s = stateWith({ playlists: [P, Q], members: { [P]: [A], [Q]: [B] } });
  const disabled = lib.setLibraryItemEnabled(s.library, `youtube:playlist:${P}`, false).library;
  assert.deepEqual(Object.keys(pm.pruneMembership(s.playlistMembership, disabled)).sort(), [P, Q].sort());
  const removed = lib.removeLibraryItem(s.library, `youtube:playlist:${P}`).library;
  assert.deepEqual(Object.keys(pm.pruneMembership(s.playlistMembership, removed)), [Q]);
});

// ---- Eligibility precedence -----------------------------------------------------------------
test('precedence: direct registration → direct disabled → known membership → live proof → not eligible', () => {
  const s = stateWith({ videos: [A, B], playlists: [P, Q], disabled: [`youtube:video:${B}`], members: { [P]: [A, B, X] } });
  // H. direct, enabled
  assert.deepEqual([lib.authorizeYouTubeVideo(s.library, A, null, s.playlistMembership).via], ['video']);
  // I. direct, disabled — even though B is a known member of enabled P, and even when played inside P
  assert.equal(lib.authorizeYouTubeVideo(s.library, B, null, s.playlistMembership).status, 'disabled');
  assert.equal(lib.authorizeYouTubeVideo(s.library, B, P, s.playlistMembership).status, 'disabled');
  // known membership, no `list=`
  const x = lib.authorizeYouTubeVideo(s.library, X, null, s.playlistMembership);
  assert.deepEqual([x.status, x.via, x.playlistId], ['registered', 'playlist', P]);
  // live proof only
  const live = lib.authorizeYouTubeVideo(s.library, 'Ilg3gGewQ5U', Q, s.playlistMembership);
  assert.deepEqual([live.status, live.via, live.playlistId], ['registered', 'playlist', Q]);
  // G. never proven
  assert.equal(lib.authorizeYouTubeVideo(s.library, 'Ilg3gGewQ5U', null, s.playlistMembership).status, 'not-registered');
});

test('one enabled playlist among several is enough; all disabled → not eligible (J)', () => {
  const s = stateWith({ playlists: [P, Q], disabled: [`youtube:playlist:${P}`], members: { [P]: [A], [Q]: [A] } });
  const one = lib.authorizeYouTubeVideo(s.library, A, null, s.playlistMembership);
  assert.deepEqual([one.status, one.playlistId], ['registered', Q]);
  const all = { ...s, library: lib.setLibraryItemEnabled(s.library, `youtube:playlist:${Q}`, false).library };
  assert.equal(lib.authorizeYouTubeVideo(all.library, A, null, all.playlistMembership).status, 'disabled');
  assert.deepEqual(lib.knownMembership(all.library, all.playlistMembership, A), { status: 'disabled', playlistId: null, title: null });
  // …unless the video has its own enabled registration
  const own = { ...all, library: lib.addYouTubeVideo(all.library, { url: `https://youtu.be/${A}` }, T).library };
  assert.equal(lib.authorizeYouTubeVideo(own.library, A, null, own.playlistMembership).via, 'video');
});

test('knownMembership(): what the content script is told about a video', () => {
  const s = stateWith({ playlists: [P], members: { [P]: [A] } });
  assert.deepEqual(lib.knownMembership(s.library, s.playlistMembership, A), { status: 'registered', playlistId: P, title: 'Course PLZH' });
  assert.equal(lib.knownMembership(s.library, s.playlistMembership, X), null);
});

// ---- Background credit gate ------------------------------------------------------------------
test('B/C/D. credit for a known member WITHOUT list= is accepted and attributed to the playlist', () => {
  const s = stateWith({ playlists: [P], members: { [P]: [A] } });
  const r = credit(s, yt(A));
  assert.equal(r.rejected, undefined);
  assert.equal(r.appliedContent, 5);
  assert.equal(r.state.dailyHistory[DAY].contentSeconds, 5);
  const [session] = Object.values(r.state.sessions);
  assert.equal(session.contentId, A);
  assert.equal(session.playlistId, P);
  assert.equal(session.playlistTitle, 'Course PLZH');
});

test('E/G. FALSE POSITIVE: an unknown video is rejected without list= — membership of OTHER videos changes nothing', () => {
  const s = stateWith({ playlists: [P], members: { [P]: [A, B] } });
  const r = credit(s, yt(X));
  assert.equal(r.rejected, 'not-registered');
  assert.equal(r.state, s);
  assert.equal(r.state.dailyHistory[DAY], undefined);
});

test('I. directly disabled video: rejected even as a known member of an enabled playlist', () => {
  const s = stateWith({ videos: [A], playlists: [P], disabled: [`youtube:video:${A}`], members: { [P]: [A] } });
  assert.equal(credit(s, yt(A)).rejected, 'disabled');
  assert.equal(credit(s, yt(A, P)).rejected, 'disabled');
});

test('J. known member whose playlists are all disabled → rejected', () => {
  const s = stateWith({ playlists: [P], disabled: [`youtube:playlist:${P}`], members: { [P]: [A] } });
  assert.equal(credit(s, yt(A)).rejected, 'disabled');
  assert.equal(credit(s, yt(A, P)).rejected, 'disabled');
});

test('a claimed live playlist that is disabled does not block an enabled known membership', () => {
  const s = stateWith({ playlists: [P, Q], disabled: [`youtube:playlist:${Q}`], members: { [P]: [A] } });
  const r = credit(s, yt(A, Q));
  assert.equal(r.rejected, undefined);
  assert.equal(Object.values(r.state.sessions)[0].playlistId, P);
});

test('known membership never creates time or sessions by itself', () => {
  const s = stateWith({ playlists: [P], members: { [P]: [A, B] } });
  assert.deepEqual(s.sessions, {});
  assert.deepEqual(s.dailyHistory, {});
});

// ---- Storage / migration / import ------------------------------------------------------------
test('migration: V1 data gains an EMPTY index; nothing else changes; no memberships fabricated', () => {
  const v121 = {
    schemaVersion: 2,
    settings: { dailyGoalMinutes: 60, notificationsEnabled: true, reminderEnabled: false, reminderTime: '20:00' },
    dailyHistory: { '2026-10-05': { contentSeconds: 3650, actualActiveSeconds: 3650, goalSeconds: 3600, completed: true } },
    courses: { ml: { title: 'ML', contentSeconds: 3650, actualActiveSeconds: 3650, lastWatchedAt: 5 } },
    meta: { longestStreak: 4, installedAt: 1, creditedUntil: 9 },
  };
  const { state, changed } = migrate(structuredClone(v121));
  assert.equal(changed, true);
  assert.equal(state.schemaVersion, 2, 'no schema bump');
  assert.deepEqual(state.playlistMembership, {});
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.dailyHistory, v121.dailyHistory);
  assert.deepEqual(state.courses, v121.courses);
});

test('migration: a valid index survives unchanged (idempotent); junk and unregistered playlists are dropped', () => {
  const s = stateWith({ playlists: [P], members: { [P]: [A, B] } });
  const once = migrate(structuredClone(s));
  assert.deepEqual(once.state.playlistMembership, s.playlistMembership);
  assert.equal(migrate(structuredClone(once.state)).changed, false);
  const junk = { ...s, playlistMembership: { [P]: { videoIds: [A, A, 'bad', B], updatedAt: T }, [R]: { videoIds: [X], updatedAt: T }, nope: 5 } };
  const fixed = migrate(structuredClone(junk));
  assert.equal(fixed.changed, true);
  assert.deepEqual(fixed.state.playlistMembership, { [P]: { videoIds: [A, B], updatedAt: T } });
});

test('export never includes the index; import keeps this device\'s index for playlists still registered', () => {
  const s = stateWith({ playlists: [P, Q], members: { [P]: [A], [Q]: [B] } });
  const file = buildExport(s, DAY, T);
  assert.equal(file.playlistMembership, undefined);
  const v = validateImport(JSON.parse(JSON.stringify(file)));
  assert.equal(v.ok, true);
  assert.deepEqual(applyImport(s, v.data, 'merge', DAY, T).playlistMembership, s.playlistMembership);
  assert.deepEqual(applyImport(s, v.data, 'replace', DAY, T).playlistMembership, s.playlistMembership);
  // A replace import whose library lacks Q drops Q's members.
  const noQ = { ...v.data, library: lib.removeLibraryItem(v.data.library, `youtube:playlist:${Q}`).library };
  assert.deepEqual(Object.keys(applyImport(s, noQ, 'replace', DAY, T).playlistMembership), [P]);
});

test('storage: proven members are actually persisted and read back (initialize → update → fresh read)', async () => {
  const adapter = memoryAdapter();
  const storage = createStorageService(adapter);
  await storage.initialize();
  await storage.update((st) => ({ state: { ...st, library: lib.addYouTubePlaylist(st.library, { url: `https://www.youtube.com/playlist?list=${P}` }, T).library } }));
  await storage.update((st) => ({ state: { ...st, playlistMembership: pm.addProvenMembers(st.playlistMembership, st.library, P, [A, B], T).membership } }));
  assert.deepEqual(adapter.dump().playlistMembership, { [P]: { videoIds: [A, B], updatedAt: T } }, 'written to the storage area');
  const again = await createStorageService(adapter).read();
  assert.deepEqual(again.playlistMembership[P].videoIds, [A, B]);
  assert.equal(credit(again, yt(A)).rejected, undefined, 'eligible after a worker restart');
});
