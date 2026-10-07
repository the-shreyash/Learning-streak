/**
 * Site adapters for the content-script measurement loop (main.js).
 *
 * main.js owns HOW time is measured (the V1.2.1 loop: validated currentTime
 * progress, speed-aware, seek/pause/stall/lock rules, timeupdate-driven in the
 * background). An adapter only answers WHAT is on the page and WHETHER it may count:
 *
 *   platform                 'udemy' | 'youtube'
 *   isContentPage()          page kind that can host learning content
 *   pickVideo(videos)        the content <video>, or null
 *   contentKey()             identity of the content playing now (null = not tracked:
 *                            Udemy keeps V1 behaviour, lecture changes are media discontinuities)
 *   gate(video)              { ok } | { ok:false, reason } — e.g. not registered, ad playing
 *   refresh(onPage)          re-detect titles
 *   maintain(onPage)         periodic housekeeping (every flush period)
 *   creditFields(key)        fields merged into the tracker:credit message for content `key`
 *   statusFields()/statusKey()  what the popup / background status see
 *   onMedia(e), onMessage(msg), onCreditResponse(res, key)   optional hooks
 *   extraMediaEvents, navigationEvents   extra document events that trigger a tick
 */
(function (root) {
  'use strict';
  const NS = (root.__UdemyStreak = root.__UdemyStreak || {});
  const ALLOW = Object.freeze({ ok: true });

  // ---- Udemy: automatic (every lecture page counts), unchanged from V1.2.1 ----------
  function udemySite({ doc, videos }) {
    const det = NS.udemyDetector;
    let course = null;
    const courseCache = Object.create(null); // slug → confident title

    function refresh(onPage) {
      if (!onPage) { course = null; return; }
      const slug = det.getCourseSlug(root.location);
      if (!slug) { course = null; return; }
      if (courseCache[slug]) { course = { key: slug, title: courseCache[slug] }; return; }
      const detected = det.detectCourse(doc, root.location);
      if (detected) {
        if (detected.confident) courseCache[slug] = detected.title;
        course = { key: detected.key, title: detected.title };
      }
    }

    return {
      platform: 'udemy',
      isContentPage: () => det.isLearnPage(root.location),
      pickVideo: () => videos.getActiveVideo(),
      contentKey: () => null,
      gate: () => ALLOW,
      refresh,
      maintain(onPage) { if (!course) refresh(onPage); },
      creditFields: () => ({ course }),
      statusFields: () => ({ course }),
      statusKey: () => (course ? course.key : ''),
      extraMediaEvents: [],
      navigationEvents: [],
    };
  }

  // ---- YouTube: opt-in (only Learning Library videos count) ------------------------
  const RECHECK_MS = 30_000;    // re-confirm registration this often while on a video
  const RETRY_MS = 2_000;       // min gap between lookups of the same video
  const MAX_OWNERS = 64;

  function youtubeSite({ doc, send, requestTick }) {
    const det = NS.youtubeDetector;
    const auth = new Map();     // videoId → { status, title, at }
    const asked = new Map();    // videoId → perf time of the last lookup
    const titles = new Map();   // videoId → page title
    // Media source → the video ID the URL showed when that source loaded. YouTube
    // swaps the <video>'s source on SPA navigation; time may only be credited to a
    // video ID while the element plays a source loaded FOR that ID.
    const owners = new Map();

    const currentId = () => det.videoIdFromLocation(root.location);

    function lookup(id) {
      const now = performance.now();
      if (now - (asked.get(id) ?? -Infinity) < RETRY_MS) return;
      asked.set(id, now);
      send({ type: 'library:lookup', platform: 'youtube', contentType: 'video', targetId: id }).then((res) => {
        if (!res || res.ok !== true) return;
        auth.set(id, { status: res.status, title: res.title || null, at: performance.now() });
        requestTick();
      }).catch(() => { /* background unreachable: stay unauthorized, retry later */ });
    }

    function bind(src, id) {
      if (!src || !id) return;
      if (owners.size >= MAX_OWNERS) owners.clear();
      owners.set(src, id);
    }

    /** Does the element play media that was loaded for `id`? */
    function mediaBelongsTo(video, id) {
      const src = video.currentSrc;
      if (!src || owners.get(src) === id) return true; // nothing loaded → nothing can progress anyway
      // The page itself has caught up with this ID (ytd-watch-flexy, seconds after the
      // URL): only then is a source seen under another ID re-attributed.
      if (det.pageVideoId(doc) === id) { bind(src, id); return true; }
      return false;
    }

    function gate(video) {
      const id = currentId();
      if (!id) return { ok: false, reason: 'not-learn-page' };
      // Observe source ownership on EVERY watch page, registered or not, so a source
      // first seen on an unregistered video can never be claimed by the next one.
      // (First sight also covers a script injected while a video is already playing.)
      if (video && video.currentSrc && !owners.has(video.currentSrc)) bind(video.currentSrc, id);
      const a = auth.get(id);
      if (!a) { lookup(id); return { ok: false, reason: 'checking' }; }
      if (a.status !== 'registered') return { ok: false, reason: a.status === 'disabled' ? 'disabled' : 'not-registered' };
      if (video && !mediaBelongsTo(video, id)) return { ok: false, reason: 'loading' };
      if (det.adShowing(doc)) return { ok: false, reason: 'ad' };
      return ALLOW;
    }

    function refresh(onPage) {
      const id = onPage ? currentId() : null;
      const t = id && det.pageTitle(doc, id);
      if (t) titles.set(id, t);
    }

    const registrationOf = (id) => (id ? auth.get(id)?.status || 'checking' : null);

    return {
      platform: 'youtube',
      isContentPage: () => !!currentId(),
      pickVideo() { const v = det.mainVideo(doc); return v && v.isConnected ? v : null; },
      contentKey: currentId,
      gate,
      refresh,
      maintain(onPage) {
        refresh(onPage);
        const id = onPage ? currentId() : null;
        const a = id && auth.get(id);
        if (a && performance.now() - a.at > RECHECK_MS) lookup(id); // keeps the old answer until the new one arrives
      },
      creditFields(key) {
        return { source: { platform: 'youtube', contentType: 'video', contentId: key, courseTitle: titles.get(key) || null } };
      },
      statusFields() {
        const id = currentId();
        return { platform: 'youtube', video: id ? { id, title: auth.get(id)?.title || titles.get(id) || null } : null, registration: registrationOf(id) };
      },
      statusKey() { const id = currentId(); return `${id || ''}|${registrationOf(id) || ''}`; },
      onMedia(e) {
        // A new source starts loading: it belongs to the video the URL shows now
        // (YouTube updates the URL before it swaps the source).
        if ((e.type === 'loadstart' || e.type === 'loadedmetadata') && e.target === det.mainVideo(doc)) {
          const src = e.target.currentSrc;
          if (src && !owners.has(src)) bind(src, currentId());
        }
      },
      onMessage(msg) {
        if (msg.type !== 'library:changed') return false;
        for (const a of auth.values()) a.at = -Infinity; // stale: re-confirm, keep answer until then
        asked.clear();
        const id = currentId();
        if (id) lookup(id);
        return true;
      },
      onCreditResponse(res, key) {
        // The background is the authority: a rejected credit updates our view at once.
        if (res && typeof res.targetStatus === 'string' && key) {
          const prev = auth.get(key);
          auth.set(key, { status: res.targetStatus, title: prev?.title || null, at: performance.now() });
        }
      },
      extraMediaEvents: ['loadstart'],
      navigationEvents: ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated'],
    };
  }

  function create(ctx) {
    const host = String(root.location?.hostname || '').toLowerCase();
    if (/(^|\.)udemy\.com$/.test(host) && NS.udemyDetector) return udemySite(ctx);
    if (host === 'www.youtube.com' && NS.youtubeDetector) return youtubeSite(ctx);
    return null;
  }

  NS.sites = { create };
})(globalThis);
