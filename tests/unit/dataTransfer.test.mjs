import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, historyOf } from './helpers.mjs';

const { validateImport, buildExport, applyImport } = await mod('core/dataTransfer.js');
const { createDefaultState } = await mod('core/schema.js');

function sampleExport() {
  const s = createDefaultState();
  s.dailyHistory = historyOf(['2026-10-04', '2026-10-05'], { '2026-10-06': 1200 });
  s.courses = { 'ml-az': { title: 'Machine Learning A-Z', contentSeconds: 8400, actualActiveSeconds: 6000, lastWatchedAt: 1 } };
  return buildExport(s, '2026-10-06');
}

test('export contains the documented fields', () => {
  const e = sampleExport();
  assert.equal(e.dailyGoalMinutes, 60);
  assert.equal(e.currentStreak, 2);
  assert.equal(e.longestStreak, 2);
  assert.equal(e.totalLearningSeconds, 8400);
  assert.equal(e.totalContentSeconds, 8400);
  assert.equal(e.totalActualActiveSeconds, 8400);
  assert.equal(e.schemaVersion, 2);
  assert.ok(e.dailyHistory['2026-10-05']);
  assert.equal(e.app, 'udemy-learning-streak');
});

test('round trip: export → JSON → validate → replace yields identical history', () => {
  const e = sampleExport();
  const v = validateImport(JSON.stringify(e));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.summary.days, 3);
  assert.equal(v.summary.completedDays, 2);
  const next = applyImport(createDefaultState(), v.data, 'replace', '2026-10-06');
  assert.equal(next.dailyHistory['2026-10-05'].contentSeconds, 3600);
  assert.equal(next.dailyHistory['2026-10-06'].contentSeconds, 1200);
  assert.equal(next.dailyHistory['2026-10-06'].actualActiveSeconds, 1200);
  assert.equal(next.courses['ml-az'].contentSeconds, 8400);
  assert.equal(next.courses['ml-az'].actualActiveSeconds, 6000);
  assert.equal(next.meta.longestStreak, 2);
});

test('accepts the minimal format from the spec', () => {
  const v = validateImport({ dailyGoalMinutes: 60, currentStreak: 7, longestStreak: 21, totalWatchedSeconds: 231480, dailyHistory: { '2026-10-01': { watchedSeconds: 3820, completed: true } } });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.data.dailyHistory['2026-10-01'].goalSeconds, 3600);
  // V1 watch time is preserved as legacy, not converted into invented content
  assert.equal(v.data.dailyHistory['2026-10-01'].legacySeconds, 3820);
  assert.equal(v.data.dailyHistory['2026-10-01'].contentSeconds, 0);
  assert.equal(v.data.dailyHistory['2026-10-01'].completed, true);
  assert.equal(v.summary.legacyDays, 1);
  assert.equal(v.data.longestStreak, 21);
});

test('rejects malformed files', () => {
  assert.equal(validateImport('not json').ok, false);
  assert.equal(validateImport('[]').ok, false);
  assert.equal(validateImport({}).ok, false); // no dailyHistory
  assert.equal(validateImport({ dailyHistory: [] }).ok, false);
  assert.equal(validateImport({ app: 'other-app', dailyHistory: {} }).ok, false);
  assert.equal(validateImport({ schemaVersion: 99, dailyHistory: {} }).ok, false);
  assert.equal(validateImport({ dailyGoalMinutes: 0, dailyHistory: {} }).ok, false);
  assert.equal(validateImport({ dailyGoalMinutes: 'sixty', dailyHistory: {} }).ok, false);
  assert.equal(validateImport({ longestStreak: -1, dailyHistory: {} }).ok, false);
});

test('rejects bad day records with helpful errors', () => {
  const bad = (rec, key = '2026-10-06') => validateImport({ dailyHistory: { [key]: rec } });
  assert.equal(bad({ watchedSeconds: 100 }, '2026-02-30').ok, false);
  assert.equal(bad({ watchedSeconds: 100 }, 'yesterday').ok, false);
  assert.equal(bad({ watchedSeconds: -5 }).ok, false);
  assert.equal(bad({ watchedSeconds: 90000 }).ok, false); // > 24h in a day
  assert.equal(bad({ watchedSeconds: '100' }).ok, false);
  assert.equal(bad({ watchedSeconds: 100, goalSeconds: 5 }).ok, false);
  assert.equal(bad({ watchedSeconds: 100, completed: 'yes' }).ok, false);
  assert.equal(bad(42).ok, false);
  const r = bad({ watchedSeconds: -5 });
  assert.match(r.errors[0], /2026-10-06/);
});

test('completed is recomputed when watched ≥ goal; imported days never re-celebrate', () => {
  const v = validateImport({ dailyHistory: { '2026-10-06': { watchedSeconds: 4000, goalSeconds: 3600, completed: false } } });
  assert.equal(v.data.dailyHistory['2026-10-06'].completed, true);
  assert.equal(v.data.dailyHistory['2026-10-06'].celebrationShown, true);
});

test('merge keeps the larger value per day and preserves local-only days', () => {
  const current = createDefaultState();
  current.dailyHistory = historyOf([], { '2026-10-05': 1000, '2026-10-06': 2000 });
  const v = validateImport({ dailyHistory: { '2026-10-05': { watchedSeconds: 3600 }, '2026-10-06': { watchedSeconds: 10 }, '2026-10-01': { watchedSeconds: 50 } } });
  const next = applyImport(current, v.data, 'merge', '2026-10-06');
  assert.equal(next.dailyHistory['2026-10-05'].legacySeconds, 3600);
  assert.equal(next.dailyHistory['2026-10-05'].completed, true);
  assert.equal(next.dailyHistory['2026-10-06'].contentSeconds, 2000);
  assert.equal(next.dailyHistory['2026-10-01'].legacySeconds, 50);
});

test('unknown fields and junk courses are dropped, not stored', () => {
  const v = validateImport({ dailyHistory: { '2026-10-06': { watchedSeconds: 10, password: 'x' } }, courses: { good: { title: 'Good', totalSeconds: 5 }, bad: { title: 'Bad', totalSeconds: 'lots' } }, extra: 'ignored' });
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.data.dailyHistory['2026-10-06']).sort(), ['actualActiveSeconds', 'completed', 'contentSeconds', 'goalSeconds', 'legacySeconds']);
  assert.deepEqual(Object.keys(v.data.courses), ['good']);
  assert.equal(v.warnings.length, 1);
});

test('V1.1 records validate: content may exceed real time; bad values rejected', () => {
  const ok = validateImport({ schemaVersion: 2, dailyHistory: { '2026-10-06': { contentSeconds: 600, actualActiveSeconds: 300, goalSeconds: 600 } } });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.data.dailyHistory['2026-10-06'].completed, true); // goal uses content
  assert.equal(validateImport({ dailyHistory: { '2026-10-06': { contentSeconds: -1 } } }).ok, false);
  assert.equal(validateImport({ dailyHistory: { '2026-10-06': { actualActiveSeconds: 90000 } } }).ok, false);
  assert.equal(validateImport({ dailyHistory: { '2026-10-06': { goalSeconds: 600 } } }).ok, false); // no time fields
});

test('V1 export file still imports (backward compatible)', () => {
  const v1 = { app: 'udemy-learning-streak', schemaVersion: 1, dailyGoalMinutes: 60, dailyHistory: { '2026-10-05': { watchedSeconds: 3700, goalSeconds: 3600, completed: true } }, courses: { x: { title: 'X', totalSeconds: 3700 } } };
  const v = validateImport(JSON.stringify(v1));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.data.courses.x, { title: 'X', contentSeconds: 0, actualActiveSeconds: 3700, lastWatchedAt: 0, legacySeconds: 3700 });
});
