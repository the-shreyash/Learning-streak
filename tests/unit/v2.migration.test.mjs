import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

const { migrate } = await mod('storage/migrationService.js');
const { createStorageService, memoryAdapter } = await mod('storage/storageService.js');
const { computeStreaks } = await mod('core/streakEngine.js');
const { computeStats } = await mod('core/statisticsEngine.js');
const { recordLearning } = await mod('core/learningEngine.js');
const { buildExport, validateImport, applyImport } = await mod('core/dataTransfer.js');
const { createDefaultState } = await mod('core/schema.js');

/** Storage exactly as V1.2.1 leaves it (schema 2, no V2 fields). */
function v121Storage() {
  return {
    schemaVersion: 2,
    settings: { dailyGoalMinutes: 60, notificationsEnabled: true, reminderEnabled: false, reminderTime: '20:00' },
    dailyHistory: {
      '2026-10-03': { contentSeconds: 0, actualActiveSeconds: 3700, legacySeconds: 3700, goalSeconds: 3600, completed: true, celebrationShown: true },
      '2026-10-04': { contentSeconds: 3900, actualActiveSeconds: 2600, goalSeconds: 3600, completed: true, completedAt: 5, celebrationShown: true },
      '2026-10-05': { contentSeconds: 3600, actualActiveSeconds: 3600, goalSeconds: 3600, completed: true },
      '2026-10-06': { contentSeconds: 1200, actualActiveSeconds: 900, goalSeconds: 3600, completed: false },
    },
    courses: {
      'ml-az': { title: 'ML A-Z', contentSeconds: 8700, actualActiveSeconds: 7100, legacySeconds: 3700, lastWatchedAt: 9 },
    },
    meta: { longestStreak: 7, currentCourse: { key: 'ml-az', title: 'ML A-Z', updatedAt: 9 }, installedAt: 1, creditedUntil: 9, lastGoalNotifiedDay: '2026-10-05' },
    debug: { clockOffsetMs: 0 },
  };
}

test('migration: V1.2.1 data is preserved and gains only an empty session log', () => {
  const raw = v121Storage();
  const { state, changed } = migrate(structuredClone(raw));
  assert.equal(changed, true); // `sessions` had to be created
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.dailyHistory, raw.dailyHistory, 'daily history byte-identical');
  assert.deepEqual(state.courses, raw.courses, 'course totals byte-identical');
  for (const rec of Object.values(state.dailyHistory)) assert.equal(rec.platforms, undefined, 'no platform attribution invented');
  assert.equal(state.meta.longestStreak, 7);
  assert.equal(state.meta.currentCourse.key, 'ml-az');
});

test('migration: streaks, stats and historical learning time are unchanged', () => {
  const raw = v121Storage();
  const { state } = migrate(structuredClone(raw));
  assert.deepEqual(computeStreaks(state.dailyHistory, '2026-10-06', state.meta.longestStreak), computeStreaks(raw.dailyHistory, '2026-10-06', 7));
  assert.deepEqual(computeStats(state.dailyHistory, '2026-10-06'), computeStats(raw.dailyHistory, '2026-10-06'));
});

test('migration: V1 (schema 1) data → V2 data model, nothing invented', () => {
  const v1 = {
    schemaVersion: 1,
    settings: { dailyGoalMinutes: 60 },
    dailyHistory: { '2026-10-05': { watchedSeconds: 3650, goalSeconds: 3600, completed: true } },
    courses: { ml: { title: 'ML', totalSeconds: 3650, lastWatchedAt: 5 } },
    meta: { longestStreak: 4 },
  };
  const { state } = migrate(v1);
  assert.deepEqual(state.sessions, {});
  assert.equal(state.dailyHistory['2026-10-05'].legacySeconds, 3650);
  assert.equal(state.dailyHistory['2026-10-05'].platforms, undefined);
  assert.equal(state.courses.ml.platform, undefined);
  assert.equal(state.meta.longestStreak, 4);
});

test('migration: idempotent — running it twice changes nothing and duplicates nothing', () => {
  const once = migrate(structuredClone(v121Storage())).state;
  const twice = migrate(structuredClone(once));
  assert.equal(twice.changed, false);
  assert.deepEqual(twice.state, once);
  // with V2 data present too
  const withV2 = recordLearning(once, { endMs: localMs(2026, 10, 6, 18), active: 60, content: 60, source: { platform: 'youtube', contentType: 'video', contentId: 'abc' } }).state;
  const m1 = migrate(structuredClone(withV2));
  const m2 = migrate(structuredClone(m1.state));
  assert.equal(m2.changed, false);
  assert.deepEqual(m2.state, m1.state);
  assert.equal(Object.keys(m2.state.sessions).length, 1);
});

test('migration: storage initialize() twice writes once and keeps everything', async () => {
  const adapter = memoryAdapter(v121Storage());
  const svc = createStorageService(adapter);
  await svc.initialize();
  const first = adapter.dump();
  await svc.initialize();
  assert.deepEqual(adapter.dump(), first);
  assert.deepEqual(first.dailyHistory, v121Storage().dailyHistory);
  assert.deepEqual(first.sessions, {});
});

test('migration: malformed V2 fields are repaired, valid ones kept', () => {
  const raw = v121Storage();
  raw.sessions = { junk: { id: 'junk' } };
  raw.dailyHistory['2026-10-06'].platforms = { youtube: { contentSeconds: 'x', actualActiveSeconds: -5 }, netflix: { contentSeconds: 9 }, udemy: { contentSeconds: 100, actualActiveSeconds: 50 } };
  const { state, changed } = migrate(raw);
  assert.equal(changed, true);
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.dailyHistory['2026-10-06'].platforms, { udemy: { contentSeconds: 100, actualActiveSeconds: 50 } });
});

test('import: a V1.2.1 export still imports unchanged', () => {
  const s = migrate(v121Storage()).state;
  const v121Export = buildExport(s, '2026-10-06');
  delete v121Export.sessions; // V1.2.1 exports had no sessions
  const v = validateImport(JSON.stringify(v121Export));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const next = applyImport(createDefaultState(), v.data, 'replace', '2026-10-06');
  assert.deepEqual(next.sessions, {});
  for (const k of Object.keys(s.dailyHistory)) assert.equal(next.dailyHistory[k].contentSeconds, s.dailyHistory[k].contentSeconds);
  assert.equal(next.meta.longestStreak, 7);
});

test('import: V2 export round-trips sessions and platform attribution; merging twice never duplicates', () => {
  let s = migrate(v121Storage()).state;
  s = recordLearning(s, { endMs: localMs(2026, 10, 6, 18), active: 60, content: 90, source: { platform: 'youtube', contentType: 'video', contentId: 'abc', courseTitle: 'LR' } }).state;
  const v = validateImport(JSON.stringify(buildExport(s, '2026-10-06')));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.summary.sessions, 1);
  assert.deepEqual(v.data.dailyHistory['2026-10-06'].platforms, s.dailyHistory['2026-10-06'].platforms);
  assert.equal(v.data.courses['youtube:video:abc'].platform, 'youtube');
  const replaced = applyImport(createDefaultState(), v.data, 'replace', '2026-10-06');
  assert.deepEqual(replaced.sessions, s.sessions);
  const merged1 = applyImport(s, v.data, 'merge', '2026-10-06');
  const merged2 = applyImport(merged1, v.data, 'merge', '2026-10-06');
  assert.deepEqual(merged2.sessions, s.sessions);
  assert.equal(merged2.dailyHistory['2026-10-06'].contentSeconds, s.dailyHistory['2026-10-06'].contentSeconds);
});
