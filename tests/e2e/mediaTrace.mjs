/**
 * Diagnostics only (printed for failed checks): a passive in-page log of the
 * lecture video's media events, plus Chrome's own media-pipeline messages.
 * It only listens — it never plays, pauses, seeks, changes the rate, or keeps
 * the tab awake (no timers, no wake locks, no extra messages to the extension).
 */
const MEDIA_EVENTS = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'suspend',
  'seeking', 'seeked', 'ratechange', 'ended', 'emptied', 'error', 'timeupdate'];

/**
 * @param cdp     CDP client
 * @param call    evaluates an expression in the lecture page
 * @param scope   CSS selector the traced <video> must sit inside (other videos on the page are ignored)
 */
export function createMediaTrace(cdp, call, scope = '.player-zone') {
  let chromeMedia = [];
  let t0 = Date.now();

  /** Subscribe to Chrome's media-pipeline log for the page session (CDP Media domain). */
  async function attach(session) {
    await cdp.send('Media.enable', {}, session);
    cdp.on((msg) => {
      if (msg.sessionId !== session) return;
      const p = msg.params || {};
      const at = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}`;
      const who = `player ${String(p.playerId || '').slice(0, 6)}`;
      if (msg.method === 'Media.playersCreated') chromeMedia.push(`${at()}  created ${(p.players || []).map((x) => String(x.playerId || x).slice(0, 6)).join(', ')}`);
      if (msg.method === 'Media.playerMessagesLogged') for (const x of p.messages) chromeMedia.push(`${at()}  ${who} [${x.level}] ${x.message}`);
      if (msg.method === 'Media.playerErrorsRaised') for (const x of p.errors) chromeMedia.push(`${at()}  ${who} [error] ${x.errorType} ${x.code}`);
      if (msg.method === 'Media.playerEventsAdded') for (const x of p.events) chromeMedia.push(`${at()}  ${who} [event] ${x.value}`);
    });
  }

  /** Install the in-page listeners (idempotent; document capture listeners also cover a replaced <video>). */
  const install = () => call(`(() => {
    if (window.__trace) return true;
    const ids = new WeakMap(); let next = 0;
    window.__trace = { t0: performance.now(), log: [], lastTu: new WeakMap() };
    const rec = (ev, v) => {
      if (!v || !v.closest || !v.closest(${JSON.stringify(scope)})) return;
      const tr = window.__trace; const now = performance.now();
      if (ev === 'timeupdate') { if (now - (tr.lastTu.get(v) ?? -1e9) < 2000) return; tr.lastTu.set(v, now); }
      if (!ids.has(v)) ids.set(v, ++next);
      tr.log.push({ s: (now - tr.t0) / 1000, ev, el: ids.get(v), ct: v.currentTime, paused: v.paused, rate: v.playbackRate, rs: v.readyState, ns: v.networkState,
        vis: document.visibilityState, focus: document.hasFocus(), path: location.pathname });
    };
    for (const ev of ${JSON.stringify(MEDIA_EVENTS)}) document.addEventListener(ev, (e) => rec(ev, e.target), true);
    for (const ev of ['visibilitychange', 'freeze', 'resume']) document.addEventListener(ev, () => rec(ev, document.querySelector(${JSON.stringify(scope)} + ' video')), true);
    return true;
  })()`);

  /** Start a fresh trace window (call before the scenario). */
  async function start() {
    await install();
    await call(`(() => { const t = window.__trace; t.log = []; t.t0 = performance.now(); t.lastTu = new WeakMap(); return true; })()`);
    chromeMedia = [];
    t0 = Date.now();
  }

  /** Collect what was recorded since start(). */
  async function take() {
    const events = await call(`(() => { const out = window.__trace.log; window.__trace.log = []; return out; })()`);
    return { events, chromeMedia: chromeMedia.slice() };
  }

  return { attach, start, take };
}

export function printTrace({ events, chromeMedia }) {
  console.log('      video trace (s since scenario start: event, element #, currentTime, paused, rate, readyState, networkState, visibility, focus, path):');
  const prev = new Map();
  let path = null;
  for (const e of events) {
    const p = prev.get(e.el);
    const gap = p && !p.paused && e.ev === 'timeupdate' && e.s - p.s > 4 ? `   ⚠ ${(e.s - p.s).toFixed(1)} s since this video's last event while playing, it moved ${(e.ct - p.ct).toFixed(1)} s` : '';
    const showPath = e.path !== path ? ` ${e.path}` : '';
    path = e.path;
    console.log(`        +${e.s.toFixed(1).padStart(6)}  ${e.ev.padEnd(16)} #${e.el} ct=${e.ct.toFixed(2).padStart(8)} paused=${e.paused} rate=${e.rate} rs=${e.rs} ns=${e.ns} ${e.vis}${e.focus ? ' focused' : ''}${showPath}${gap}`);
    prev.set(e.el, e);
  }
  if (!events.length) console.log('        (no media events recorded)');
  if (chromeMedia.length) {
    console.log(`      Chrome media pipeline messages (${chromeMedia.length}${chromeMedia.length > 60 ? ', last 60 shown' : ''}; includes the page's muted thumbnail video):`);
    for (const x of chromeMedia.slice(-60)) console.log(`        ${x.length > 220 ? `${x.slice(0, 220)}…` : x}`);
  }
}
