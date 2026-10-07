/**
 * Deterministic harness for the REAL content scripts (the files and order the
 * manifest injects on www.youtube.com), run in a node:vm sandbox with:
 *   - a fake clock (performance.now / Date.now / setTimeout) with optional
 *     background-tab timer throttling,
 *   - a fake YouTube watch page: one reused <video class="html5-main-video">
 *     whose source is swapped on SPA navigation (URL first, then emptied →
 *     loadstart, page metadata ~3.5 s later — as observed on youtube.com),
 *   - a fake background that answers with the REAL engine code
 *     (recordCredit / targetStatus) over an in-memory state.
 * Nothing here re-implements measurement: it only plays a video and lets time pass.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mod, SRC } from './helpers.mjs';

const { recordCredit } = await mod('core/learningEngine.js');
const { targetStatus, addYouTubeVideo, setLibraryItemEnabled } = await mod('core/learningLibrary.js');
const { createDefaultState } = await mod('core/schema.js');

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', SRC), 'utf8'));
const SCRIPT_FILES = manifest.content_scripts.find((c) => c.matches.includes('https://www.youtube.com/*')).js;
const SCRIPTS = SCRIPT_FILES.map((f) => ({ f, code: readFileSync(new URL(`../${f}`, SRC), 'utf8') }));

const STEP_MS = 50;
const TIMEUPDATE_MS = 250;

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
}

class FakeVideo {
  constructor() {
    this.tagName = 'VIDEO';
    this.paused = true; this.ended = false; this.seeking = false; this.readyState = 0;
    this.currentTime = 0; this.playbackRate = 1; this.duration = NaN; this.currentSrc = '';
    this.isConnected = true;
  }
  getBoundingClientRect() { return { width: 1280, height: 720 }; }
  querySelector() { return null; }
}

export function createWorld({ registered = [], t0 = new Date(2026, 9, 7, 15, 0, 0).getTime(), duration = 1800 } = {}) {
  const clock = { perf: 1000, wall: t0 };
  const timers = new Map();
  let timerSeq = 0;
  const world = {
    clock, throttleMs: 0, asleep: false, stalled: false, timeupdates: true,
    credits: [], statuses: [], lookups: 0, dropCredits: false, srcSeq: 0, pageActions: [],
  };

  // ---- background (real engine code) ------------------------------------------
  let state = createDefaultState(t0);
  for (const id of registered) state = { ...state, library: addYouTubeVideo(state.library, { url: `https://youtu.be/${id}` }, t0).library };
  world.locked = false;
  const background = {
    handle(msg) {
      if (msg.type === 'tracker:credit') {
        world.credits.push(msg);
        if (world.locked) return { ok: false, locked: true, rejected: 'locked' };
        const source = msg.source;
        const r = recordCredit(state, { endMs: msg.endMs, active: msg.active, content: msg.content, source });
        state = r.state;
        return { ok: true, applied: r.appliedSeconds, appliedContent: r.appliedContent, rejected: r.rejected, targetStatus: r.targetStatus, locked: false };
      }
      if (msg.type === 'tracker:status') { world.statuses.push(msg); return { ok: true, locked: world.locked }; }
      if (msg.type === 'library:lookup') {
        world.lookups += 1;
        const { status, item } = targetStatus(state.library, msg.platform, msg.contentType, msg.targetId);
        return { ok: true, status, title: item?.title || null };
      }
      return { ok: false };
    },
  };
  world.state = () => state;
  world.setEnabled = (id, enabled, { broadcast = true } = {}) => {
    state = { ...state, library: setLibraryItemEnabled(state.library, `youtube:video:${id}`, enabled).library };
    if (broadcast) world.message({ type: 'library:changed' });
  };
  world.register = (id) => {
    state = { ...state, library: addYouTubeVideo(state.library, { url: `https://youtu.be/${id}` }, t0).library };
    world.message({ type: 'library:changed' });
  };
  const DAY = new Date(t0);
  const dayKey = `${DAY.getFullYear()}-${String(DAY.getMonth() + 1).padStart(2, '0')}-${String(DAY.getDate()).padStart(2, '0')}`;
  world.day = () => state.dailyHistory[dayKey] || { contentSeconds: 0, actualActiveSeconds: 0 };
  world.content = () => world.day().contentSeconds || 0;
  world.active = () => world.day().actualActiveSeconds || 0;
  world.sessions = () => Object.values(state.sessions || {});

  // ---- page ------------------------------------------------------------------------
  const win = new Emitter();
  const doc = new Emitter();
  const video = new FakeVideo();
  const player = { classes: new Set(), classList: { contains: (c) => player.classes.has(c) } };
  const flexy = { videoId: null, getAttribute: (n) => (n === 'video-id' ? flexy.videoId : null) };
  const titles = {};
  world.video = video;
  world.doc = doc;
  let location = new URL('https://www.youtube.com/');
  Object.assign(doc, {
    visibilityState: 'visible', fullscreenElement: null, documentElement: {}, title: 'YouTube',
    getElementsByTagName(tag) {
      if (tag !== 'video') return [];
      return { get length() { return video.isConnected ? 1 : 0; }, *[Symbol.iterator]() { if (video.isConnected) yield video; } };
    },
    querySelector(sel) {
      switch (sel) {
        case '#movie_player video.html5-main-video': case 'video.html5-main-video': return video.isConnected ? video : null;
        case '#movie_player': case '.html5-video-player': return player;
        case 'ytd-watch-flexy[video-id]': return flexy.videoId ? flexy : null;
        case 'ytd-watch-metadata h1': return flexy.videoId ? { textContent: titles[flexy.videoId] || '' } : null;
        default: return null;
      }
    },
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
        if (copy.type === 'tracker:credit' && world.dropCredits) throw new Error('Could not establish connection');
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
  const fire = (type) => doc.emit(type, video);
  let lastTimeupdate = clock.perf;

  async function runTimers() {
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= clock.perf).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) return;
      for (const [id, t] of due) { timers.delete(id); t.fn(); }
      await macrotask();
    }
  }

  /** Let `ms` of real time pass (video plays if playing; events and timers fire). */
  world.advance = async (ms) => {
    const end = clock.perf + ms;
    while (clock.perf < end) {
      const dt = Math.min(STEP_MS, end - clock.perf);
      clock.perf += dt;
      clock.wall += dt;
      for (const a of world.pageActions.filter((x) => x.at <= clock.perf)) { world.pageActions.splice(world.pageActions.indexOf(a), 1); a.fn(); }
      if (world.asleep) continue; // machine asleep: nothing runs, the video doesn't move
      const playing = !video.paused && !video.ended && video.readyState >= 2;
      if (playing && !world.stalled) {
        video.currentTime = Math.min(video.duration, video.currentTime + (dt / 1000) * video.playbackRate);
        if (video.currentTime >= video.duration) {
          video.paused = true; video.ended = true;
          fire('pause'); fire('ended');
        } else if (world.timeupdates && clock.perf - lastTimeupdate >= TIMEUPDATE_MS) {
          lastTimeupdate = clock.perf;
          fire('timeupdate');
        }
      }
      await runTimers();
      await macrotask();
    }
    for (let i = 0; i < 5; i += 1) await macrotask();
  };

  /** Load `id`'s media into the reused <video> (what the YouTube player does). */
  function loadMedia(id) {
    if (video.currentSrc) { video.readyState = 0; fire('emptied'); }
    video.currentSrc = `blob:https://www.youtube.com/${id}-${++world.srcSeq}`;
    video.currentTime = 0; video.duration = duration; video.ended = false;
    fire('loadstart');
    video.readyState = 4;
    fire('loadedmetadata'); fire('canplay');
  }

  world.open = async (id, { title = `Video ${id}` } = {}) => {
    location = new URL(`https://www.youtube.com/watch?v=${id}`);
    titles[id] = title;
    loadMedia(id);
    flexy.videoId = id;
    world.inject();
    await world.advance(100);
  };
  /** SPA navigation: URL first, then the source swap, page metadata later. */
  world.navigate = async (id, { title = `Video ${id}`, swapDelayMs = 0, keepPlaying = true } = {}) => {
    titles[id] = title;
    location = new URL(`https://www.youtube.com/watch?v=${id}`);
    doc.emit('yt-navigate-start', doc);
    const swap = () => {
      const wasPlaying = !video.paused;
      loadMedia(id);
      doc.emit('yt-navigate-finish', doc);
      if (keepPlaying && wasPlaying) { fire('play'); fire('playing'); }
    };
    if (swapDelayMs > 0) world.pageActions.push({ at: clock.perf + swapDelayMs, fn: swap }); else swap();
    world.pageActions.push({ at: clock.perf + swapDelayMs + 3500, fn: () => { flexy.videoId = id; doc.emit('yt-page-data-updated', doc); } });
  };
  /** URL changes with no media event at all (defence-in-depth case). */
  world.silentUrl = (id) => { location = new URL(`https://www.youtube.com/watch?v=${id}`); };
  world.leaveToHome = () => { location = new URL('https://www.youtube.com/'); doc.emit('yt-navigate-finish', doc); };
  world.play = () => { video.paused = false; fire('play'); fire('playing'); };
  world.pause = () => { video.paused = true; fire('pause'); };
  world.seekTo = (t) => { video.seeking = true; fire('seeking'); video.currentTime = t; video.seeking = false; fire('seeked'); };
  world.rate = (r) => { video.playbackRate = r; fire('ratechange'); };
  world.ad = (on) => { if (on) player.classes.add('ad-showing'); else player.classes.delete('ad-showing'); };
  world.hide = () => { doc.visibilityState = 'hidden'; doc.emit('visibilitychange', doc); };
  world.show = () => { doc.visibilityState = 'visible'; world.throttleMs = 0; doc.emit('visibilitychange', doc); };
  world.blur = () => win.emit('blur', win);
  world.focus = () => win.emit('focus', win);
  world.lock = (locked) => { world.locked = locked; world.message({ type: 'system:lock', locked }); };
  /** Let the popup-visible unsaved time reach the background (pause → flush). */
  world.settle = () => world.advance(1500);
  return world;
}
