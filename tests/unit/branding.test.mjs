/**
 * LearningStreak rename: the product name changed, nothing that identifies the
 * extension's data did. These tests pin the new branding AND the internal
 * identifiers that must stay the same so upgrading users keep their data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mod } from './helpers.mjs';

const EXT = new URL('../../extension/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', EXT), 'utf8'));

const { APP_ID, SCHEMA_VERSION } = await mod('config/config.js');
const { STATE_KEYS, createStorageService, memoryAdapter } = await mod('storage/storageService.js');
const { migrate } = await mod('storage/migrationService.js');
const { PLATFORM_IDS, LEGACY_PLATFORM } = await mod('platforms/registry.js');
const { validateImport, buildExport } = await mod('core/dataTransfer.js');
const { computeStreaks } = await mod('core/streakEngine.js');

function walk(url) {
  return readdirSync(url).flatMap((n) => {
    const u = new URL(n, url);
    return statSync(u).isDirectory() ? walk(new URL(`${n}/`, url)) : [u];
  });
}

test('manifest: product name is LearningStreak', () => {
  assert.equal(manifest.name, 'LearningStreak');
  assert.equal(manifest.short_name, 'LearningStreak');
  assert.equal(manifest.action.default_title, 'LearningStreak');
});

test('manifest: description fits the Web Store limit and names only implemented platforms', () => {
  const d = manifest.description;
  assert.ok(d.length > 0 && d.length <= 132, `description is ${d.length} chars`);
  assert.match(d, /Udemy/);
  // Coursera is still in development (signed-in player unverified) and Physics Wallah
  // is not implemented: the store description must not claim them.
  assert.doesNotMatch(d, /coursera|physics\s*wallah|\bpw\b/i);
  // Every platform the description names has host access in the manifest.
  for (const [name, host] of [['Udemy', 'udemy.com'], ['YouTube', 'youtube.com']]) {
    if (d.includes(name)) assert.ok(manifest.host_permissions.some((h) => h.includes(host)), name);
  }
});

test('rename does not touch extension identity or permissions', () => {
  assert.equal(manifest.key, undefined, 'no manifest key was added');
  assert.equal(manifest.update_url, undefined);
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'notifications', 'idle', 'scripting']);
});

test('no old product name left in user-facing extension files', () => {
  const OLD = /LearnStreak|Learn Streak|Udemy Learning Streak|\bLearning Streak\b/;
  const offenders = walk(EXT)
    .filter((u) => /\.(html|js|css|json)$/.test(u.pathname))
    .flatMap((u) => readFileSync(u, 'utf8').split('\n')
      .map((line, i) => ({ file: u.pathname.split('/extension/')[1], line: i + 1, text: line }))
      // Source comments may describe history (e.g. "schema v2, LearnStreak V1.1").
      .filter(({ text }) => OLD.test(text) && !/^\s*(\*|\/\/|\/\*)/.test(text)));
  assert.deepEqual(offenders, []);
});

test('internal identifiers are unchanged (storage, export format, platforms)', () => {
  // APP_ID guards imports: changing it would reject every existing backup file.
  assert.equal(APP_ID, 'udemy-learning-streak');
  // A branding-only release must not bump the schema.
  assert.equal(SCHEMA_VERSION, 2);
  assert.deepEqual(STATE_KEYS, ['schemaVersion', 'settings', 'dailyHistory', 'courses', 'sessions', 'library', 'playlistMembership', 'meta', 'debug']);
  assert.deepEqual([...PLATFORM_IDS].sort(), ['coursera', 'udemy', 'youtube']);
  assert.equal(LEGACY_PLATFORM, 'udemy');
  // The content scripts share one global namespace and one takeover event.
  const main = readFileSync(new URL('src/content/main.js', EXT), 'utf8');
  assert.match(main, /'udemy-learning-streak:takeover'/);
  assert.match(readFileSync(new URL('src/content/activityRules.js', EXT), 'utf8'), /__UdemyStreak/);
});

/** A state as the pre-rename v1.2.1 / V2.1 build stored it in chrome.storage.local. */
function preRenameState() {
  return {
    schemaVersion: 2,
    settings: { dailyGoalMinutes: 45, notificationsEnabled: false, reminderEnabled: true, reminderTime: '20:30' },
    dailyHistory: {
      '2026-10-06': { contentSeconds: 2700, actualActiveSeconds: 2000, goalSeconds: 2700, completed: true },
      '2026-10-07': { contentSeconds: 3000, actualActiveSeconds: 2900, goalSeconds: 2700, completed: true },
      '2026-10-08': { contentSeconds: 2800, actualActiveSeconds: 2800, goalSeconds: 2700, completed: true },
    },
    courses: { 'js-course': { title: 'JS Course', contentSeconds: 8500, actualActiveSeconds: 7700, lastWatchedAt: 1 } },
    sessions: {},
    library: {},
    playlistMembership: {},
    meta: { longestStreak: 9, installedAt: 1759700000000 },
    debug: {},
  };
}

test('upgrade: pre-rename stored data loads unchanged (streaks, best streak, goal, settings)', async () => {
  const before = preRenameState();
  const { state } = migrate(structuredClone(before));
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.dailyHistory, before.dailyHistory);
  assert.deepEqual(state.courses, before.courses);
  assert.equal(state.settings.dailyGoalMinutes, 45);
  assert.equal(state.settings.reminderTime, '20:30');
  assert.equal(state.meta.longestStreak, 9);
  assert.equal(state.meta.installedAt, 1759700000000, 'not treated as a new install');
  const s = computeStreaks(state.dailyHistory, '2026-10-08', state.meta.longestStreak);
  assert.equal(s.current, 3);
  assert.equal(s.longest, 9);

  // Through the real storage service, as the service worker does on update.
  const adapter = memoryAdapter(structuredClone(before));
  const loaded = await createStorageService(adapter).initialize();
  assert.deepEqual(loaded.dailyHistory, before.dailyHistory);
  assert.equal(loaded.meta.longestStreak, 9);
});

test('upgrade: a backup exported before the rename still imports, and new exports keep the same app id', () => {
  const old = { app: 'udemy-learning-streak', schemaVersion: 2, exportedAt: '2026-10-08T10:00:00.000Z', settings: { dailyGoalMinutes: 45 }, dailyHistory: preRenameState().dailyHistory, courses: {} };
  const v = validateImport(JSON.stringify(old));
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(buildExport(migrate(preRenameState()).state, '2026-10-08').app, 'udemy-learning-streak');
});
