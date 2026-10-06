import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod } from './helpers.mjs';

const { createStorageService, memoryAdapter } = await mod('storage/storageService.js');
const { migrate } = await mod('storage/migrationService.js');
const { applyCredit } = await mod('core/timerEngine.js');

test('empty storage initializes to defaults', async () => {
  const adapter = memoryAdapter();
  const svc = createStorageService(adapter);
  const s = await svc.initialize();
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.settings.dailyGoalMinutes, 60);
  assert.equal(adapter.dump().settings.dailyGoalMinutes, 60);
});

test('concurrent updates are serialized (no lost writes)', async () => {
  const svc = createStorageService(memoryAdapter());
  await svc.initialize();
  const base = Date.parse('2026-10-06T10:00:00Z');
  await Promise.all(Array.from({ length: 50 }, (_, i) =>
    svc.update((s) => applyCredit(s, { endMs: base + (i + 1) * 5000, active: 5, content: 10 }))));
  const s = await svc.read();
  const total = Object.values(s.dailyHistory).reduce((a, r) => a + r.actualActiveSeconds, 0);
  const content = Object.values(s.dailyHistory).reduce((a, r) => a + r.contentSeconds, 0);
  assert.equal(total, 250);
  assert.equal(content, 500);
});

test('a failing mutation does not break the queue', async () => {
  const svc = createStorageService(memoryAdapter());
  await svc.initialize();
  await assert.rejects(svc.update(() => { throw new Error('boom'); }));
  const r = await svc.update((s) => ({ state: { ...s, meta: { ...s.meta, longestStreak: 4 } } }));
  assert.equal(r.state.meta.longestStreak, 4);
});

test('migration keeps history, repairs bad entries, fills defaults (extension reload safety)', () => {
  const { state } = migrate({
    dailyHistory: { '2026-10-05': { watchedSeconds: 4000 }, 'garbage': { watchedSeconds: 1 }, '2026-10-06': 'x' },
    settings: { dailyGoalMinutes: 45, unknown: true },
    meta: { longestStreak: 9 },
  });
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(Object.keys(state.dailyHistory), ['2026-10-05']);
  assert.equal(state.dailyHistory['2026-10-05'].goalSeconds, 2700);
  assert.equal(state.dailyHistory['2026-10-05'].completed, true);
  assert.equal(state.dailyHistory['2026-10-05'].legacySeconds, 4000);
  assert.equal(state.settings.dailyGoalMinutes, 45);
  assert.equal(state.settings.notificationsEnabled, true);
  assert.equal(state.meta.longestStreak, 9);
  assert.equal(state.settings.unknown, undefined);
});

test('reset keeps only the fresh state', async () => {
  const adapter = memoryAdapter();
  const svc = createStorageService(adapter);
  await svc.initialize();
  await svc.update((s) => applyCredit(s, { endMs: Date.now(), seconds: 5 }));
  const { createDefaultState } = await mod('core/schema.js');
  await svc.reset(createDefaultState());
  const s = await svc.read();
  assert.deepEqual(s.dailyHistory, {});
});

test('V1 → V1.1 migration: watch time preserved as legacy, nothing invented, streak unchanged', async () => {
  const { computeStreaks } = await mod('core/streakEngine.js');
  const v1 = {
    schemaVersion: 1,
    settings: { dailyGoalMinutes: 60 },
    dailyHistory: {
      '2026-10-04': { watchedSeconds: 3700, goalSeconds: 3600, completed: true, celebrationShown: true },
      '2026-10-05': { watchedSeconds: 3650, goalSeconds: 3600, completed: true },
      '2026-10-06': { watchedSeconds: 240, goalSeconds: 3600, completed: false },
    },
    courses: { ml: { title: 'ML', totalSeconds: 7590, lastWatchedAt: 5 } },
    meta: { longestStreak: 2 },
  };
  const before = computeStreaks(v1.dailyHistory, '2026-10-06', 2);
  const { state, changed } = migrate(v1);
  assert.equal(changed, true);
  const d = state.dailyHistory['2026-10-05'];
  assert.equal(d.watchedSeconds, undefined);
  assert.equal(d.legacySeconds, 3650);          // what V1 measured, unchanged
  assert.equal(d.actualActiveSeconds, 3650);    // V1 measured real time → that IS actual time
  assert.equal(d.contentSeconds, 0);            // speed was never recorded → no invented content
  assert.equal(d.completed, true);
  assert.equal(state.dailyHistory['2026-10-04'].celebrationShown, true);
  assert.deepEqual(state.courses.ml, { title: 'ML', contentSeconds: 0, actualActiveSeconds: 7590, lastWatchedAt: 5, legacySeconds: 7590 });
  const after = computeStreaks(state.dailyHistory, '2026-10-06', state.meta.longestStreak);
  assert.deepEqual(after, before);
  // Idempotent
  const again = migrate(state);
  assert.deepEqual(again.state.dailyHistory, state.dailyHistory);
  assert.equal(again.changed, false);
});

test('mixed day: V1 legacy time + new V1.1 content both count toward today\'s goal', async () => {
  const svc = createStorageService(memoryAdapter({ schemaVersion: 1, settings: { dailyGoalMinutes: 10 }, dailyHistory: { '2026-10-06': { watchedSeconds: 240, goalSeconds: 600 } } }));
  await svc.initialize();
  const end = new Date(2026, 9, 6, 15, 0, 0).getTime();
  let r;
  for (let i = 1; i <= 36; i += 1) r = await svc.update((s) => applyCredit(s, { endMs: end + i * 5000, active: 5, content: 10 }));
  const d = r.state.dailyHistory['2026-10-06'];
  assert.equal(d.legacySeconds, 240);
  assert.equal(d.contentSeconds, 360);
  assert.equal(d.actualActiveSeconds, 240 + 180);
  assert.equal(d.completed, true); // 240 legacy + 360 content = 600 = goal
});
