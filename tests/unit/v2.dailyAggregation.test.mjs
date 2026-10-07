import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const { recordLearning } = await mod('core/learningEngine.js');
const { dailySummary, platformBreakdownOf } = await mod('core/dailyAggregation.js');
const { createDefaultState } = await mod('core/schema.js');
const { computeStreaks } = await mod('core/streakEngine.js');
const { learningSecondsOf } = await mod('core/records.js');

const UDEMY = { platform: 'udemy', contentType: 'course', contentId: 'ml-az', courseId: 'ml-az', courseTitle: 'ML A-Z' };
const ytVideo = (id) => ({ platform: 'youtube', contentType: 'video', contentId: id });
const DAY = '2026-10-06';

/** Watch `minutes` of content at 1x ending after `startMs`, in 60 s chunks. */
function watch(state, source, startMs, minutes) {
  let s = state;
  for (let i = 1; i <= minutes; i += 1) s = recordLearning(s, { endMs: startMs + i * 60_000, active: 60, content: 60, source }).state;
  return s;
}
const minutes = (sec) => Math.round(sec / 60);

test('aggregation: Udemy 35 min + YouTube 20 min = 55 / 60', () => {
  let s = createDefaultState();
  s = watch(s, UDEMY, localMs(2026, 10, 6, 9), 35);
  s = watch(s, ytVideo('abc'), localMs(2026, 10, 6, 14), 20);
  const d = dailySummary(s.dailyHistory, DAY, 3600);
  assert.deepEqual(d.platforms.map((p) => [p.label, minutes(p.learningSeconds)]), [['Udemy', 35], ['YouTube', 20]]);
  assert.equal(minutes(d.totalLearningSeconds), 55);
  assert.equal(d.goalSeconds, 3600);
  assert.equal(d.completed, false);
  assert.ok(Math.abs(d.progress - 55 / 60) < 1e-9);
});

test('aggregation: multiple YouTube sessions add up without duplication', () => {
  let s = createDefaultState();
  s = watch(s, ytVideo('a'), localMs(2026, 10, 6, 9), 10);
  s = watch(s, ytVideo('b'), localMs(2026, 10, 6, 11), 15);
  s = watch(s, ytVideo('a'), localMs(2026, 10, 6, 13), 5);
  const sessions = Object.values(s.sessions);
  assert.equal(sessions.length, 3);
  const b = platformBreakdownOf(s.dailyHistory[DAY]);
  assert.equal(minutes(b.youtube.learningSeconds), 30);
  assert.equal(b.udemy.learningSeconds, 0);
  assert.equal(sessions.reduce((a, x) => a + x.contentSeconds, 0), b.youtube.contentSeconds);
  assert.equal(learningSecondsOf(s.dailyHistory[DAY]), 30 * 60);
});

test('aggregation: per-platform totals always sum to the day total (multiple platforms, legacy time)', () => {
  let s = createDefaultState();
  // A V1.2.1 day that already has Udemy content + V1 legacy time, then V2 credit on both platforms.
  s.dailyHistory[DAY] = { contentSeconds: 600, actualActiveSeconds: 900, legacySeconds: 300, goalSeconds: 3600, completed: false };
  s = watch(s, UDEMY, localMs(2026, 10, 6, 9), 5);
  s = watch(s, ytVideo('x'), localMs(2026, 10, 6, 10), 7);
  const rec = s.dailyHistory[DAY];
  const b = platformBreakdownOf(rec);
  assert.equal(b.udemy.learningSeconds, 600 + 300 + 300); // pre-V2 content + legacy + new Udemy
  assert.equal(b.youtube.learningSeconds, 420);
  assert.equal(b.udemy.learningSeconds + b.youtube.learningSeconds, learningSecondsOf(rec));
  assert.equal(b.udemy.actualActiveSeconds + b.youtube.actualActiveSeconds, rec.actualActiveSeconds);
});

test('aggregation: V1 day records (no platforms) are attributed to Udemy only', () => {
  const rec = { contentSeconds: 1200, actualActiveSeconds: 900, legacySeconds: 100, goalSeconds: 3600, completed: false };
  const b = platformBreakdownOf(rec);
  assert.equal(b.udemy.learningSeconds, 1300);
  assert.equal(b.youtube.learningSeconds, 0);
  assert.deepEqual(dailySummary({ [DAY]: rec }, DAY, 3600).platforms.map((p) => p.platform), ['udemy']);
  assert.deepEqual(dailySummary({}, DAY, 3600).platforms, []);
});

test('aggregation: goal completed by combining platforms drives the streak', () => {
  let s = createDefaultState();
  s.dailyHistory['2026-10-05'] = { contentSeconds: 3600, actualActiveSeconds: 3600, goalSeconds: 3600, completed: true };
  s = watch(s, UDEMY, localMs(2026, 10, 6, 9), 35);
  assert.equal(computeStreaks(s.dailyHistory, DAY).todayCompleted, false);
  s = watch(s, ytVideo('abc'), localMs(2026, 10, 6, 14), 25);
  const d = dailySummary(s.dailyHistory, DAY, 3600);
  assert.equal(d.completed, true);
  assert.equal(d.progress, 1);
  const streak = computeStreaks(s.dailyHistory, DAY, s.meta.longestStreak);
  assert.equal(streak.current, 2);
  assert.equal(s.meta.longestStreak, 2);
});
