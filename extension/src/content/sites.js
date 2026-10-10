/**
 * Site adapters for the content-script measurement loop (main.js).
 *
 * main.js owns HOW time is measured (the V1.2.1 loop: validated currentTime
 * progress, speed-aware, seek/pause/stall/lock rules, timeupdate-driven in the
 * background). An adapter only answers WHAT is on the page and WHETHER it may count:
 *
 *   platform                 'udemy' | 'youtube' | 'coursera'
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

  // ---- YouTube: opt-in (only Learning Library content counts) ----------------------
  // A video counts when (1) it is itself an enabled Library video (its own entry,
  // enabled or disabled, always decides first), or (2) it was proven before to be
  // in an enabled Library playlist (the background's membership index — wherever
  // it is opened now: search, home, history, direct URL), or (3) the URL names an
  // enabled Library playlist AND the page proves the video is in it
  // (youtubePlaylist.js); the items that proof shows are then reported to the
  // background as proven members. `list=` alone, titles, channels, the panel being
  // shown, the previous video or autoplay never authorize anything.
  const RECHECK_MS = 30_000;    // re-confirm registration this often while on a video
  const RETRY_MS = 2_000;       // min gap between lookups of the same target
  const REPORT_MS = 5_000;      // min gap between membership reports for one playlist video
  const MAX_OWNERS = 64;

  function youtubeSite({ doc, send, requestTick }) {
    const det = NS.youtubeDetector;
    const playlists = NS.youtubePlaylist;
    const auth = new Map();     // `${type}:${targetId}` → { status, title, at }
    const asked = new Map();    // same key → perf time of the last lookup
    const titles = new Map();   // videoId → page title
    const playlistTitles = new Map(); // playlistId → title YouTube shows in the playlist panel
    const reported = new Map(); // playlistId → Set of video IDs the background accepted as proven members
    const reportedAt = new Map(); // `${playlistId}|${videoId}` → perf time of the last report
    // Media source → the video ID the URL showed when that source loaded. YouTube
    // swaps the <video>'s source on SPA navigation; time may only be credited to a
    // video ID while the element plays a source loaded FOR that ID.
    const owners = new Map();

    const currentId = () => det.videoIdFromLocation(root.location);
    const currentList = () => det.playlistIdFromLocation(root.location);
    const authOf = (type, id) => auth.get(`${type}:${id}`);

    function lookup(type, id) {
      const k = `${type}:${id}`;
      const now = performance.now();
      if (now - (asked.get(k) ?? -Infinity) < RETRY_MS) return;
      asked.set(k, now);
      send({ type: 'library:lookup', platform: 'youtube', contentType: type, targetId: id }).then((res) => {
        if (!res || res.ok !== true) return;
        // `known`: a registered playlist this video was PROVEN to be in before (videos only).
        const known = res.known && typeof res.known.status === 'string' ? { status: res.known.status, playlistId: res.known.playlistId || null, title: res.known.title || null } : null;
        auth.set(k, { status: res.status, title: res.title || null, known, at: performance.now() });
        requestTick();
      }).catch(() => { /* background unreachable: stay unauthorized, retry later */ });
    }

    /**
     * May video `id` count right now, and through what? Resolved afresh on every
     * call — nothing carries over from the previous video.
     * @returns {{ok:true, via:'video'} | {ok:true, via:'playlist', playlistId} | {ok:false, reason, playlistId?}}
     */
    function route(id) {
      const v = authOf('video', id);
      if (!v) { lookup('video', id); return { ok: false, reason: 'checking' }; }
      if (v.at === -Infinity) lookup('video', id); // stale (Library changed): re-confirm, keep the answer until then
      if (v.status === 'registered') return { ok: true, via: 'video' }; // exact video first
      if (v.status === 'disabled') return { ok: false, reason: 'disabled' };
      // Proven live in the playlist being played: that playlist gets the attribution.
      const list = currentList();
      const live = list ? livePlaylist(id, list) : null;
      if (live && live.ok) return live;
      // Proven earlier: no panel (and no `list=`) needed any more.
      if (v.known && v.known.status === 'registered' && v.known.playlistId) return { ok: true, via: 'playlist', playlistId: v.known.playlistId };
      if (live) return live;
      return { ok: false, reason: v.known && v.known.status === 'disabled' ? 'disabled' : 'not-registered' };
    }

    /** Does the page prove `id` is in `list`, an enabled Library playlist, right now? */
    function livePlaylist(id, list) {
      const p = authOf('playlist', list);
      if (!p) { lookup('playlist', list); return { ok: false, reason: 'checking' }; }
      if (p.status !== 'registered') return { ok: false, reason: p.status === 'disabled' ? 'disabled' : 'not-registered' };
      const m = playlists.resolveMembership(doc, id, list);
      if (m.status === 'member') return { ok: true, via: 'playlist', playlistId: list, live: true };
      return { ok: false, reason: m.status === 'not-member' ? 'not-in-playlist' : 'playlist-unverified', playlistId: list };
    }

    /**
     * While the panel proves `id` is in `list`, report the items it shows as proven
     * members (only those YouTube rendered; never inferred). Only IDs not yet
     * accepted are sent; the background merges idempotently.
     */
    function reportMembers(id, list) {
      const k = `${list}|${id}`;
      const now = performance.now();
      if (now - (reportedAt.get(k) ?? -Infinity) < REPORT_MS) return;
      reportedAt.set(k, now);
      if (reportedAt.size > MAX_OWNERS) reportedAt.clear();
      const ids = playlists.provenMembers(doc, id, list);
      if (!ids) return;
      const done = reported.get(list) || new Set();
      const fresh = ids.filter((v) => !done.has(v));
      if (!fresh.length) return;
      send({ type: 'playlist:members', playlistId: list, videoIds: fresh }).then((res) => {
        if (!res || res.ok !== true) return;
        if (!reported.has(list)) reported.set(list, done);
        for (const v of fresh) done.add(v);
        // Cached "not registered" answers for these videos are out of date now.
        const title = authOf('playlist', list)?.title || null;
        for (const v of Array.isArray(res.added) ? res.added : []) {
          const a = authOf('video', v);
          if (a && a.status === 'not-registered' && !(a.known && a.known.status === 'registered')) a.known = { status: 'registered', playlistId: list, title };
        }
      }).catch(() => { reportedAt.delete(k); /* background unreachable: try again later */ });
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
      const r = route(id);
      if (!r.ok) return { ok: false, reason: r.reason };
      if (r.live) reportMembers(id, r.playlistId);
      if (video && !mediaBelongsTo(video, id)) return { ok: false, reason: 'loading' };
      if (det.adShowing(doc)) return { ok: false, reason: 'ad' };
      return ALLOW;
    }

    /**
     * What is being learned: the video ID, plus `|playlistId` while the video counts
     * through that playlist. Membership gained or lost mid-interval changes the key,
     * so main.js drops that interval.
     */
    function contentKey() {
      const id = currentId();
      if (!id) return null;
      const r = route(id);
      return r.ok && r.via === 'playlist' ? `${id}|${r.playlistId}` : id;
    }

    function refresh(onPage) {
      const id = onPage ? currentId() : null;
      const t = id && det.pageTitle(doc, id);
      if (t) titles.set(id, t);
      const list = id ? currentList() : null;
      const pt = list && playlists.panelTitle(doc, list);
      if (pt) playlistTitles.set(list, pt);
    }

    function knownTitle(id, list) {
      const k = authOf('video', id)?.known;
      return k && k.playlistId === list ? k.title : null;
    }

    function registrationOf(id) {
      if (!id) return null;
      const r = route(id);
      return r.ok ? 'registered' : r.reason;
    }

    function recheck(type, id) {
      const a = id && authOf(type, id);
      if (a && performance.now() - a.at > RECHECK_MS) lookup(type, id); // keeps the old answer until the new one arrives
    }

    function setAuth(type, id, status, known) {
      const prev = authOf(type, id);
      auth.set(`${type}:${id}`, { status, title: prev?.title || null, known: known !== undefined ? known : (prev?.known || null), at: performance.now() });
    }

    return {
      platform: 'youtube',
      isContentPage: () => !!currentId(),
      pickVideo() { const v = det.mainVideo(doc); return v && v.isConnected ? v : null; },
      contentKey,
      gate,
      refresh,
      maintain(onPage) {
        refresh(onPage);
        const id = onPage ? currentId() : null;
        recheck('video', id);
        if (id) recheck('playlist', currentList());
      },
      creditFields(key) {
        const [id, playlistId] = String(key).split('|');
        const source = { platform: 'youtube', contentType: 'video', contentId: id, courseTitle: titles.get(id) || null };
        // Present ONLY on time measured while membership was proven (see contentKey).
        if (playlistId) Object.assign(source, { playlistId, playlistTitle: playlistTitles.get(playlistId) || null });
        return { source };
      },
      statusFields() {
        const id = currentId();
        const r = id ? route(id) : null;
        const list = r && r.playlistId;
        return {
          platform: 'youtube',
          video: id ? { id, title: authOf('video', id)?.title || titles.get(id) || null } : null,
          registration: registrationOf(id),
          via: r && r.ok ? r.via : null,
          playlist: list ? { id: list, title: authOf('playlist', list)?.title || knownTitle(id, list) || playlistTitles.get(list) || null } : null,
        };
      },
      statusKey() {
        const id = currentId();
        const r = id ? route(id) : null;
        return `${id || ''}|${r ? (r.ok ? `ok:${r.via}` : r.reason) : ''}|${(r && r.playlistId) || ''}`;
      },
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
        reported.clear(); // a removed and re-added playlist starts with no proven members
        const id = currentId();
        if (id) {
          lookup('video', id);
          const list = currentList();
          if (list) lookup('playlist', list);
        }
        return true;
      },
      onCreditResponse(res, key) {
        // The background is the authority: a rejected credit updates our view at once.
        if (!res || !key) return;
        const [id, playlistId] = String(key).split('|');
        const videoStatus = typeof res.videoStatus === 'string' ? res.videoStatus : (!playlistId ? res.targetStatus : undefined);
        // Rejected: nothing authorizes this video — not even a membership we knew of.
        const rejected = typeof res.targetStatus === 'string' && res.targetStatus !== 'registered';
        if (typeof videoStatus === 'string') setAuth('video', id, videoStatus, rejected ? (res.targetStatus === 'disabled' && videoStatus !== 'disabled' ? { status: 'disabled', playlistId: null, title: null } : null) : undefined);
        if (playlistId && typeof res.playlistStatus === 'string') setAuth('playlist', playlistId, res.playlistStatus);
      },
      extraMediaEvents: ['loadstart'],
      navigationEvents: ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated'],
    };
  }

  // ---- Coursera: automatic, lecture (video) items of a course only -----------------
  // Identity is the URL's course slug + item id (courseraDetector.js) — nothing else
  // on coursera.org counts. The player is found by the shared VideoTracker (any
  // main-document / open-shadow-root <video>, largest visible + playing first), so
  // nothing depends on Coursera's markup. A player inside a cross-origin iframe
  // would not be visible to this script: then nothing counts ('no-video').
  //
  // Lecture changes (SPA "Next" or history): contentKey() changes, so main.js drops
  // the interval that spans the change. Media ownership: a media source counts only
  // for the lecture the URL showed when that source was first seen, so an old
  // lecture's video still playing under the new lecture's URL never counts for it
  // (reason 'loading' until the new lecture's media is loaded).
  const MAX_SOURCES = 64;

  function courseraSite() {
    const det = NS.courseraDetector;
    const owners = new Map();   // media source → lecture key it was first seen for
    const lectures = new Map(); // lecture key → { courseSlug, itemId, courseTitle, lectureTitle }

    const current = () => det.parseLecture(root.location);
    const currentKey = () => det.lectureKey(current());

    function bind(src, key) {
      if (!src || !key || owners.has(src)) return;
      if (owners.size >= MAX_SOURCES) owners.delete(owners.keys().next().value); // forget the oldest first
      owners.set(src, key);
    }

    function refresh(onPage) {
      const l = onPage ? current() : null;
      if (!l) return;
      const key = det.lectureKey(l);
      if (lectures.has(key)) return;
      if (lectures.size >= MAX_SOURCES) lectures.delete(lectures.keys().next().value);
      lectures.set(key, {
        courseSlug: l.courseSlug,
        itemId: l.itemId,
        courseTitle: det.humanizeSlug(l.courseSlug) || det.FALLBACK_COURSE_TITLE,
        lectureTitle: det.humanizeSlug(l.lectureSlug),
      });
    }

    /** The lecture a key names. Identity always comes from the key itself; the cache only adds titles. */
    function lectureOf(key) {
      if (!key) return null;
      if (!lectures.has(key) && key === currentKey()) refresh(true);
      const cached = lectures.get(key);
      if (cached) return cached;
      const [courseSlug, itemId] = String(key).split('/');
      return { courseSlug, itemId, courseTitle: det.humanizeSlug(courseSlug) || det.FALLBACK_COURSE_TITLE, lectureTitle: null };
    }

    function gate(video) {
      const key = currentKey();
      if (!key) return { ok: false, reason: 'not-learn-page' };
      const src = video && video.currentSrc;
      if (src) {
        bind(src, key); // first sight (also covers a script injected while a lecture is already playing)
        if (owners.get(src) !== key) return { ok: false, reason: 'loading' };
      }
      return ALLOW;
    }

    return {
      platform: 'coursera',
      isContentPage: () => current() !== null,
      pickVideo: (videos) => videos.getActiveVideo(),
      contentKey: currentKey,
      gate,
      refresh,
      maintain: refresh,
      creditFields(key) {
        const l = lectureOf(key);
        return {
          source: {
            platform: 'coursera',
            contentType: 'course',
            contentId: l.courseSlug,
            courseId: l.courseSlug,
            courseTitle: l.courseTitle,
            lessonId: l.itemId,
            lessonTitle: l.lectureTitle,
          },
        };
      },
      statusFields() {
        const l = lectureOf(currentKey());
        return {
          platform: 'coursera',
          course: l ? { key: `coursera:course:${l.courseSlug}`, title: l.courseTitle } : null,
          lecture: l ? { id: l.itemId, title: l.lectureTitle } : null,
        };
      },
      statusKey: () => currentKey() || '',
      onMedia(e) {
        // A source starting to load belongs to the lecture the URL shows now.
        if (e.type === 'loadstart' || e.type === 'loadedmetadata') bind(e.target.currentSrc, currentKey());
      },
      extraMediaEvents: ['loadstart'],
      navigationEvents: [],
    };
  }

  function create(ctx) {
    const host = String(root.location?.hostname || '').toLowerCase();
    if (/(^|\.)udemy\.com$/.test(host) && NS.udemyDetector) return udemySite(ctx);
    if (host === 'www.youtube.com' && NS.youtubeDetector) return youtubeSite(ctx);
    if (host === 'www.coursera.org' && NS.courseraDetector) return courseraSite(ctx);
    return null;
  }

  NS.sites = { create };
})(globalThis);
