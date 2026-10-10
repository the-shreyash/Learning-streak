/**
 * Deterministic harness for the REAL content scripts (the files and order the
 * manifest injects on www.youtube.com), run in a node:vm sandbox with:
 *   - a fake clock (performance.now / Date.now / setTimeout) with optional
 *     background-tab timer throttling,
 *   - a fake YouTube watch page: one reused <video class="html5-main-video">
 *     whose source is swapped on SPA navigation (URL first, then emptied →
 *     loadstart, page metadata ~3.5 s later — as observed on youtube.com),
 *   - a fake playlist panel (ytd-playlist-panel-renderer) behaving as observed on
 *     youtube.com for Phase C: an unrelated video opened with `list=P` gets P's
 *     real items with nothing selected; on SPA navigation `selected` moves ~2 s
 *     after the URL; leaving P hides the panel but keeps its stale items/selection,
 *   - a fake background that answers with the REAL engine code
 *     (recordCredit / targetStatus / knownMembership / addProvenMembers) over an
 *     in-memory state (the page is the reporting tab, which the background's
 *     `library:changed` broadcast after new members skips).
 * Nothing here re-implements measurement: it only plays a video and lets time pass.
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { mod, SRC } from './helpers.mjs';

const { recordCredit } = await mod('core/learningEngine.js');
const { targetStatus, knownMembership, addYouTubeVideo, addYouTubePlaylist, setLibraryItemEnabled } = await mod('core/learningLibrary.js');
const { addProvenMembers } = await mod('core/playlistMembership.js');
const { createDefaultState } = await mod('core/schema.js');

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', SRC), 'utf8'));
const SCRIPT_FILES = manifest.content_scripts.find((c) => c.matches.includes('https://www.youtube.com/*')).js;
const SCRIPTS = SCRIPT_FILES.map((f) => ({ f, code: readFileSync(new URL(`../${f}`, SRC), 'utf8') }));

const STEP_MS = 50;
const PANEL_SELECT_MS = 2000; // observed: `selected` follows the URL ~2–2.6 s later
const PANEL_SEL = 'ytd-watch-flexy ytd-playlist-panel-renderer#playlist';
const ITEM_SEL = 'ytd-playlist-panel-video-renderer';
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

/**
 * @param {object} o
 * @param {string[]} [o.registered]  video IDs in the Learning Library
 * @param {Object<string,string[]>} [o.playlists]  YouTube's playlist contents (what the panel would load)
 * @param {string[]} [o.registeredPlaylists]  playlist IDs in the Learning Library
 * @param {Object<string,string[]>} [o.membership]  video IDs already PROVEN members (from an earlier visit)
 * @param {string[]} [o.disabledVideos]  registered video IDs that start disabled
 */
export function createWorld({ registered = [], playlists = {}, registeredPlaylists = [], membership = {}, disabledVideos = [], t0 = new Date(2026, 9, 7, 15, 0, 0).getTime(), duration = 1800 } = {}) {
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
  for (const id of registeredPlaylists) state = { ...state, library: addYouTubePlaylist(state.library, { url: `https://www.youtube.com/playlist?list=${id}`, title: `Playlist ${id.slice(0, 6)}` }, t0).library };
  for (const [list, ids] of Object.entries(membership)) state = { ...state, playlistMembership: addProvenMembers(state.playlistMembership, state.library, list, ids, t0).membership };
  for (const id of disabledVideos) state = { ...state, library: setLibraryItemEnabled(state.library, `youtube:video:${id}`, false).library };
  world.locked = false;
  world.memberReports = [];
  const background = {
    handle(msg) {
      if (msg.type === 'tracker:credit') {
        world.credits.push(msg);
        if (world.locked) return { ok: false, locked: true, rejected: 'locked' };
        const source = msg.source;
        const r = recordCredit(state, { endMs: msg.endMs, active: msg.active, content: msg.content, source });
        state = r.state;
        return { ok: true, applied: r.appliedSeconds, appliedContent: r.appliedContent, rejected: r.rejected, targetStatus: r.targetStatus, videoStatus: r.videoStatus, playlistStatus: r.playlistStatus, locked: false };
      }
      if (msg.type === 'tracker:status') { world.statuses.push(msg); return { ok: true, locked: world.locked }; }
      if (msg.type === 'library:lookup') {
        world.lookups += 1;
        const { status, item } = targetStatus(state.library, msg.platform, msg.contentType, msg.targetId);
        const known = msg.contentType === 'video' ? knownMembership(state.library, state.playlistMembership, msg.targetId) : null;
        return { ok: true, status, title: item?.title || null, ...(known ? { known } : {}) };
      }
      if (msg.type === 'playlist:members') {
        world.memberReports.push(msg);
        const r = addProvenMembers(state.playlistMembership, state.library, msg.playlistId, msg.videoIds, clock.wall);
        if (r.added.length) state = { ...state, playlistMembership: r.membership };
        return { ok: true, added: r.added };
      }
      return { ok: false };
    },
  };
  world.state = () => state;
  world.members = (list) => state.playlistMembership?.[list]?.videoIds || [];
  world.setEnabled = (id, enabled, { broadcast = true } = {}) => {
    state = { ...state, library: setLibraryItemEnabled(state.library, `youtube:video:${id}`, enabled).library };
    if (broadcast) world.message({ type: 'library:changed' });
  };
  world.register = (id) => {
    state = { ...state, library: addYouTubeVideo(state.library, { url: `https://youtu.be/${id}` }, t0).library };
    world.message({ type: 'library:changed' });
  };
  world.registerPlaylist = (id) => {
    state = { ...state, library: addYouTubePlaylist(state.library, { url: `https://www.youtube.com/playlist?list=${id}` }, t0).library };
    world.message({ type: 'library:changed' });
  };
  world.setPlaylistEnabled = (id, enabled, { broadcast = true } = {}) => {
    state = { ...state, library: setLibraryItemEnabled(state.library, `youtube:playlist:${id}`, enabled).library };
    if (broadcast) world.message({ type: 'library:changed' });
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
  // The watch page's playlist panel. Once shown it stays in the DOM (hidden when unused).
  const panel = { inDom: false, list: null, items: [], selected: null, hidden: true, title: null };
  world.panel = panel;
  const panelEl = {
    get hidden() { return panel.hidden; },
    hasAttribute: (n) => n === 'hidden' && panel.hidden,
    querySelectorAll(sel) {
      if (sel === ITEM_SEL) {
        return panel.items.map((v, i) => ({
          hasAttribute: (n) => n === 'selected' && panel.selected === v,
          querySelector: (s) => (s === 'a#wc-endpoint' ? { getAttribute: (n) => (n === 'href' ? `/watch?v=${v}&list=${panel.list}&index=${i + 1}` : null) } : null),
        }));
      }
      if (sel === 'a[href*="/playlist?list="]') return panel.title ? [{ getAttribute: () => `/playlist?list=${panel.list}`, textContent: panel.title }] : [];
      return [];
    },
  };
  /** What YouTube renders for `list` next to video `id`: the playlist's real items; `id` selected only if it's one of them. */
  function loadPanel(list, id) {
    const items = playlists[list] || [];
    Object.assign(panel, { inDom: true, list, items: [...items], selected: items.includes(id) ? id : null, hidden: false, title: `YouTube title of ${list}` });
  }
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
        case PANEL_SEL: return panel.inDom ? panelEl : null;
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

  const watchUrl = (id, list) => new URL(`https://www.youtube.com/watch?v=${id}${list ? `&list=${list}` : ''}`);

  /**
   * Hard load of a watch page (optionally with `list=`): the panel is there from the start.
   * `panel`: 'none' = YouTube renders no panel, 'unselected' = no item marked current
   * (both from the first frame, so membership is never proven on this page).
   */
  world.open = async (id, { title = `Video ${id}`, list = null, panel: panelMode = 'normal' } = {}) => {
    location = watchUrl(id, list);
    titles[id] = title;
    loadMedia(id);
    flexy.videoId = id;
    if (list) loadPanel(list, id); else panel.hidden = true;
    if (panelMode === 'none') panel.inDom = false;
    if (panelMode === 'unselected') panel.selected = null;
    world.inject();
    await world.advance(100);
  };
  /**
   * SPA navigation: URL first, then the source swap; the playlist panel's selection
   * ~2 s later, page metadata ~3.5 s later. Without `list` the panel is hidden
   * but keeps its stale items and selection (as on youtube.com).
   */
  world.navigate = async (id, { title = `Video ${id}`, swapDelayMs = 0, keepPlaying = true, list = null } = {}) => {
    titles[id] = title;
    location = watchUrl(id, list);
    world.pageActions.push({ at: clock.perf + PANEL_SELECT_MS, fn: () => {
      if (!list) { panel.hidden = true; return; }
      if (panel.inDom && !panel.hidden && panel.list === list) panel.selected = panel.items.includes(id) ? id : null;
      else loadPanel(list, id);
    } });
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
  world.silentUrl = (id, list = null) => { location = watchUrl(id, list); };
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
