import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const { recordLearning, SESSION_GAP_MS, MAX_SESSIONS } = await mod('core/learningEngine.js');
const { applyCredit } = await mod('core/timerEngine.js');
const { createDefaultState } = await mod('core/schema.js');
const { sourceFromLegacyCourse } = await mod('platforms/udemy.js');
const { learningSecondsOf } = await mod('core/records.js');

const UDEMY = { platform: 'udemy', contentType: 'course', contentId: 'ml-az', courseId: 'ml-az', courseTitle: 'Machine Learning A-Z' };
const YT = { platform: 'youtube', contentType: 'video', contentId: 'ABC123def45', courseTitle: 'Linear Regression' };
const T0 = localMs(2026, 10, 6, 15, 0);

/** Feed `n` consecutive 5 s chunks (content = 5 * rate). */
function play(state, source, { from, n, rate = 1 }) {
  let s = state;
  let last;
  for (let i = 1; i <= n; i += 1) {
    last = recordLearning(s, { endMs: from + i * 5000, active: 5, content: 5 * rate, source });
    s = last.state;
  }
  return { state: s, last };
}
const sessionsOf = (s) => Object.values(s.sessions || {});

test('engine: first credit starts a session', () => {
  const r = recordLearning(createDefaultState(), { endMs: T0, active: 5, content: 5, source: YT });
  assert.equal(r.appliedSeconds, 5);
  assert.equal(sessionsOf(r.state).length, 1);
  assert.equal(r.session.startedAt, T0 - 5000);
  assert.equal(r.session.endedAt, T0);
  assert.equal(r.state.meta.activeSessionId, r.session.id);
});

test('engine: continuous credits extend one session (speed-aware)', () => {
  const { state } = play(createDefaultState(), YT, { from: T0, n: 24, rate: 2 }); // 2 min at 2x
  const [s] = sessionsOf(state);
  assert.equal(sessionsOf(state).length, 1);
  assert.equal(s.actualActiveSeconds, 120);
  assert.equal(s.contentSeconds, 240);
  assert.equal(s.endedAt - s.startedAt, 120_000);
});

test('engine: a pause longer than the gap stops the session; resuming starts a new one', () => {
  let { state } = play(createDefaultState(), YT, { from: T0, n: 12 });
  const short = play(state, YT, { from: T0 + 60_000 + 60_000, n: 2 }).state; // 1 min pause → same session
  assert.equal(sessionsOf(short).length, 1);
  ({ state } = play(state, YT, { from: T0 + 60_000 + SESSION_GAP_MS + 1000, n: 2 }));
  assert.equal(sessionsOf(state).length, 2);
  const [a, b] = sessionsOf(state).sort((x, y) => x.startedAt - y.startedAt);
  assert.equal(a.actualActiveSeconds, 60);
  assert.equal(b.actualActiveSeconds, 10);
});

test('engine: switching content stops one session and starts another; returning starts a new one', () => {
  let { state } = play(createDefaultState(), UDEMY, { from: T0, n: 4 });
  ({ state } = play(state, YT, { from: T0 + 20_000, n: 4 }));
  ({ state } = play(state, UDEMY, { from: T0 + 40_000, n: 4 }));
  const list = sessionsOf(state).sort((x, y) => x.startedAt - y.startedAt);
  assert.deepEqual(list.map((s) => s.platform), ['udemy', 'youtube', 'udemy']);
  assert.ok(list.every((s) => s.actualActiveSeconds === 20));
});

test('engine: duplicate / replayed credit is never counted twice', () => {
  const credit = { endMs: T0, active: 30, content: 30, source: YT };
  const r1 = recordLearning(createDefaultState(), credit);
  const r2 = recordLearning(r1.state, credit);
  assert.equal(r2.rejected, 'overlap');
  assert.equal(r2.state, r1.state);
  // partially overlapping credit is clipped consistently in day, platform and session
  const r3 = recordLearning(r1.state, { endMs: T0 + 10_000, active: 30, content: 30, source: YT });
  assert.equal(r3.appliedSeconds, 10);
  const day = r3.state.dailyHistory['2026-10-06'];
  assert.equal(day.actualActiveSeconds, 40);
  assert.equal(day.platforms.youtube.actualActiveSeconds, 40);
  assert.equal(r3.session.actualActiveSeconds, 40);
});

test('engine: invalid sources record nothing', () => {
  const base = createDefaultState();
  for (const source of [undefined, null, { platform: 'netflix', contentType: 'video', contentId: 'x' }, { platform: 'youtube', contentType: 'video' }]) {
    const r = recordLearning(base, { endMs: T0, active: 5, content: 5, source });
    assert.equal(r.rejected, 'invalid-source');
    assert.equal(r.state, base);
  }
});

test('engine: Udemy credits produce exactly the V1.2.1 totals (parity with applyCredit)', () => {
  let v1 = createDefaultState();
  let v2 = createDefaultState();
  const course = { key: 'ml-az', title: 'Machine Learning A-Z' };
  const chunks = [[5, 5], [5, 10], [5, 7.5], [5, 0], [120, 240], [3, 3]];
  let end = localMs(2026, 10, 6, 23, 58);
  for (const [active, content] of chunks) {
    end += active * 1000;
    v1 = applyCredit(v1, { endMs: end, active, content, course }).state;
    v2 = recordLearning(v2, { endMs: end, active, content, source: sourceFromLegacyCourse(course) }).state;
  }
  for (const key of Object.keys(v1.dailyHistory)) {
    const { platforms, ...rest } = v2.dailyHistory[key];
    assert.deepEqual(rest, v1.dailyHistory[key], key);
    assert.ok(platforms.udemy);
  }
  assert.deepEqual(Object.keys(v2.dailyHistory).sort(), Object.keys(v1.dailyHistory).sort());
  assert.deepEqual(v2.courses, v1.courses); // Udemy course record shape unchanged
  assert.deepEqual(v2.meta.currentCourse, v1.meta.currentCourse);
  assert.equal(v2.meta.longestStreak, v1.meta.longestStreak);
  assert.equal(v2.meta.creditedUntil, v1.meta.creditedUntil);
});

test('engine: a Udemy credit without detected course still counts (V1 behaviour)', () => {
  const r = recordLearning(createDefaultState(), { endMs: T0, active: 5, content: 5, source: sourceFromLegacyCourse(null) });
  assert.equal(r.appliedSeconds, 5);
  assert.deepEqual(r.state.courses, {});
  assert.equal(r.session.platform, 'udemy');
});

test('engine: midnight-crossing credit is attributed to both days per platform', () => {
  const end = localMs(2026, 10, 7, 0, 0, 20);
  const r = recordLearning(createDefaultState(), { endMs: end, active: 60, content: 120, source: YT });
  const d1 = r.state.dailyHistory['2026-10-06'];
  const d2 = r.state.dailyHistory['2026-10-07'];
  assert.equal(d1.platforms.youtube.actualActiveSeconds, 40);
  assert.equal(d2.platforms.youtube.actualActiveSeconds, 20);
  assert.equal(d1.platforms.youtube.contentSeconds, 80);
  assert.equal(d2.platforms.youtube.contentSeconds, 40);
  assert.equal(r.session.actualActiveSeconds, 60);
});

test('engine: YouTube course totals are namespaced and tagged with their platform', () => {
  const r = recordLearning(createDefaultState(), { endMs: T0, active: 5, content: 5, source: { ...YT, contentType: 'playlist', contentId: 'PL123', courseTitle: 'ML Playlist', lessonId: 'v1' } });
  assert.deepEqual(Object.keys(r.state.courses), ['youtube:playlist:PL123']);
  assert.equal(r.state.courses['youtube:playlist:PL123'].platform, 'youtube');
  assert.equal(r.state.courses['youtube:playlist:PL123'].title, 'ML Playlist');
});

test('engine: session log is bounded; daily totals are unaffected by pruning', () => {
  let s = createDefaultState();
  const n = MAX_SESSIONS + 5;
  for (let i = 0; i < n; i += 1) {
    s = recordLearning(s, { endMs: T0 + i * 10_000, active: 1, content: 1, source: { ...YT, contentId: `v${i % 2}` } }).state;
  }
  assert.equal(sessionsOf(s).length, MAX_SESSIONS);
  assert.equal(learningSecondsOf(s.dailyHistory['2026-10-06']), n);
});
