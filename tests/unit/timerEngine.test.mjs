import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const { applyCredit, applyGoalChange, markCelebrationShown, addSecondsToDay } = await mod('core/timerEngine.js');
const { createDefaultState } = await mod('core/schema.js');
const { computeStreaks } = await mod('core/streakEngine.js');

/**
 * Feed `minutes` of REAL watching in 5-second chunks ending at consecutive
 * instants from startMs, at playback `rate` (content = 5 s × rate per chunk).
 */
function watch(state, startMs, minutes, course = { key: 'ml-az', title: 'Machine Learning A-Z' }, rate = 1) {
  let s = state;
  const events = [];
  const chunks = Math.round((minutes * 60) / 5);
  for (let i = 1; i <= chunks; i += 1) {
    const r = applyCredit(s, { endMs: startMs + i * 5000, active: 5, content: 5 * rate, course });
    s = r.state;
    events.push(...r.completedDays);
  }
  return { state: s, events };
}

test('Case 1: 30 min, browser closed, 30 min later → 60 min, goal complete', () => {
  process.env.TZ = 'Asia/Kolkata';
  let s = createDefaultState();
  s = watch(s, localMs(2026, 10, 6, 9, 0), 30).state;
  assert.equal(s.dailyHistory['2026-10-06'].completed, false);
  const r = watch(s, localMs(2026, 10, 6, 18, 0), 30);
  const day = r.state.dailyHistory['2026-10-06'];
  assert.equal(Math.round(day.contentSeconds), 3600);
  assert.equal(day.completed, true);
  assert.deepEqual(r.events, ['2026-10-06']); // transition reported exactly once
});

test('Case 2: 59 min → incomplete', () => {
  process.env.TZ = 'Asia/Kolkata';
  const s = watch(createDefaultState(), localMs(2026, 10, 6, 9, 0), 59).state;
  assert.equal(s.dailyHistory['2026-10-06'].completed, false);
  assert.equal(Math.round(s.dailyHistory['2026-10-06'].contentSeconds), 3540);
});

test('Case 3: beyond goal → stays complete, time keeps growing, no duplicate completion event', () => {
  process.env.TZ = 'Asia/Kolkata';
  const r = watch(createDefaultState(), localMs(2026, 10, 6, 9, 0), 90);
  assert.equal(r.state.dailyHistory['2026-10-06'].completed, true);
  assert.equal(Math.round(r.state.dailyHistory['2026-10-06'].contentSeconds), 5400);
  assert.deepEqual(r.events, ['2026-10-06']);
  assert.equal(Math.round(r.state.courses['ml-az'].contentSeconds), 5400);
});

test('Case 7: 11:40 PM → 12:10 AM is split by real timestamps', () => {
  process.env.TZ = 'Asia/Kolkata';
  const s = watch(createDefaultState(), localMs(2026, 10, 6, 23, 40), 30).state;
  assert.equal(Math.round(s.dailyHistory['2026-10-06'].contentSeconds), 1200);
  assert.equal(Math.round(s.dailyHistory['2026-10-07'].contentSeconds), 600);
});

test('a single chunk straddling midnight is split to the second', () => {
  process.env.TZ = 'UTC';
  const r = applyCredit(createDefaultState(), { endMs: Date.parse('2026-12-31T00:00:02Z'), active: 5, content: 5 });
  assert.equal(r.state.dailyHistory['2026-12-30'].contentSeconds, 3);
  assert.equal(r.state.dailyHistory['2026-12-31'].contentSeconds, 2);
});

test('overlapping credit (same wall-clock time from two tabs) is never double counted', () => {
  process.env.TZ = 'UTC';
  const end = Date.parse('2026-10-06T10:00:05Z');
  let r = applyCredit(createDefaultState(), { endMs: end, active: 5, content: 5 });
  r = applyCredit(r.state, { endMs: end, active: 5, content: 5 });
  assert.equal(r.appliedSeconds, 0);
  r = applyCredit(r.state, { endMs: end + 2000, active: 5, content: 5 }); // overlaps 3 s
  assert.equal(r.appliedSeconds, 2);
  assert.equal(r.appliedContent, 2); // content clipped in proportion
  assert.equal(r.state.dailyHistory['2026-10-06'].contentSeconds, 7);
});

test('clock moved backwards (>10 min) does not block future credit', () => {
  process.env.TZ = 'UTC';
  const end = Date.parse('2026-10-06T10:00:00Z');
  let r = applyCredit(createDefaultState(), { endMs: end, seconds: 5 });
  r = applyCredit(r.state, { endMs: end - 3600_000, seconds: 5 });
  assert.equal(r.appliedSeconds, 5);
});

test('invalid credit is rejected; oversized credit is capped', () => {
  const s = createDefaultState();
  assert.equal(applyCredit(s, { endMs: Date.now(), seconds: -3 }).appliedSeconds, 0);
  assert.equal(applyCredit(s, { endMs: Date.now(), seconds: NaN }).appliedSeconds, 0);
  assert.equal(applyCredit(s, { endMs: 'x', seconds: 5 }).appliedSeconds, 0);
  assert.equal(applyCredit(s, { endMs: Date.now(), seconds: 99999 }).appliedSeconds, 120);
});

test('applyCredit does not mutate the input state', () => {
  const s = createDefaultState();
  const snapshot = JSON.stringify(s);
  applyCredit(s, { endMs: Date.now(), seconds: 5, course: { key: 'x', title: 'X' } });
  assert.equal(JSON.stringify(s), snapshot);
});

test('a day keeps the goal it was created with; goal change affects only today', () => {
  process.env.TZ = 'UTC';
  let s = watch(createDefaultState(), Date.parse('2026-10-05T09:00:00Z'), 40).state; // yesterday, 40/60
  s = watch(s, Date.parse('2026-10-06T09:00:00Z'), 35).state; // today 35/60
  const r = applyGoalChange(s, 30, '2026-10-06');
  assert.equal(r.state.dailyHistory['2026-10-05'].goalSeconds, 3600);
  assert.equal(r.state.dailyHistory['2026-10-06'].goalSeconds, 1800);
  assert.equal(r.state.dailyHistory['2026-10-06'].completed, true);
  assert.deepEqual(r.completedDays, ['2026-10-06']);
  // Raising the goal after completion does not un-complete today.
  const r2 = applyGoalChange(r.state, 120, '2026-10-06');
  assert.equal(r2.state.dailyHistory['2026-10-06'].completed, true);
  assert.equal(r2.state.dailyHistory['2026-10-06'].goalSeconds, 1800);
  // New days use the new goal.
  const r3 = applyCredit(r2.state, { endMs: Date.parse('2026-10-07T09:00:05Z'), seconds: 5 });
  assert.equal(r3.state.dailyHistory['2026-10-07'].goalSeconds, 7200);
});

test('longestStreak in meta is maintained and never decreases', () => {
  process.env.TZ = 'UTC';
  let s = createDefaultState();
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) s = addSecondsToDay(s, d, 3600).state;
  assert.equal(s.meta.longestStreak, 3);
  s = addSecondsToDay(s, '2026-10-06', 3600).state; // gap → current 1
  assert.equal(s.meta.longestStreak, 3);
  assert.equal(computeStreaks(s.dailyHistory, '2026-10-06', s.meta.longestStreak).current, 1);
});

test('celebration flag is set once per day', () => {
  let s = addSecondsToDay(createDefaultState(), '2026-10-06', 3600).state;
  let r = markCelebrationShown(s, '2026-10-06');
  assert.equal(r.changed, true);
  assert.equal(r.state.dailyHistory['2026-10-06'].celebrationShown, true);
  r = markCelebrationShown(r.state, '2026-10-06');
  assert.equal(r.changed, false);
  assert.equal(markCelebrationShown(s, '2026-01-01').changed, false);
});

test('course info is sanitized and stored minimally', () => {
  const r = applyCredit(createDefaultState(), { endMs: Date.now(), seconds: 5, course: { key: 'react-course', title: '  React   — The Complete Guide  ', email: 'x@y.z' } });
  assert.deepEqual(Object.keys(r.state.courses['react-course']).sort(), ['actualActiveSeconds', 'contentSeconds', 'lastWatchedAt', 'title']);
  assert.equal(r.state.courses['react-course'].title, 'React — The Complete Guide');
  const r2 = applyCredit(createDefaultState(), { endMs: Date.now(), seconds: 5, course: { key: '', title: 'x' } });
  assert.deepEqual(r2.state.courses, {});
});
