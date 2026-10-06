/**
 * Finds the lecture's HTML5 <video> without relying on Udemy's CSS class names.
 *
 * Strategy
 *  1. Media events (play/pause/seeking/…) are captured at the document level
 *     (capture phase), so ANY <video> that starts playing is noticed instantly,
 *     no matter how or when the player inserted it. No per-element listeners →
 *     no duplicate listeners or leaks when Udemy swaps video elements.
 *  2. On every check we pick the best candidate among live <video> elements:
 *     playing beats paused, then bigger visible area wins. Tiny/invisible videos
 *     (thumbnails, hover previews) are ignored.
 *  3. If no <video> is found in the main document, a bounded fallback walks open
 *     shadow roots (in case the player moves into a web component).
 */
(function (root) {
  'use strict';
  const NS = (root.__UdemyStreak = root.__UdemyStreak || {});

  const MIN_AREA_PX = 160 * 90; // smaller than this = preview/thumbnail, not the lecture
  const SHADOW_SCAN_NODE_LIMIT = 4000;

  function visibleArea(video) {
    try {
      const r = video.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return 0;
      return r.width * r.height;
    } catch { return 0; }
  }

  function isPlaying(v) {
    return !!v && !v.paused && !v.ended;
  }

  function hasMedia(v) {
    return !!(v.currentSrc || v.src || v.srcObject || v.querySelector?.('source'));
  }

  function findInShadowRoots(doc) {
    const found = [];
    const walker = doc.createTreeWalker(doc.documentElement || doc, NodeFilter.SHOW_ELEMENT);
    let n = 0;
    let node = walker.currentNode;
    while (node && n++ < SHADOW_SCAN_NODE_LIMIT) {
      if (node.shadowRoot) found.push(...node.shadowRoot.querySelectorAll('video'));
      node = walker.nextNode();
    }
    return found;
  }

  class VideoTracker {
    constructor(doc = root.document) {
      this.doc = doc;
      this.preferred = null;        // last video that emitted a play event
      this.shadowVideos = [];       // cached results of the shadow-root fallback
      this.liveVideos = doc.getElementsByTagName('video'); // live HTMLCollection (cheap)
    }

    /** Called from the document-level media event listener. */
    noteMediaEvent(event) {
      const target = event && event.target;
      if (target && target.tagName === 'VIDEO' && (event.type === 'play' || event.type === 'playing')) {
        this.preferred = target;
      }
    }

    prefer(video) {
      if (video && video.tagName === 'VIDEO') this.preferred = video;
    }

    candidates() {
      const list = Array.from(this.liveVideos);
      if (!list.length) {
        this.shadowVideos = this.shadowVideos.filter((v) => v.isConnected);
        return this.shadowVideos;
      }
      return list;
    }

    /** Expensive-ish fallback; call only from the slow scan when nothing is found. */
    deepScan() {
      if (this.liveVideos.length) return;
      try { this.shadowVideos = findInShadowRoots(this.doc); } catch { this.shadowVideos = []; }
    }

    score(v) {
      if (!v || !v.isConnected) return -1;
      const area = visibleArea(v);
      const fullscreen = this.doc.fullscreenElement && (this.doc.fullscreenElement === v || this.doc.fullscreenElement.contains(v));
      if (area < MIN_AREA_PX && !fullscreen) return -1;
      let s = Math.min(area, 1e7);
      if (hasMedia(v)) s += 1e7;
      if (isPlaying(v)) s += 1e9;
      if (v === this.preferred) s += 1e8;
      return s;
    }

    /** The video most likely to be the lecture, or null. */
    getActiveVideo() {
      let best = null;
      let bestScore = -1;
      for (const v of this.candidates()) {
        const s = this.score(v);
        if (s > bestScore) { best = v; bestScore = s; }
      }
      if (this.preferred && !this.preferred.isConnected) this.preferred = null;
      return bestScore >= 0 ? best : null;
    }

    static snapshot(v) {
      if (!v) return null;
      return {
        paused: v.paused,
        ended: v.ended,
        seeking: v.seeking,
        readyState: v.readyState,
        currentTime: v.currentTime,
        playbackRate: v.playbackRate,
        duration: v.duration,
      };
    }
  }

  NS.VideoTracker = VideoTracker;
})(globalThis);
