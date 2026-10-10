/**
 * Storage service — the single gateway to persisted state.
 *
 * - Backed by a pluggable adapter (default: chrome.storage.local) so a cloud-sync
 *   adapter can be added later without touching the engines.
 * - `update()` runs mutations strictly one-at-a-time (promise queue), so rapid
 *   credit messages from several tabs can never interleave read-modify-write.
 * - Only the background service worker writes; UI pages read and ask the worker.
 */

import { migrate } from './migrationService.js';

export const STATE_KEYS = ['schemaVersion', 'settings', 'dailyHistory', 'courses', 'sessions', 'library', 'playlistMembership', 'meta', 'debug'];

export function chromeLocalAdapter(area = globalThis.chrome?.storage?.local) {
  return {
    get: () => area.get(STATE_KEYS),
    set: (obj) => area.set(obj),
    clear: () => area.remove(STATE_KEYS),
  };
}

/** In-memory adapter (tests / future offline cache). */
export function memoryAdapter(initial = {}) {
  let data = structuredClone(initial);
  return {
    get: async () => structuredClone(data),
    set: async (obj) => { data = { ...data, ...structuredClone(obj) }; },
    clear: async () => { data = {}; },
    dump: () => structuredClone(data),
  };
}

export function createStorageService(adapter = chromeLocalAdapter()) {
  let queue = Promise.resolve();

  async function read() {
    const raw = await adapter.get();
    return migrate(raw).state;
  }

  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  /**
   * mutator(state) → { state, ...extra } | undefined (no write).
   * Resolves with the mutator's result (so callers get events like completedDays).
   */
  function update(mutator) {
    return enqueue(async () => {
      const current = await read();
      const result = (await mutator(current)) || {};
      if (result.state && result.state !== current) {
        const toWrite = {};
        for (const k of STATE_KEYS) toWrite[k] = result.state[k];
        await adapter.set(toWrite);
      }
      return { ...result, state: result.state || current };
    });
  }

  /** Ensure storage holds a migrated, complete state (run on install/startup). */
  function initialize() {
    return enqueue(async () => {
      const raw = await adapter.get();
      const { state, changed } = migrate(raw);
      if (changed) {
        const toWrite = {};
        for (const k of STATE_KEYS) toWrite[k] = state[k];
        await adapter.set(toWrite);
      }
      return state;
    });
  }

  function reset(freshState) {
    return enqueue(async () => {
      await adapter.clear();
      const toWrite = {};
      for (const k of STATE_KEYS) toWrite[k] = freshState[k];
      await adapter.set(toWrite);
      return freshState;
    });
  }

  return { read, update, initialize, reset };
}
