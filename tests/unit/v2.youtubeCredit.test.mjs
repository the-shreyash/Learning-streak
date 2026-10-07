/**
 * V2.1 Phase B — the background side of YouTube tracking: the registration gate
 * on credits (recordCredit), what a registered video's time becomes in the data
 * (session, day totals, platform attribution, course totals), and migration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const { recordCredit } = await mod('core/learningEngine.js');
const { createDefaultState } = await mod('core/schema.js');
const { addYouTubeVideo, setLibraryItemEnabled, removeLibraryItem } = await mod('core/learningLibrary.js');
const { platformBreakdownOf, dailySummary } = await mod('core/dailyAggregation.js');
const { learningSecondsOf } = await mod('core/records.js');
const { migrate } = await mod('storage/migrationService.js');
const { computeStreaks } = await mod('core/streakEngine.js');

const A = 'aircAruvnKk';
const B = 'IHZwWFHWa-w';
const T0 = localMs(2026, 10, 7, 15, 0);
const DAY = '2026-10-07';
const yt = (id, courseTitle = null) => ({ platform: 'youtube', contentType: 'video', contentId: id, courseTitle });
const UDEMY_COURSE = { key: 'ml-az', title: 'ML A-Z' };

function withVideos(...ids) {
  let s = createDefaultState();
  for (const id of ids) s = { ...s, library: addYouTubeVideo(s.library, { url: `https://youtu.be/${id}`, title: id === A ? 'Neural networks' : null, subject: id === A ? 'Deep Learning' : null }, T0).library };
  return s;
}
/** n consecutive 5 s chunks of `source` starting at `from` (content = 5 × rate). */
function play(state, source, { from, n, rate = 1 }) {
  let s = state;
  const results = [];
  for (let i = 1; i <= n; i += 1) {
    const r = recordCredit(s, { endMs: from + i * 5000, active: 5, content: 5 * rate, source });
    results.push(r);
    s = r.state;
  }
  return { state: s, results };
}
const day = (s) => s.dailyHistory[DAY];

test('gate: registered + enabled video → credited', () => {
  const { state, results } = play(withVideos(A), yt(A), { from: T0, n: 6 });
  assert.equal(results.every((r) => !r.rejected && r.targetStatus === 'registered'), true);
  assert.equal(day(state).contentSeconds, 30);
  assert.equal(day(state).actualActiveSeconds, 30);
});

test('gate: unregistered video → zero learning time, state untouched', () => {
  const s0 = withVideos(A);
  const { state, results } = play(s0, yt(B), { from: T0, n: 12 });
  assert.equal(results.every((r) => r.rejected === 'not-registered' && r.appliedSeconds === 0), true);
  assert.equal(state, s0, 'state object returned unchanged');
  assert.equal(state.dailyHistory[DAY], undefined);
  assert.deepEqual(state.sessions, {});
  assert.equal(state.meta.creditedUntil, 0, 'a rejected credit does not even move the overlap mark');
});

test('gate: nothing registered at all → every YouTube credit rejected', () => {
  const r = recordCredit(createDefaultState(), { endMs: T0, active: 5, content: 5, source: yt(A) });
  assert.equal(r.rejected, 'not-registered');
});

test('gate: disabled → rejected; re-enabled → counts again; deleted → rejected', () => {
  let s = withVideos(A);
  s = play(s, yt(A), { from: T0, n: 2 }).state;
  s = { ...s, library: setLibraryItemEnabled(s.library, `youtube:video:${A}`, false).library };
  const off = play(s, yt(A), { from: T0 + 10_000, n: 2 });
  assert.equal(off.results[0].rejected, 'disabled');
  assert.equal(day(off.state).contentSeconds, 10);
  s = { ...off.state, library: setLibraryItemEnabled(off.state.library, `youtube:video:${A}`, true).library };
  s = play(s, yt(A), { from: T0 + 20_000, n: 2 }).state;
  assert.equal(day(s).contentSeconds, 20);
  s = { ...s, library: removeLibraryItem(s.library, `youtube:video:${A}`).library };
  const gone = play(s, yt(A), { from: T0 + 30_000, n: 2 });
  assert.equal(gone.results[0].rejected, 'not-registered');
  assert.equal(day(gone.state).contentSeconds, 20, 'already-learned time stays after deletion');
});

test('gate: Udemy (automatic platform) is not affected by the library', () => {
  const r = recordCredit(createDefaultState(), { endMs: T0, active: 5, content: 5, source: { platform: 'udemy', contentType: 'course', contentId: 'ml-az', courseId: 'ml-az', courseTitle: 'ML A-Z' } });
  assert.equal(r.rejected, undefined);
  assert.equal(r.appliedSeconds, 5);
  assert.equal(r.targetStatus, undefined);
});

test('gate: malformed sources are rejected', () => {
  const s = withVideos(A);
  for (const source of [null, { platform: 'youtube', contentType: 'video' }, { platform: 'youtube', contentType: 'course', contentId: A }, { platform: 'vimeo', contentType: 'video', contentId: A }]) {
    assert.equal(recordCredit(s, { endMs: T0, active: 5, content: 5, source }).rejected, 'invalid-source');
  }
});

test('matching: A (registered) → B (unregistered) → A — only A time counts, in two sessions', () => {
  let s = withVideos(A);
  s = play(s, yt(A), { from: T0, n: 4 }).state;              // 20 s of A
  const b = play(s, yt(B), { from: T0 + 20_000, n: 6 });     // 30 s of B: rejected
  assert.equal(b.results.every((r) => r.rejected === 'not-registered'), true);
  s = play(b.state, yt(A), { from: T0 + 50_000, n: 4 }).state; // back to A
  assert.equal(day(s).contentSeconds, 40);
  assert.equal(Object.keys(s.sessions).length, 1, 'B never opened a session; A continues (<5 min gap)');
  const [session] = Object.values(s.sessions);
  assert.equal(session.contentId, A);
  assert.equal(session.contentSeconds, 40);
});

test('matching: A → B with both registered → separate sessions, no time crosses over', () => {
  let s = withVideos(A, B);
  s = play(s, yt(A), { from: T0, n: 4 }).state;
  s = play(s, yt(B), { from: T0 + 20_000, n: 2, rate: 2 }).state;
  const sessions = Object.values(s.sessions).sort((x, y) => x.startedAt - y.startedAt);
  assert.deepEqual(sessions.map((x) => [x.contentId, x.contentSeconds, x.actualActiveSeconds]), [[A, 20, 20], [B, 20, 10]]);
  assert.equal(s.courses[`youtube:video:${A}`].contentSeconds, 20);
  assert.equal(s.courses[`youtube:video:${B}`].contentSeconds, 20);
});

test('data: LearningSession carries the library title/subject (user\'s words beat the page title)', () => {
  const { state } = play(withVideos(A, B), yt(A, 'Page title from YouTube'), { from: T0, n: 3 });
  const [s] = Object.values(state.sessions);
  assert.equal(s.platform, 'youtube');
  assert.equal(s.contentType, 'video');
  assert.equal(s.contentId, A);
  assert.equal(s.courseTitle, 'Neural networks');
  assert.equal(s.subject, 'Deep Learning');
  assert.equal(s.contentSeconds, 15);
  assert.equal(s.actualActiveSeconds, 15);
  // No library title → the page's title is used.
  const other = play(withVideos(A, B), yt(B, 'Backpropagation'), { from: T0, n: 1 }).state;
  assert.equal(Object.values(other.sessions)[0].courseTitle, 'Backpropagation');
  assert.equal(other.courses[`youtube:video:${B}`].title, 'Backpropagation');
  assert.equal(other.courses[`youtube:video:${B}`].platform, 'youtube');
});

test('data: playback speed — content is speed-aware, actual is real time', () => {
  const { state } = play(withVideos(A), yt(A), { from: T0, n: 12, rate: 2 }); // 60 s real at 2x
  assert.equal(day(state).contentSeconds, 120);
  assert.equal(day(state).actualActiveSeconds, 60);
});

test('data: daily aggregation attributes YouTube time to YouTube; totals still drive goal & streak', () => {
  let s = withVideos(A);
  s = { ...s, settings: { ...s.settings, dailyGoalMinutes: 1 } };
  for (let i = 1; i <= 4; i += 1) s = recordCredit(s, { endMs: T0 + i * 5000, active: 5, content: 5, source: { platform: 'udemy', contentType: 'course', contentId: 'ml-az', courseId: 'ml-az', courseTitle: 'ML' } }).state;
  s = play(s, yt(A), { from: T0 + 20_000, n: 8 }).state;
  const breakdown = platformBreakdownOf(day(s));
  assert.equal(breakdown.udemy.contentSeconds, 20);
  assert.equal(breakdown.youtube.contentSeconds, 40);
  assert.equal(learningSecondsOf(day(s)), 60);
  const sum = dailySummary(s.dailyHistory, DAY, 60);
  assert.equal(sum.totalLearningSeconds, 60);
  assert.equal(sum.completed, true);
  assert.equal(computeStreaks(s.dailyHistory, DAY, 0).current, 1);
});

test('data: no duplicate credit — YouTube and Udemy playing at once share one wall clock', () => {
  let s = withVideos(A);
  let applied = 0;
  for (let i = 1; i <= 12; i += 1) {
    const end = T0 + i * 5000;
    const u = recordCredit(s, { endMs: end, active: 5, content: 5, course: UDEMY_COURSE, source: { platform: 'udemy', contentType: 'course', contentId: 'ml-az' } });
    const y = recordCredit(u.state, { endMs: end, active: 5, content: 5, source: yt(A) }); // same 5 s
    applied += u.appliedSeconds + y.appliedSeconds;
    s = y.state;
  }
  assert.equal(applied, 60);
  assert.equal(day(s).actualActiveSeconds, 60);
  assert.equal(day(s).contentSeconds, 60);
  // A replayed chunk (e.g. a retry after the worker restarted) is not counted twice.
  const replay = recordCredit(s, { endMs: T0 + 60_000, active: 5, content: 5, source: yt(A) });
  assert.equal(replay.rejected, 'overlap');
});

test('migration: V1 data stays intact; no YouTube sessions, platforms or library are invented', () => {
  const v1 = {
    schemaVersion: 1,
    settings: { dailyGoalMinutes: 10 },
    dailyHistory: { '2026-10-05': { watchedSeconds: 700, goalSeconds: 600, completed: true }, '2026-10-06': { watchedSeconds: 900, goalSeconds: 600, completed: true } },
    courses: { 'ml-az': { title: 'ML', totalSeconds: 1600, lastWatchedAt: 5 } },
    meta: { longestStreak: 2 },
  };
  const { state } = migrate(structuredClone(v1));
  assert.deepEqual(state.library, {});
  assert.deepEqual(state.sessions, {});
  assert.equal(state.dailyHistory['2026-10-05'].legacySeconds, 700);
  assert.equal(state.dailyHistory['2026-10-06'].legacySeconds, 900);
  assert.equal(state.dailyHistory['2026-10-06'].platforms, undefined);
  assert.equal(platformBreakdownOf(state.dailyHistory['2026-10-06']).youtube.learningSeconds, 0);
  assert.equal(platformBreakdownOf(state.dailyHistory['2026-10-06']).udemy.learningSeconds, 900);
  assert.deepEqual(Object.keys(state.courses), ['ml-az']);
  assert.equal(computeStreaks(state.dailyHistory, '2026-10-06', state.meta.longestStreak).current, 2);
});
