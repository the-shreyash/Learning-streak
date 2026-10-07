/**
 * YouTube URL parsing + watch-page identity.
 *
 * Loaded as a content script on www.youtube.com AND imported (side effect) by
 * the background / options pages through platforms/youtube.js, so the SAME
 * parser decides what can be registered and which video a page is playing.
 *
 * Identity is the 11-character video ID and nothing else: no titles, channels,
 * categories or keywords are ever used to decide what counts.
 *
 * Page signals (verified on youtube.com, 2026-10-07):
 *  - SPA navigation reuses the same <video>; its blob source is swapped
 *    (emptied → loadstart). The URL's `v` changes BEFORE that swap.
 *  - ytd-watch-flexy[video-id] follows ~3–4 s later (after page data loads).
 *  - #movie_player gets the class `ad-showing` while an ad plays in the same <video>.
 * Every DOM helper returns null when its element is missing.
 */
(function (root) {
  'use strict';
  const NS = (root.__UdemyStreak = root.__UdemyStreak || {});

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,64}$/;
  const WATCH_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com'];
  const SHORT_HOSTS = ['youtu.be', 'www.youtu.be'];
  const PATH_ID_RE = /^\/(?:embed|live)\/([^/]+)\/?$/;

  const validVideoId = (id) => (typeof id === 'string' && VIDEO_ID_RE.test(id) ? id : null);

  function toUrl(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (!s || s.length > 2048 || /\s/.test(s)) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch { return null; }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null;
    return u;
  }

  /** The single `v` value of a /watch URL (two different `v`s are ambiguous → null). */
  function watchParam(u) {
    const vs = u.searchParams.getAll('v');
    if (!vs.length || vs.some((v) => v !== vs[0])) return null;
    return validVideoId(vs[0]);
  }

  /**
   * Parse a pasted YouTube video URL.
   * @returns {{ok:true, videoId:string, playlistId:string|null} | {ok:false, reason:string}}
   *   reason: 'not-a-url' | 'not-youtube' | 'playlist' | 'shorts' | 'no-video-id'
   */
  function parseVideoUrl(input) {
    const u = toUrl(input);
    if (!u) return { ok: false, reason: 'not-a-url' };
    const host = u.hostname.toLowerCase();
    let id = null;
    if (SHORT_HOSTS.includes(host)) {
      const m = /^\/([^/]+)\/?$/.exec(u.pathname);
      id = m ? validVideoId(m[1]) : null;
    } else if (WATCH_HOSTS.includes(host)) {
      if (u.pathname === '/watch' || u.pathname === '/watch/') {
        id = watchParam(u);
      } else if (/^\/playlist\/?$/.test(u.pathname)) {
        return { ok: false, reason: 'playlist' };
      } else if (/^\/shorts\//.test(u.pathname)) {
        return { ok: false, reason: 'shorts' };
      } else {
        const m = PATH_ID_RE.exec(u.pathname);
        id = m ? validVideoId(m[1]) : null;
      }
    } else {
      return { ok: false, reason: 'not-youtube' };
    }
    if (!id) return { ok: false, reason: 'no-video-id' };
    const list = u.searchParams.get('list');
    return { ok: true, videoId: id, playlistId: list && PLAYLIST_ID_RE.test(list) ? list : null };
  }

  /** Video ID of a youtube.com watch page location, else null (home, search, shorts, …). */
  function videoIdFromLocation(loc = root.location) {
    try {
      if (!WATCH_HOSTS.includes(String(loc.hostname).toLowerCase())) return null;
      if (loc.pathname !== '/watch' && loc.pathname !== '/watch/') return null;
      return watchParam(new URL(loc.href));
    } catch { return null; }
  }

  // ---- Page (DOM) helpers — content script only ---------------------------------
  const q = (doc, sel) => { try { return doc.querySelector(sel); } catch { return null; } };

  /** The main player's <video> (not hover previews / thumbnails), or null. */
  function mainVideo(doc = root.document) {
    return q(doc, '#movie_player video.html5-main-video') || q(doc, 'video.html5-main-video');
  }

  /** True while YouTube plays an ad inside the main player. */
  function adShowing(doc = root.document) {
    const p = q(doc, '#movie_player') || q(doc, '.html5-video-player');
    return !!(p && p.classList && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
  }

  /** Video ID the watch page itself has finished loading (lags the URL by seconds), or null. */
  function pageVideoId(doc = root.document) {
    const flexy = q(doc, 'ytd-watch-flexy[video-id]');
    return flexy ? validVideoId(flexy.getAttribute('video-id')) : null;
  }

  /** Title shown for the video, only once the page has caught up with `videoId`. */
  function pageTitle(doc = root.document, videoId) {
    if (!videoId || pageVideoId(doc) !== videoId) return null;
    const h1 = q(doc, 'ytd-watch-metadata h1');
    const t = (h1 && h1.textContent ? h1.textContent : '').replace(/\s+/g, ' ').trim();
    return t && t.length <= 200 ? t : null;
  }

  NS.youtubeDetector = {
    VIDEO_ID_RE, parseVideoUrl, videoIdFromLocation, validVideoId,
    mainVideo, adShowing, pageVideoId, pageTitle,
  };
})(globalThis);
