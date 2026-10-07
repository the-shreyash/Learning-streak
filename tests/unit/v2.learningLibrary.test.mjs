import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod } from './helpers.mjs';

const lib = await mod('core/learningLibrary.js');
const { createStorageService, memoryAdapter } = await mod('storage/storageService.js');
const { migrate } = await mod('storage/migrationService.js');
const { buildExport, validateImport, applyImport } = await mod('core/dataTransfer.js');
const { createDefaultState } = await mod('core/schema.js');

const A = 'aircAruvnKk';
const B = 'IHZwWFHWa-w';
const T = 1_760_000_000_000;
const add = (library, url, extra = {}) => lib.addYouTubeVideo(library, { url, ...extra }, T);

test('library: add a video → enabled item keyed by platform/type/videoId', () => {
  const r = add({}, `https://www.youtube.com/watch?v=${A}`, { title: '  Neural   networks ', subject: 'Deep Learning' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.item, {
    id: `youtube:video:${A}`, platform: 'youtube', type: 'video', targetId: A,
    title: 'Neural networks', subject: 'Deep Learning', enabled: true, createdAt: T,
  });
  assert.deepEqual(Object.keys(r.library), [`youtube:video:${A}`]);
  assert.equal(r.playlistIgnored, false);
});

test('library: title / subject optional; playlist part of a link is ignored', () => {
  const r = add({}, `https://youtu.be/${A}`);
  assert.equal(r.item.title, null);
  assert.equal(r.item.subject, null);
  const p = add({}, `https://www.youtube.com/watch?v=${A}&list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi`);
  assert.equal(p.ok, true);
  assert.equal(p.item.type, 'video');
  assert.equal(p.playlistIgnored, true);
});

test('library: invalid links are not registered', () => {
  for (const [url, code] of [['hello there', 'not-a-url'], ['hello', 'not-youtube'], [`https://vimeo.com/${A}`, 'not-youtube'], ['https://www.youtube.com/watch?v=ABC123', 'no-video-id'], ['https://www.youtube.com/playlist?list=PL123', 'playlist']]) {
    const r = add({}, url);
    assert.equal(r.ok, false, url);
    assert.equal(r.code, code, url);
    assert.match(r.error, /\w/);
  }
});

test('library: the same video via a different URL form is a duplicate', () => {
  const first = add({}, `https://www.youtube.com/watch?v=${A}`);
  for (const url of [`https://youtu.be/${A}`, `https://youtube.com/watch?v=${A}&t=5`, `https://m.youtube.com/watch?v=${A}`]) {
    const r = add(first.library, url, { title: 'other' });
    assert.equal(r.ok, false, url);
    assert.equal(r.code, 'duplicate');
    assert.equal(r.item.id, first.item.id);
  }
});

test('library: disable / enable / delete', () => {
  const { library, item } = add({}, `https://youtu.be/${A}`);
  const off = lib.setLibraryItemEnabled(library, item.id, false);
  assert.equal(off.library[item.id].enabled, false);
  assert.equal(library[item.id].enabled, true, 'pure: input not mutated');
  assert.equal(lib.setLibraryItemEnabled(off.library, item.id, true).library[item.id].enabled, true);
  const del = lib.removeLibraryItem(off.library, item.id);
  assert.deepEqual(del.library, {});
  assert.equal(lib.removeLibraryItem(del.library, item.id).ok, false);
  assert.equal(lib.setLibraryItemEnabled({}, 'nope', true).ok, false);
});

test('matching: registered → eligible; unregistered / disabled → not eligible', () => {
  let { library } = add({}, `https://youtu.be/${A}`);
  assert.equal(lib.targetStatus(library, 'youtube', 'video', A).status, 'registered');
  assert.equal(lib.targetStatus(library, 'youtube', 'video', B).status, 'not-registered');
  assert.equal(lib.targetStatus(library, 'youtube', 'playlist', A).status, 'not-registered');
  assert.equal(lib.targetStatus(library, 'udemy', 'video', A).status, 'not-registered');
  assert.equal(lib.targetStatus(library, 'youtube', 'video', A.toLowerCase()).status, 'not-registered'); // ids are case-sensitive
  library = lib.setLibraryItemEnabled(library, `youtube:video:${A}`, false).library;
  assert.equal(lib.targetStatus(library, 'youtube', 'video', A).status, 'disabled');
  assert.equal(lib.targetStatus(undefined, 'youtube', 'video', A).status, 'not-registered');
});

test('library: persists through the storage service (write → read → initialize)', async () => {
  const adapter = memoryAdapter({});
  const svc = createStorageService(adapter);
  await svc.initialize();
  await svc.update((s) => ({ state: { ...s, library: add(s.library, `https://youtu.be/${A}`, { title: 'NN' }).library } }));
  await svc.update((s) => ({ state: { ...s, library: add(s.library, `https://youtu.be/${B}`).library } }));
  await svc.update((s) => ({ state: { ...s, library: lib.setLibraryItemEnabled(s.library, `youtube:video:${B}`, false).library } }));
  const reread = await createStorageService(adapter).read();
  assert.equal(reread.library[`youtube:video:${A}`].title, 'NN');
  assert.equal(reread.library[`youtube:video:${B}`].enabled, false);
  assert.deepEqual(adapter.dump().library, reread.library);
});

test('library: migration normalizes — malformed / mis-keyed / foreign entries dropped, idempotent', () => {
  const good = add({}, `https://youtu.be/${A}`).item;
  const raw = { schemaVersion: 2, library: {
    [good.id]: good,
    'youtube:video:short': { platform: 'youtube', type: 'video', targetId: 'short' },
    wrongKey: { ...good },
    [`youtube:playlist:${B}`]: { platform: 'youtube', type: 'playlist', targetId: B },
    [`netflix:video:${B}`]: { platform: 'netflix', type: 'video', targetId: B },
  } };
  const m = migrate(raw);
  assert.equal(m.changed, true);
  assert.deepEqual(m.state.library, { [good.id]: good });
  assert.equal(migrate(structuredClone(m.state)).changed, false);
});

test('library: export / import round trip; merge keeps current entries; V1.2.1 files leave it alone', () => {
  let s = createDefaultState();
  s.library = add({}, `https://youtu.be/${A}`, { title: 'NN' }).library;
  const v = validateImport(JSON.stringify(buildExport(s, '2026-10-07')));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.summary.libraryItems, 1);
  assert.deepEqual(applyImport(createDefaultState(), v.data, 'replace', '2026-10-07').library, s.library);

  const current = { ...createDefaultState(), library: lib.setLibraryItemEnabled(s.library, `youtube:video:${A}`, false).library };
  current.library = add(current.library, `https://youtu.be/${B}`).library;
  const merged = applyImport(current, v.data, 'merge', '2026-10-07');
  assert.equal(merged.library[`youtube:video:${A}`].enabled, false, 'current entry wins');
  assert.ok(merged.library[`youtube:video:${B}`]);

  const v121 = buildExport(createDefaultState(), '2026-10-07');
  delete v121.library;
  delete v121.sessions;
  const old = validateImport(JSON.stringify(v121));
  assert.equal(old.ok, true);
  assert.deepEqual(applyImport(current, old.data, 'replace', '2026-10-07').library, current.library);
  assert.deepEqual(applyImport(current, old.data, 'merge', '2026-10-07').library, current.library);
  assert.equal(validateImport(JSON.stringify({ ...v121, library: [] })).ok, false);
});
