import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, historyOf } from './helpers.mjs';

const S = await mod('core/statisticsEngine.js');
const F = await mod('core/format.js');

test('today / week (Mon-start) / month / all-time totals', () => {
  const h = historyOf([], { '2026-09-30': 1000, '2026-10-04': 500, '2026-10-05': 2000, '2026-10-06': 2520 });
  const s = S.computeStats(h, '2026-10-06'); // Tuesday
  assert.equal(s.today, 2520);
  assert.equal(s.week, 4520);       // Mon 5th + Tue 6th
  assert.equal(s.month, 5020);      // Oct 4, 5, 6
  assert.equal(s.allTime, 6020);
  assert.equal(s.daysLearned, 4);
});

test('activity levels relative to goal (60 min: 0 / 1–29 / 30–59 / 60+)', () => {
  const rec = (m) => ({ watchedSeconds: m * 60, goalSeconds: 3600, completed: m >= 60 });
  assert.equal(S.activityLevel(undefined, 3600), 0);
  assert.equal(S.activityLevel(rec(0), 3600), 0);
  assert.equal(S.activityLevel(rec(1), 3600), 1);
  assert.equal(S.activityLevel(rec(29), 3600), 1);
  assert.equal(S.activityLevel(rec(30), 3600), 2);
  assert.equal(S.activityLevel(rec(59), 3600), 2);
  assert.equal(S.activityLevel(rec(60), 3600), 3);
  assert.equal(S.activityLevel(rec(200), 3600), 3);
});

test('month grid is Monday-first and padded to full weeks', () => {
  const g = S.buildMonthGrid({}, 2026, 10, '2026-10-06', 3600);
  assert.equal(g.daysInMonth, 31);
  assert.equal(g.weeks[0].slice(0, 3).every((c) => c === null), true); // Oct 1 2026 = Thursday
  assert.equal(g.weeks[0][3].day, 1);
  assert.ok(g.weeks.every((w) => w.length === 7));
  const today = g.weeks.flat().find((c) => c && c.isToday);
  assert.equal(today.key, '2026-10-06');
  assert.equal(g.weeks.flat().find((c) => c && c.day === 7).isFuture, true);
});

test('February in leap and non-leap years', () => {
  assert.equal(S.buildMonthGrid({}, 2028, 2, '2028-02-01', 3600).daysInMonth, 29);
  assert.equal(S.buildMonthGrid({}, 2026, 2, '2026-02-01', 3600).daysInMonth, 28);
});

test('courses ranked by time; zero-time courses hidden', () => {
  const r = S.rankCourses({ a: { title: 'A', totalSeconds: 10 }, b: { title: 'B', totalSeconds: 300 }, c: { title: 'C', totalSeconds: 0 } });
  assert.deepEqual(r.map((c) => c.key), ['b', 'a']);
});

test('duration formatting floors minutes', () => {
  assert.equal(F.formatDuration(0), '0m');
  assert.equal(F.formatDuration(59), '0m');
  assert.equal(F.formatDuration(2580), '43m');
  assert.equal(F.formatDuration(3599), '59m');
  assert.equal(F.formatDuration(23460), '6h 31m');
  assert.equal(F.formatDuration(231480), '64h 18m');
  assert.equal(F.wholeMinutes(3599.9), 59);
});
