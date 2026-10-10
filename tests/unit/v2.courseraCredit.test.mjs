/**
 * V2.2 — Coursera credit through the REAL Learning Engine / storage code:
 * automatic platform (no Learning Library), per-lecture sessions, per-course
 * totals, platform sub-ledger, import/export and migration. Udemy / YouTube unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const { recordCredit } = await mod('core/learningEngine.js');
const { createDefaultState } = await mod('core/schema.js');
const { addYouTubeVideo } = await mod('core/learningLibrary.js');
const { platformBreakdownOf, dailySummary } = await mod('core/dailyAggregation.js');
const { learningSecondsOf } = await mod('core/records.js');
const { migrate } = await mod('storage/migrationService.js');
const { buildExport, validateImport, applyImport } = await mod('core/dataTransfer.js');
const { sourceFromLegacyCourse } = await mod('platforms/udemy.js');

const T0 = localMs(2026, 10, 9, 15, 0);
const DAY = '2026-10-09';
const lecture = (itemId, courseSlug = 'learning-how-to-learn') => ({
  platform: 'coursera', contentType: 'course', contentId: courseSlug, courseId: courseSlug,
  courseTitle: 'Learning How To Learn', lessonId: itemId, lessonTitle: `Lecture ${itemId}`,
});
const A = lecture('75EsZ');
const B = lecture('1bYD5');

function play(state, source, { from, n, rate = 1 }) {
  let s = state;
  for (let i = 1; i <= n; i += 1) {
    const r = recordCredit(s, { endMs: from + i * 5000, active: 5, content: 5 * rate, source });
    assert.equal(r.rejected, undefined, `chunk ${i} rejected: ${r.rejected}`);
    s = r.state;
  }
  return s;
}
const sessionsOf = (s) => Object.values(s.sessions || {}).sort((a, b) => a.startedAt - b.startedAt);

test('coursera credit: counts automatically (no Library registration) into day, platform and course totals', () => {
  const s = play(createDefaultState(T0), A, { from: T0, n: 12 }); // 1 min
  const day = s.dailyHistory[DAY];
  assert.equal(day.contentSeconds, 60);
  assert.equal(day.platforms.coursera.contentSeconds, 60);
  assert.equal(day.platforms.coursera.actualActiveSeconds, 60);
  const course = s.courses['coursera:course:learning-how-to-learn'];
  assert.equal(course.contentSeconds, 60);
  assert.equal(course.platform, 'coursera');
  assert.equal(course.title, 'Learning How To Learn');
  assert.deepEqual(Object.keys(s.library), [], 'nothing registered');
});

test('coursera credit: playback speed — content is speed-aware, active is real time', () => {
  const s = play(createDefaultState(T0), A, { from: T0, n: 12, rate: 2 });
  assert.equal(s.dailyHistory[DAY].platforms.coursera.contentSeconds, 120);
  assert.equal(s.dailyHistory[DAY].platforms.coursera.actualActiveSeconds, 60);
});

test('coursera credit: each lecture gets its own session; same course total', () => {
  let s = play(createDefaultState(T0), A, { from: T0, n: 6 });
  s = play(s, B, { from: T0 + 30_000, n: 4 });
  s = play(s, A, { from: T0 + 50_000, n: 2 });
  const list = sessionsOf(s);
  assert.deepEqual(list.map((x) => x.lessonId), ['75EsZ', '1bYD5', '75EsZ'], 'a lecture change always starts a new session');
  assert.deepEqual(list.map((x) => x.contentSeconds), [30, 20, 10]);
  assert.ok(list.every((x) => x.platform === 'coursera' && x.contentId === 'learning-how-to-learn' && x.courseId === 'learning-how-to-learn'));
  assert.equal(list[1].lessonTitle, 'Lecture 1bYD5');
  assert.equal(s.courses['coursera:course:learning-how-to-learn'].contentSeconds, 60);
});

test('coursera credit: an overlapping / replayed chunk is never counted twice', () => {
  let s = play(createDefaultState(T0), A, { from: T0, n: 2 });
  const r = recordCredit(s, { endMs: T0 + 10_000, active: 5, content: 5, source: B }); // same instant, other lecture
  s = r.state;
  assert.equal(s.dailyHistory[DAY].contentSeconds, 10);
  assert.equal(sessionsOf(s).reduce((a, x) => a + x.contentSeconds, 0), 10);
});

test('coursera credit: a Udemy course with the same slug keeps a separate total', () => {
  let s = play(createDefaultState(T0), A, { from: T0, n: 2 });
  const udemy = sourceFromLegacyCourse({ key: 'learning-how-to-learn', title: 'Udemy course' });
  s = recordCredit(s, { endMs: T0 + 20_000, active: 5, content: 5, source: udemy }).state;
  assert.equal(s.courses['coursera:course:learning-how-to-learn'].contentSeconds, 10);
  assert.equal(s.courses['learning-how-to-learn'].contentSeconds, 5);
  assert.equal(s.courses['learning-how-to-learn'].platform, undefined, 'Udemy keeps the V1 course shape');
  const b = platformBreakdownOf(s.dailyHistory[DAY]);
  assert.equal(b.coursera.learningSeconds, 10);
  assert.equal(b.udemy.learningSeconds, 5);
  assert.equal(b.youtube.learningSeconds, 0);
  assert.equal(learningSecondsOf(s.dailyHistory[DAY]), 15);
});

test('coursera credit: unsupported content types / malformed sources are rejected', () => {
  const s0 = createDefaultState(T0);
  for (const source of [
    { ...A, contentType: 'video' },
    { ...A, contentType: 'playlist' },
    { ...A, platform: 'courseraa' },
    null,
  ]) {
    const r = recordCredit(s0, { endMs: T0 + 5000, active: 5, content: 5, source });
    assert.equal(r.rejected, 'invalid-source');
    assert.equal(r.state, s0);
  }
});

test('coursera credit: YouTube stays opt-in and Udemy unchanged alongside Coursera', () => {
  let s = createDefaultState(T0);
  s = { ...s, library: addYouTubeVideo(s.library, { url: 'https://youtu.be/aircAruvnKk' }, T0).library };
  s = play(s, A, { from: T0, n: 2 });
  const yt = recordCredit(s, { endMs: T0 + 20_000, active: 5, content: 5, source: { platform: 'youtube', contentType: 'video', contentId: 'dQw4w9WgXcQ' } });
  assert.equal(yt.rejected, 'not-registered', 'unregistered YouTube video still rejected');
  s = recordCredit(s, { endMs: T0 + 25_000, active: 5, content: 5, source: { platform: 'youtube', contentType: 'video', contentId: 'aircAruvnKk' } }).state;
  s = recordCredit(s, { endMs: T0 + 30_000, active: 5, content: 5, source: sourceFromLegacyCourse({ key: 'ml-az', title: 'ML' }) }).state;
  const sum = dailySummary(s.dailyHistory, DAY, 3600);
  assert.deepEqual(sum.platforms.map((p) => [p.platform, p.label, p.learningSeconds]), [['udemy', 'Udemy', 5], ['youtube', 'YouTube', 5], ['coursera', 'Coursera', 10]]);
  assert.equal(sum.totalLearningSeconds, 20);
});

test('coursera storage: export → import round-trips Coursera sessions, platform ledger and course totals', () => {
  let s = play(createDefaultState(T0), A, { from: T0, n: 4 });
  s = play(s, B, { from: T0 + 20_000, n: 2 });
  const payload = JSON.parse(JSON.stringify(buildExport(s, DAY, T0)));
  const v = validateImport(payload);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const restored = applyImport(createDefaultState(T0), v.data, 'replace', DAY, T0);
  assert.deepEqual(restored.dailyHistory[DAY].platforms.coursera, s.dailyHistory[DAY].platforms.coursera);
  assert.equal(restored.courses['coursera:course:learning-how-to-learn'].platform, 'coursera');
  assert.deepEqual(sessionsOf(restored).map((x) => x.lessonId), ['75EsZ', '1bYD5']);
});

test('coursera storage: migration keeps Coursera data as is and invents nothing for older data', () => {
  let s = play(createDefaultState(T0), A, { from: T0, n: 4 });
  const { state, changed } = migrate(structuredClone(s), T0);
  assert.equal(changed, false, 'no schema bump, no rewrite needed');
  assert.equal(state.schemaVersion, s.schemaVersion);
  assert.deepEqual(state.sessions, s.sessions);
  assert.deepEqual(state.dailyHistory, s.dailyHistory);
  assert.deepEqual(state.courses, s.courses);

  // Pre-Coursera (V1.2.1-shaped) data: no Coursera time or sessions appear.
  const old = { schemaVersion: 2, settings: { dailyGoalMinutes: 60 }, dailyHistory: { '2026-10-08': { contentSeconds: 600, actualActiveSeconds: 600, goalSeconds: 3600, completed: false } }, courses: { 'ml-az': { title: 'ML', contentSeconds: 600, actualActiveSeconds: 600, lastWatchedAt: 1 } }, meta: {} };
  const m = migrate(old, T0).state;
  assert.deepEqual(m.sessions, {});
  assert.equal(m.dailyHistory['2026-10-08'].platforms, undefined);
  assert.equal(platformBreakdownOf(m.dailyHistory['2026-10-08']).coursera.learningSeconds, 0);
  assert.equal(platformBreakdownOf(m.dailyHistory['2026-10-08']).udemy.learningSeconds, 600);
});
