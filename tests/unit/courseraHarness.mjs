/**
 * Deterministic harness for the REAL content scripts the manifest injects on
 * www.coursera.org, run in a node:vm sandbox (same approach as contentHarness.mjs):
 *   - a fake clock (performance.now / Date.now / setTimeout) with optional
 *     background-tab timer throttling,
 *   - a fake Coursera page. The authenticated lecture player could NOT be inspected
 *     (it needs a signed-in account), so instead of one assumed behaviour the page
 *     can do each plausible one on a lecture change:
 *       'replace' — SPA route change, then a NEW <video> element (old one removed)
 *       'reuse'   — SPA route change, then the SAME element loads a new source
 *       'stale'   — SPA route change while the OLD lecture keeps playing for a while
 *     and the player can be absent ('none') or inside a cross-origin iframe ('iframe',
 *     i.e. no <video> visible to the content script),
 *   - a fake background that answers with the REAL engine code (recordCredit).
 * Nothing here re-implements measurement: it only plays videos and lets time pass.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mod, SRC } from './helpers.mjs';

const { recordCredit } = await mod('core/learningEngine.js');
const { createDefaultState } = await mod('core/schema.js');

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', SRC), 'utf8'));
const SCRIPT_FILES = manifest.content_scripts.find((c) => c.matches.includes('https://www.coursera.org/*')).js;
const SCRIPTS = SCRIPT_FILES.map((f) => ({ f, code: readFileSync(new URL(`../${f}`, SRC), 'utf8') }));

const STEP_MS = 50;
const TIMEUPDATE_MS = 250;
export const ORIGIN = 'https://www.coursera.org';

class Emitter {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn, opts = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    const entry = { fn };
    this.listeners.get(type).add(entry);
    if (opts && opts.signal) opts.signal.addEventListener('abort', () => this.listeners.get(type).delete(entry));
  }
  removeEventListener() { /* not needed */ }
  dispatchEvent(e) {
    if (!e.target) e.target = this;
    for (const { fn } of [...(this.listeners.get(e.type) || [])]) fn(e);
    return true;
  }
  emit(type, target = this, extra = {}) { this.dispatchEvent({ type, target, ...extra }); }
  count(type) { return this.listeners.get(type)?.size || 0; }
}

class FakeVideo {
  constructor({ width = 1280, height = 720 } = {}) {
    this.tagName = 'VIDEO';
    this.paused = true; this.ended = false; this.seeking = false; this.readyState = 0;
    this.currentTime = 0; this.playbackRate = 1; this.duration = NaN; this.currentSrc = '';
    this.isConnected = true; this.width = width; this.height = height; this.lastTimeupdate = 0;
  }
  getBoundingClientRect() { return { width: this.width, height: this.height }; }
  querySelector() { return null; }
}

export function createCourseraWorld({ t0 = new Date(2026, 9, 9, 15, 0, 0).getTime(), duration = 1800 } = {}) {
  const clock = { perf: 1000, wall: t0 };
  const timers = new Map();
  let timerSeq = 0;
  const world = { clock, throttleMs: 0, asleep: false, stalled: false, credits: [], statuses: [], locked: false, srcSeq: 0, pageActions: [] };

  // ---- background (real engine code) ------------------------------------------
  let state = createDefaultState(t0);
  const background = {
    handle(msg) {
      if (msg.type === 'tracker:credit') {
        world.credits.push(msg);
        if (world.locked) return { ok: false, locked: true, rejected: 'locked' };
        const r = recordCredit(state, { endMs: msg.endMs, active: msg.active, content: msg.content, source: msg.source });
        state = r.state;
        return { ok: true, applied: r.appliedSeconds, appliedContent: r.appliedContent, rejected: r.rejected, locked: false };
      }
      if (msg.type === 'tracker:status') { world.statuses.push(msg); return { ok: true, locked: world.locked }; }
      return { ok: false };
    },
  };
  world.state = () => state;
  const DAY = new Date(t0);
  const dayKey = `${DAY.getFullYear()}-${String(DAY.getMonth() + 1).padStart(2, '0')}-${String(DAY.getDate()).padStart(2, '0')}`;
  world.day = () => state.dailyHistory[dayKey] || { contentSeconds: 0, actualActiveSeconds: 0 };
  world.content = () => world.day().contentSeconds || 0;
  world.active = () => world.day().actualActiveSeconds || 0;
  world.sessions = () => Object.values(state.sessions || {}).sort((a, b) => a.startedAt - b.startedAt);
  /** Content seconds per lecture item id (from the session log). */
  world.byLecture = () => world.sessions().reduce((m, s) => ({ ...m, [s.lessonId]: (m[s.lessonId] || 0) + s.contentSeconds }), {});

  // ---- page ------------------------------------------------------------------------
  const win = new Emitter();
  const doc = new Emitter();
  const videos = []; // every <video> ever inserted (connected or not)
  world.doc = doc;
  world.videos = videos;
  let location = new URL(`${ORIGIN}/`);
  Object.assign(doc, {
    visibilityState: 'visible', fullscreenElement: null, documentElement: {}, title: 'Coursera',
    getElementsByTagName(tag) {
      if (tag !== 'video') return [];
      const live = () => videos.filter((v) => v.isConnected);
      return { get length() { return live().length; }, *[Symbol.iterator]() { yield* live(); } };
    },
    querySelector: () => null,
    createTreeWalker: () => ({ currentNode: null, nextNode: () => null }),
  });

  // ---- chrome.runtime ---------------------------------------------------------
  const runtimeListeners = new Set();
  const macrotask = () => new Promise((r) => setImmediate(r));
  const chrome = {
    runtime: {
      id: 'test-extension',
      sendMessage: async (msg) => {
        const copy = structuredClone(msg);
        await macrotask();
        return background.handle(copy);
      },
      onMessage: { addListener: (fn) => runtimeListeners.add(fn), removeListener: (fn) => runtimeListeners.delete(fn) },
    },
  };
  world.message = (msg) => {
    let response;
    for (const fn of [...runtimeListeners]) fn(msg, {}, (r) => { response = r; });
    return response;
  };
  world.ping = () => world.message({ type: 'popup:ping' });
  world.runtimeListenerCount = () => runtimeListeners.size;
  world.docListenerCount = (type) => doc.count(type);

  // ---- timers -------------------------------------------------------------------
  function setTimeoutFake(fn, ms = 0) {
    let at = clock.perf + Math.max(0, Number(ms) || 0);
    if (world.throttleMs > 0) at = Math.ceil(at / world.throttleMs) * world.throttleMs; // background-tab alignment
    timers.set(++timerSeq, { at, fn });
    return timerSeq;
  }
  class FakeDate extends Date { static now() { return clock.wall; } }

  const sandbox = {
    document: doc,
    performance: { now: () => clock.perf },
    Date: FakeDate,
    setTimeout: setTimeoutFake,
    clearTimeout: (id) => timers.delete(id),
    chrome,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController,
    NodeFilter: { SHOW_ELEMENT: 1 },
    console,
    URL,
    addEventListener: (...a) => win.addEventListener(...a),
    removeEventListener: () => {},
  };
  Object.defineProperty(sandbox, 'location', { get: () => location, enumerable: true });
  vm.createContext(sandbox);
  world.inject = () => { for (const { f, code } of SCRIPTS) vm.runInContext(code, sandbox, { filename: f }); };

  // ---- driving the page ---------------------------------------------------------
  const fire = (type, v) => doc.emit(type, v);

  async function runTimers() {
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= clock.perf).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) return;
      for (const [id, t] of due) { timers.delete(id); t.fn(); }
      await macrotask();
    }
  }

  /** Let `ms` of real time pass (playing videos advance; events and timers fire). */
  world.advance = async (ms) => {
    const end = clock.perf + ms;
    while (clock.perf < end) {
      const dt = Math.min(STEP_MS, end - clock.perf);
      clock.perf += dt;
      clock.wall += dt;
      for (const a of world.pageActions.filter((x) => x.at <= clock.perf)) { world.pageActions.splice(world.pageActions.indexOf(a), 1); a.fn(); }
      if (world.asleep) continue; // machine asleep: nothing runs, no video moves
      for (const v of videos.filter((x) => x.isConnected)) {
        if (v.paused || v.ended || v.readyState < 2 || world.stalled) continue;
        v.currentTime = Math.min(v.duration, v.currentTime + (dt / 1000) * v.playbackRate);
        if (v.currentTime >= v.duration) { v.paused = true; v.ended = true; fire('pause', v); fire('ended', v); }
        else if (clock.perf - v.lastTimeupdate >= TIMEUPDATE_MS) { v.lastTimeupdate = clock.perf; fire('timeupdate', v); }
      }
      await runTimers();
      await macrotask();
    }
    for (let i = 0; i < 5; i += 1) await macrotask();
  };

  /** Load lecture `item`'s media into `v` (what the player does). */
  function loadMedia(v, item) {
    if (v.currentSrc) { v.readyState = 0; fire('emptied', v); }
    v.currentSrc = `https://d3c33hcgiwev3.cloudfront.net/${item}.processed/full/540p/index.mp4?n=${++world.srcSeq}`;
    v.currentTime = 0; v.duration = duration; v.ended = false;
    fire('loadstart', v);
    v.readyState = 4;
    fire('loadedmetadata', v); fire('canplay', v);
  }
  const itemOf = (path) => (/\/lecture\/([^/]+)/.exec(path) || [])[1] || 'none';

  function mountPlayer(item, size) {
    const v = new FakeVideo(size);
    videos.push(v);
    loadMedia(v, item);
    return v;
  }
  /** Removing a media element pauses it (HTML spec "internal pause steps"). */
  function removePlayer(v) {
    if (!v || !v.isConnected) return;
    if (!v.paused) { v.paused = true; fire('pause', v); }
    v.isConnected = false;
  }
  world.player = () => videos.filter((v) => v.isConnected && v.width >= 640).at(-1) || null;

  /**
   * Hard load of a page. `player`: 'video' (HTML5 <video> in the page), 'iframe'
   * (player in a cross-origin frame: no <video> visible here), 'none'.
   * `preview`: also a small muted autoplaying <video> (thumbnail / promo tile).
   */
  world.open = async (path, { player = 'video', preview = false, inject = true } = {}) => {
    location = new URL(`${ORIGIN}${path}`);
    for (const v of videos) removePlayer(v);
    if (player === 'video') mountPlayer(itemOf(path));
    if (preview) { const p = mountPlayer('promo', { width: 120, height: 68 }); p.paused = false; fire('play', p); fire('playing', p); }
    if (inject) world.inject();
    await world.advance(100);
  };

  /**
   * SPA navigation (history.pushState, no event) to `path`, then the player follows:
   *   'replace' — after `swapDelayMs` the old <video> is removed and a new one mounted;
   *   'reuse'   — after `swapDelayMs` the same element loads the new lecture's source;
   *   'stale'   — like 'replace', but the OLD lecture keeps playing until the swap;
   *   'leave'   — the player is removed at once (non-lecture page).
   */
  world.navigate = (path, { mode = 'replace', swapDelayMs = 0, keepPlaying = true } = {}) => {
    const old = world.player();
    const wasPlaying = old && !old.paused;
    location = new URL(`${ORIGIN}${path}`);
    if (mode === 'leave') { removePlayer(old); return; }
    if (mode === 'replace' && old) removePlayer(old); // 'reuse' / 'stale': the old media keeps playing until the swap
    const swap = () => {
      let v;
      if (mode === 'reuse' && old) { v = old; loadMedia(v, itemOf(path)); } else { removePlayer(old); v = mountPlayer(itemOf(path)); }
      if (keepPlaying && wasPlaying) { v.paused = false; fire('play', v); fire('playing', v); }
    };
    if (swapDelayMs > 0) world.pageActions.push({ at: clock.perf + swapDelayMs, fn: swap }); else swap();
  };
  /** Browser back/forward: URL changes and popstate fires; the app then swaps the player. */
  world.back = (path, opts = {}) => { world.navigate(path, opts); win.emit('popstate', win); };
  /** The player element is replaced by the app on the SAME lecture (re-render). */
  world.rerender = () => {
    const old = world.player();
    const wasPlaying = old && !old.paused;
    const at = old ? old.currentTime : 0;
    removePlayer(old);
    const v = mountPlayer(itemOf(location.pathname));
    v.currentTime = at; // resumes where it was
    if (wasPlaying) { v.paused = false; fire('play', v); fire('playing', v); }
  };

  const cur = () => world.player();
  world.play = () => { const v = cur(); v.paused = false; fire('play', v); fire('playing', v); };
  world.pause = () => { const v = cur(); v.paused = true; fire('pause', v); };
  world.seekTo = (t) => { const v = cur(); v.seeking = true; fire('seeking', v); v.currentTime = t; v.seeking = false; fire('seeked', v); };
  world.rate = (r) => { const v = cur(); v.playbackRate = r; fire('ratechange', v); };
  /** Network starvation: readyState drops, 'waiting' fires, the video stops advancing. */
  world.buffer = (on) => { const v = cur(); world.stalled = on; v.readyState = on ? 1 : 4; fire(on ? 'waiting' : 'canplay', v); if (!on) fire('playing', v); };
  /** currentTime frozen while the element still claims to play (decoder hang): no event at all. */
  world.freezeDecoder = (on) => { world.stalled = on; };
  world.lifecycleFreeze = (on) => doc.emit(on ? 'freeze' : 'resume', doc);
  world.hide = () => { doc.visibilityState = 'hidden'; doc.emit('visibilitychange', doc); };
  world.show = () => { doc.visibilityState = 'visible'; world.throttleMs = 0; doc.emit('visibilitychange', doc); };
  world.blur = () => win.emit('blur', win);
  world.lock = (locked) => { world.locked = locked; world.message({ type: 'system:lock', locked }); };
  /** Let unsaved time reach the background (pause → flush). */
  world.settle = () => world.advance(1500);
  return world;
}
