import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const S = await mod('core/learningSession.js');
const { createStorageService, memoryAdapter } = await mod('storage/storageService.js');
const { recordLearning } = await mod('core/learningEngine.js');

const YT_VIDEO = { platform: 'youtube', contentType: 'video', contentId: 'ABC123def45', courseTitle: 'Linear Regression', subject: 'Machine Learning' };
const T0 = localMs(2026, 10, 6, 15, 0);

test('LearningSession: creation fills the normalized shape', () => {
  const s = S.createSession(YT_VIDEO, { startedAt: T0, endedAt: T0 + 60_000, contentSeconds: 90, actualActiveSeconds: 60 });
  assert.equal(s.platform, 'youtube');
  assert.equal(s.contentType, 'video');
  assert.equal(s.contentId, 'ABC123def45');
  assert.equal(s.courseId, 'ABC123def45'); // a single video is its own course
  assert.equal(s.courseTitle, 'Linear Regression');
  assert.equal(s.lessonId, null);
  assert.equal(s.subject, 'Machine Learning');
  assert.equal(s.startedAt, T0);
  assert.equal(s.endedAt, T0 + 60_000);
  assert.equal(s.contentSeconds, 90);
  assert.equal(s.actualActiveSeconds, 60);
  assert.match(s.id, /^ls_/);
  // deterministic id
  assert.equal(S.createSession(YT_VIDEO, { startedAt: T0 }).id, s.id);
  assert.notEqual(S.createSession({ ...YT_VIDEO, contentId: 'other' }, { startedAt: T0 }).id, s.id);
});

test('LearningSession: invalid sources and time ranges are refused', () => {
  assert.equal(S.normalizeSource({ platform: 'netflix', contentType: 'video', contentId: 'x' }), null);
  assert.equal(S.normalizeSource({ platform: 'youtube', contentType: 'course', contentId: 'x' }), null);
  assert.equal(S.normalizeSource({ platform: 'youtube', contentType: 'video' }), null, 'registered platforms need a content id');
  assert.equal(S.normalizeSource({ platform: 'udemy', contentType: 'video', contentId: 'x' }), null);
  assert.ok(S.normalizeSource({ platform: 'udemy', contentType: 'course' }), 'automatic platforms may be unidentified (V1 behaviour)');
  assert.equal(S.normalizeSource(null), null);
  assert.throws(() => S.createSession({ platform: 'nope' }, { startedAt: T0 }));
  assert.throws(() => S.createSession(YT_VIDEO, { startedAt: T0, endedAt: T0 - 1 }));
});

test('LearningSession: serialization round-trips through JSON', () => {
  const s = S.createSession({ ...YT_VIDEO, contentType: 'playlist', contentId: 'PL123', lessonId: 'vid1', lessonTitle: '  Lesson   1 ' },
    { startedAt: T0, endedAt: T0 + 5000, contentSeconds: 5, actualActiveSeconds: 5 });
  const json = JSON.parse(JSON.stringify(S.serializeSession(s)));
  assert.equal(json.lessonTitle, 'Lesson 1');
  assert.deepEqual(S.deserializeSession(json), s);
  // null optionals are omitted from the serialized form
  const bare = S.serializeSession(S.createSession({ platform: 'udemy', contentType: 'course', contentId: 'c' }, { startedAt: T0 }));
  assert.equal('subject' in bare, false);
  assert.equal('lessonId' in bare, false);
});

test('LearningSession: malformed stored sessions are rejected', () => {
  const good = S.serializeSession(S.createSession(YT_VIDEO, { startedAt: T0, endedAt: T0 + 1000 }));
  assert.equal(S.deserializeSession({ ...good, contentSeconds: -1 }), null);
  assert.equal(S.deserializeSession({ ...good, endedAt: T0 - 1 }), null);
  assert.equal(S.deserializeSession({ ...good, platform: 'x' }), null);
  assert.equal(S.deserializeSession('x'), null);
  const { sessions, dropped } = S.normalizeSessions({ [good.id]: good, wrongKey: good, bad: { id: 'bad' } });
  assert.deepEqual(Object.keys(sessions), [good.id]);
  assert.equal(dropped, 2);
});

test('LearningSession: persisted through the storage service and survives re-read', async () => {
  const adapter = memoryAdapter();
  const svc = createStorageService(adapter);
  await svc.initialize();
  const r = await svc.update((s) => recordLearning(s, { endMs: T0, active: 60, content: 90, source: YT_VIDEO }));
  const id = r.session.id;
  assert.ok(adapter.dump().sessions[id], 'written to storage');
  const reread = await createStorageService(adapter).read();
  assert.deepEqual(S.deserializeSession(reread.sessions[id]), r.session);
  assert.equal(reread.meta.activeSessionId, id);
});
