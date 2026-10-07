/**
 * Content-script orchestrator. Runs on Udemy and YouTube pages; stays dormant (a
 * cheap URL check every few seconds) except on content pages — Udemy lecture
 * pages (/course/<slug>/learn/…) and YouTube watch pages (/watch?v=…).
 * V2.1: what is on the page and whether it may count is the site adapter's job
 * (sites.js); this loop — how time is measured — is shared and unchanged.
 *
 * Measurement loop (see activityRules.js for the counting rule):
 *   every TICK_MS while a video plays, and immediately on every relevant event
 *   (play/pause/seek/rate change/visibility/focus/blur/popup/lock), we
 *     1. close the open interval → measure content (validated currentTime growth)
 *        and active real time (see activityRules.js)
 *     2. re-evaluate the counting conditions
 *     3. open a new interval if they all hold
 *   Unsaved credit is flushed to the background at most every FLUSH_MS and
 *   immediately whenever counting stops or the page is unloaded.
 *   V1.2: a hidden tab / unfocused window keeps counting while the video plays;
 *   visibility/focus events only trigger an immediate re-measurement.
 *   V1.2.1: the video's own timeupdate events also drive measurement, so a
 *   throttled background timer can't stall it.
 *
 * This script only OBSERVES. It never changes playback, never touches Udemy's
 * progress, and never dispatches synthetic input.
 */
(function (root) {
  'use strict';
  const NS = root.__UdemyStreak;
  if (!NS || !NS.VideoTracker || !NS.ActivityTracker || !NS.sites) return;
  const { RULES, measureInterval, evaluateConditions, VideoTracker, ActivityTracker } = NS;
  const doc = root.document;

  // ---- Single-instance guard ---------------------------------------------------
  // After an extension reload/update the old script is orphaned but may still run.
  // The new instance announces itself through a DOM event (DOM events cross
  // isolated worlds); older instances tear themselves down.
  const INSTANCE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const TAKEOVER_EVENT = 'udemy-learning-streak:takeover';
  doc.dispatchEvent(new CustomEvent(TAKEOVER_EVENT, { detail: INSTANCE_ID }));

  const abort = new AbortController();
  const signal = abort.signal;
  let alive = true;

  const s = {
    href: '',
    onLearnPage: false,
    hasVideo: false,
    counting: false,
    reason: 'not-learn-page',
    baseline: null,            // { video, perf, media, rate, src, key }
    pendingActive: 0,          // measured real seconds, not yet sent
    pendingContent: 0,         // measured lecture-content seconds, not yet sent
    pendingEndMs: 0,           // real timestamp of the last credited instant
    pendingKey: null,          // content the pending time belongs to (site.contentKey())
    outbox: [],                // sealed chunks { active, content, endMs, key }, sent in order
    currentRate: 1,             // last observed video.playbackRate (for the popup)
    lastFlushPerf: performance.now(),
    flushing: false,
    timer: null,
    observer: null,
    mutationPending: false,
    lastStatusKey: '',
    lastLockPollPerf: 0,
  };

  const contextValid = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch { return false; } };

  const videos = new VideoTracker(doc);
  const activity = new ActivityTracker({ onChange: () => tick(), signal });
  const site = NS.sites.create({ doc, videos, send: (m) => send(m), requestTick: () => setTimeout(() => tick(), 0) });
  if (!site) return;

  // ---- SPA navigation ---------------------------------------------------------------
  function checkUrl() {
    if (root.location.href === s.href) return;
    s.href = root.location.href;
    const was = s.onLearnPage;
    s.onLearnPage = site.isContentPage();
    if (s.onLearnPage && !was) startObserver();
    if (!s.onLearnPage && was) stopObserver();
    site.refresh(s.onLearnPage);
  }

  function startObserver() {
    if (s.observer || !doc.documentElement) return;
    // Cheap O(1) check per mutation batch; only reacts when the lecture video
    // appears, disappears or is replaced.
    s.observer = new MutationObserver(() => {
      if (s.mutationPending) return;
      const lost = s.baseline && !s.baseline.video.isConnected;
      const appeared = !s.hasVideo && videos.liveVideos.length > 0;
      if (!lost && !appeared) return;
      s.mutationPending = true;
      setTimeout(() => { s.mutationPending = false; tick(); }, 300);
    });
    s.observer.observe(doc.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (s.observer) { s.observer.disconnect(); s.observer = null; }
  }

  // ---- Measurement -------------------------------------------------------------------
  function closeInterval(nowPerf, seeked) {
    const b = s.baseline;
    s.baseline = null;
    if (!b || !b.video) return;
    // The content changed during the interval (e.g. YouTube SPA navigation to
    // another video): nothing in it can be attributed to either video → drop it.
    if (b.key !== site.contentKey()) return;
    // Always measure the SAME element the interval started on. A replaced element
    // (connected=false) or a new source yields 0; the next interval starts fresh.
    const { active, content } = measureInterval(
      b,
      { perf: nowPerf, media: b.video.currentTime, src: b.video.currentSrc, connected: b.video.isConnected },
      { seeked },
    );
    if (active > 0 || content > 0) {
      if (s.pendingKey !== b.key) seal(); // never mix two contents in one credit
      s.pendingKey = b.key;
      s.pendingActive += active;
      s.pendingContent += content;
      s.pendingEndMs = Date.now();
    }
  }

  function tick(opts = {}) {
    if (!alive) return;
    if (!contextValid()) { teardown(); return; }

    const nowPerf = performance.now();
    closeInterval(nowPerf, !!opts.seeked);
    checkUrl();

    const video = s.onLearnPage ? site.pickVideo(videos) : null;
    s.hasVideo = !!video;
    const vs = VideoTracker.snapshot(video) || {};
    const gate = s.onLearnPage ? site.gate(video) : null;
    const cond = evaluateConditions({ onLearnPage: s.onLearnPage, gate, hasVideo: !!video, ...vs, ...activity.snapshot() });

    if (cond.ok) {
      s.baseline = { video, perf: nowPerf, media: vs.currentTime, rate: vs.playbackRate > 0 ? vs.playbackRate : 1, src: video.currentSrc, key: site.contentKey() };
    }
    if (video) s.currentRate = vs.playbackRate > 0 ? vs.playbackRate : 1;
    s.counting = cond.ok;
    s.reason = cond.reason;

    const due = nowPerf - s.lastFlushPerf >= RULES.FLUSH_MS;
    if (hasPending() && (!cond.ok || due || opts.forceFlush)) flush();
    if (due) site.maintain(s.onLearnPage);

    sendStatusIfChanged(nowPerf);
    schedule(video);
  }

  function schedule(video) {
    clearTimeout(s.timer);
    if (!alive) return;
    let delay = RULES.DORMANT_SCAN_MS;
    if (s.onLearnPage) delay = video && !video.paused && !video.ended ? RULES.TICK_MS : RULES.IDLE_SCAN_MS;
    if (s.onLearnPage && !video) videos.deepScan();
    s.timer = setTimeout(() => tick(), delay);
  }

  // ---- Messaging -----------------------------------------------------------------------
  function send(msg) {
    return chrome.runtime.sendMessage(msg).then((res) => {
      if (res && typeof res.locked === 'boolean' && res.locked !== activity.systemLocked) {
        activity.setLocked(res.locked);
        setTimeout(() => tick(), 0);
      }
      return res;
    });
  }

  function hasPending() { return s.pendingActive > 0 || s.pendingContent > 0 || s.outbox.length > 0; }

  /** Move the pending time into the outbox as one chunk for one content. */
  function seal() {
    if (!(s.pendingActive > 0 || s.pendingContent > 0)) return;
    s.outbox.push({ active: s.pendingActive, content: s.pendingContent, endMs: s.pendingEndMs || Date.now(), key: s.pendingKey });
    s.pendingActive = 0;
    s.pendingContent = 0;
  }

  const unsaved = (f) => s.outbox.reduce((a, c) => a + c[f], f === 'active' ? s.pendingActive : s.pendingContent);

  /** Send every sealed chunk, oldest first. A chunk leaves the outbox only once delivered. */
  async function flush() {
    seal();
    s.lastFlushPerf = performance.now();
    if (s.flushing || !s.outbox.length) return; // a running flush drains what was just sealed
    s.flushing = true;
    try {
      while (s.outbox.length && alive) {
        const chunk = s.outbox[0];
        site.refresh(s.onLearnPage);
        let res;
        try {
          res = await send({ type: 'tracker:credit', active: chunk.active, content: chunk.content, endMs: chunk.endMs, ...site.creditFields(chunk.key), counting: s.counting });
        } catch {
          if (!contextValid()) { teardown(); return; }
          break; // background unreachable (e.g. worker restarting): keep the chunk, retry on the next flush
        }
        s.outbox.shift();
        if (site.onCreditResponse) site.onCreditResponse(res, chunk.key);
      }
    } finally {
      s.flushing = false;
    }
  }

  function sendStatusIfChanged(nowPerf) {
    const key = `${s.counting}|${s.reason}|${site.statusKey()}`;
    // While locked, poll occasionally so we notice the unlock even if a broadcast was missed.
    const lockPoll = s.reason === 'locked' && nowPerf - s.lastLockPollPerf > RULES.IDLE_SCAN_MS;
    if (key === s.lastStatusKey && !lockPoll) return;
    s.lastStatusKey = key;
    s.lastLockPollPerf = nowPerf;
    send({ type: 'tracker:status', counting: s.counting, reason: s.reason, ...site.statusFields() }).catch(() => {});
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!alive || !msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'popup:ping') {
      tick();
      sendResponse({
        onLearnPage: s.onLearnPage,
        hasVideo: s.hasVideo,
        counting: s.counting,
        reason: s.reason,
        unsavedActive: unsaved('active'),
        unsavedContent: unsaved('content'),
        playbackRate: s.hasVideo ? s.currentRate : null,
        platform: site.platform,
        ...site.statusFields(),
      });
      return false;
    }
    if (site.onMessage && site.onMessage(msg)) {
      tick();
      return false;
    }
    if (msg.type === 'system:lock') {
      activity.setLocked(!!msg.locked);
      tick();
      return false;
    }
    return false;
  }

  // ---- Lifecycle -------------------------------------------------------------------------
  function teardown() {
    if (!alive) return;
    if (contextValid() && hasPending()) { try { flush(); } catch { /* ignore */ } }
    alive = false;
    abort.abort();
    clearTimeout(s.timer);
    stopObserver();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* context gone */ }
  }

  doc.addEventListener(TAKEOVER_EVENT, (e) => { if (e.detail !== INSTANCE_ID) teardown(); }, { signal });

  // Media events don't bubble, but they DO pass through the capture phase of the
  // document — one listener set covers every current and future <video>.
  const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'ratechange', 'emptied', 'loadedmetadata', 'waiting', 'stalled', 'canplay', ...site.extraMediaEvents];
  const onMedia = (e) => {
    if (!e.target || e.target.tagName !== 'VIDEO') return;
    videos.noteMediaEvent(e);
    if (site.onMedia) site.onMedia(e);
    tick({ seeked: e.type === 'seeking' || e.type === 'emptied' });
  };
  for (const type of MEDIA_EVENTS) doc.addEventListener(type, onMedia, { capture: true, signal });

  // V1.2.1: the playing video's own `timeupdate` (≈4/s, driven by the media
  // pipeline, not by page timers) also closes the interval — so measurement keeps
  // its ≈1 s cadence in a background tab even when Chrome throttles setTimeout.
  // The tick timer remains as a fallback. Each tick still validates real progress
  // (currentTime vs. elapsed real time); an event alone never adds time.
  doc.addEventListener('timeupdate', (e) => {
    const b = s.baseline;
    if (!b || e.target !== b.video) return;
    // The content switched under a running interval (SPA navigation): stop at once.
    if (b.key !== site.contentKey() || performance.now() - b.perf >= RULES.TICK_MS) tick();
  }, { capture: true, signal });

  root.addEventListener('pagehide', () => tick({ forceFlush: true }), { capture: true, signal });
  root.addEventListener('popstate', () => tick(), { signal });
  doc.addEventListener('fullscreenchange', () => tick(), { signal });
  for (const type of site.navigationEvents) doc.addEventListener(type, () => tick(), { capture: true, signal });

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  tick();
})(globalThis);
