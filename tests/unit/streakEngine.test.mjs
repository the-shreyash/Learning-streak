import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, historyOf } from './helpers.mjs';

const { computeStreaks, longestRun, isDayCompleted } = await mod('core/streakEngine.js');

test('no history → zero streak', () => {
  const s = computeStreaks({}, '2026-10-06');
  assert.equal(s.current, 0);
  assert.equal(s.longest, 0);
  assert.equal(s.todayCompleted, false);
  assert.equal(s.nextIfCompletedToday, 1);
});

test('first completed day → streak 1', () => {
  const s = computeStreaks(historyOf(['2026-10-06']), '2026-10-06');
  assert.equal(s.current, 1);
  assert.equal(s.longest, 1);
  assert.equal(s.todayCompleted, true);
});

test('second consecutive day → streak 2', () => {
  assert.equal(computeStreaks(historyOf(['2026-10-05', '2026-10-06']), '2026-10-06').current, 2);
});

test('streak continuation Oct 1–5 = 5', () => {
  const h = historyOf(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  assert.equal(computeStreaks(h, '2026-10-05').current, 5);
});

test('today not yet done: yesterday-ending streak stays alive and is "at risk"', () => {
  const h = historyOf(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  const s = computeStreaks(h, '2026-10-06');
  assert.equal(s.current, 5);
  assert.equal(s.atRisk, true);
  assert.equal(s.nextIfCompletedToday, 6);
});

test('missed day breaks the streak; next completed day = 1', () => {
  const h = historyOf(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  // Oct 6 missed. On Oct 7 before completing:
  let s = computeStreaks(h, '2026-10-07');
  assert.equal(s.current, 0);
  assert.equal(s.atRisk, false);
  // After completing Oct 7:
  h['2026-10-07'] = { watchedSeconds: 3700, goalSeconds: 3600, completed: true };
  s = computeStreaks(h, '2026-10-07');
  assert.equal(s.current, 1);
  assert.equal(s.longest, 5);
});

test('partial day (59 min) does not count', () => {
  const h = historyOf(['2026-10-05'], { '2026-10-06': 3599 });
  const s = computeStreaks(h, '2026-10-06');
  assert.equal(s.todayCompleted, false);
  assert.equal(s.current, 1); // alive via yesterday
  assert.equal(computeStreaks(h, '2026-10-07').current, 0); // Oct 6 incomplete → broken
});

test('multiple missed days', () => {
  const h = historyOf(['2026-09-20', '2026-09-21', '2026-09-22', '2026-10-06']);
  assert.equal(computeStreaks(h, '2026-10-06').current, 1);
  assert.equal(computeStreaks(h, '2026-10-06').longest, 3);
  assert.equal(computeStreaks(historyOf(['2026-09-20']), '2026-10-06').current, 0);
});

test('longest streak never decreases (stored value respected)', () => {
  const s = computeStreaks(historyOf(['2026-10-06']), '2026-10-06', 21);
  assert.equal(s.longest, 21);
  assert.equal(longestRun(historyOf(['2026-10-01', '2026-10-02', '2026-10-04'])), 2);
});

test('streak across month and year boundaries', () => {
  assert.equal(computeStreaks(historyOf(['2026-09-29', '2026-09-30', '2026-10-01']), '2026-10-01').current, 3);
  assert.equal(computeStreaks(historyOf(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']), '2027-01-02').current, 4);
  assert.equal(computeStreaks(historyOf(['2028-02-28', '2028-02-29', '2028-03-01']), '2028-03-01').current, 3);
});

test('browser opened after midnight: streak derived from dates, not sessions', () => {
  // Completed Oct 5 late at night, browser opened on Oct 6 at 00:05.
  const s = computeStreaks(historyOf(['2026-10-04', '2026-10-05']), '2026-10-06');
  assert.equal(s.current, 2);
  assert.equal(s.atRisk, true);
});

test('completion is sticky even if goalSeconds later exceeds watched', () => {
  assert.equal(isDayCompleted({ watchedSeconds: 3600, goalSeconds: 5400, completed: true }), true);
  assert.equal(isDayCompleted({ watchedSeconds: 3600, goalSeconds: 3600 }), true);
  assert.equal(isDayCompleted({ watchedSeconds: 3599.9, goalSeconds: 3600 }), false);
  assert.equal(isDayCompleted(undefined), false);
});

test('future-dated records (clock moved back) do not inflate current streak', () => {
  const h = historyOf(['2026-10-10', '2026-10-05']);
  const s = computeStreaks(h, '2026-10-06');
  assert.equal(s.current, 1);
});
