import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const D = await mod('core/dateUtils.js');

test('toDayKey uses local date', () => {
  process.env.TZ = 'Asia/Kolkata';
  // 2026-10-05T20:00Z is 01:30 on Oct 6 in India
  assert.equal(D.toDayKey(Date.parse('2026-10-05T20:00:00Z')), '2026-10-06');
  process.env.TZ = 'America/New_York';
  assert.equal(D.toDayKey(Date.parse('2026-10-05T20:00:00Z')), '2026-10-05');
  process.env.TZ = 'UTC';
});

test('isValidDayKey rejects impossible dates and bad formats', () => {
  assert.ok(D.isValidDayKey('2026-10-06'));
  assert.ok(D.isValidDayKey('2028-02-29'));
  assert.ok(!D.isValidDayKey('2026-02-29'));
  assert.ok(!D.isValidDayKey('2026-13-01'));
  assert.ok(!D.isValidDayKey('2026-1-01'));
  assert.ok(!D.isValidDayKey('20261006'));
  assert.ok(!D.isValidDayKey(null));
  assert.ok(!D.isValidDayKey('2026-10-06T00:00'));
});

test('addDays / diffDays across month, year and leap boundaries', () => {
  assert.equal(D.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(D.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(D.addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(D.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(D.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(D.diffDays('2026-12-30', '2027-01-02'), 3);
});

test('day arithmetic is DST-safe (US spring-forward and fall-back)', () => {
  process.env.TZ = 'America/New_York';
  assert.equal(D.addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(D.addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(D.addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(D.diffDays('2026-03-01', '2026-03-31'), 30);
  process.env.TZ = 'UTC';
});

test('startOfWeek is Monday; startOfMonth', () => {
  assert.equal(D.startOfWeek('2026-10-06'), '2026-10-05'); // Tue → Mon
  assert.equal(D.startOfWeek('2026-10-11'), '2026-10-05'); // Sun → Mon
  assert.equal(D.startOfWeek('2026-10-05'), '2026-10-05');
  assert.equal(D.startOfMonth('2026-10-06'), '2026-10-01');
  assert.equal(D.weekdayMondayFirst('2026-10-01'), 3); // Thursday
});

test('splitIntervalByDay: 11:40 PM → 12:10 AM splits 20 / 10 minutes', () => {
  process.env.TZ = 'Asia/Kolkata';
  const parts = D.splitIntervalByDay(localMs(2026, 10, 6, 23, 40), localMs(2026, 10, 7, 0, 10));
  assert.deepEqual(parts, [
    { dayKey: '2026-10-06', seconds: 1200 },
    { dayKey: '2026-10-07', seconds: 600 },
  ]);
  process.env.TZ = 'UTC';
});

test('splitIntervalByDay over year end and multi-day spans', () => {
  process.env.TZ = 'Europe/Berlin';
  const parts = D.splitIntervalByDay(localMs(2026, 12, 31, 23, 0), localMs(2027, 1, 1, 0, 30));
  assert.deepEqual(parts.map((p) => [p.dayKey, p.seconds]), [['2026-12-31', 3600], ['2027-01-01', 1800]]);
  const multi = D.splitIntervalByDay(localMs(2026, 10, 1, 12), localMs(2026, 10, 3, 12));
  assert.deepEqual(multi.map((p) => p.seconds), [43200, 86400, 43200]);
  process.env.TZ = 'UTC';
});

test('splitIntervalByDay on a DST night (23h day) is still exact', () => {
  process.env.TZ = 'America/New_York';
  // 2026-03-08 has 23 hours locally.
  const parts = D.splitIntervalByDay(localMs(2026, 3, 7, 23, 0), localMs(2026, 3, 9, 1, 0));
  assert.deepEqual(parts.map((p) => [p.dayKey, p.seconds / 3600]), [['2026-03-07', 1], ['2026-03-08', 23], ['2026-03-09', 1]]);
  process.env.TZ = 'UTC';
});

test('splitCreditByDay uses the last N seconds before end', () => {
  process.env.TZ = 'UTC';
  const parts = D.splitCreditByDay(Date.parse('2026-10-07T00:00:03Z'), 5);
  assert.deepEqual(parts, [{ dayKey: '2026-10-06', seconds: 2 }, { dayKey: '2026-10-07', seconds: 3 }]);
  assert.deepEqual(D.splitCreditByDay(Date.now(), 0), []);
  assert.deepEqual(D.splitIntervalByDay(10, 5), []);
});

test('shiftMonth wraps years', () => {
  assert.deepEqual(D.shiftMonth({ year: 2026, month: 1 }, -1), { year: 2025, month: 12 });
  assert.deepEqual(D.shiftMonth({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(D.shiftMonth({ year: 2026, month: 10 }, -22), { year: 2024, month: 12 });
});
