/**
 * Pure counting rules shared by the content-script modules (and unit tests).
 *
 * WHEN ANYTHING COUNTS (V1.2): only while ALL hold — on a lecture page, a lecture
 *   video is playing and actually progressing, and the screen is not locked.
 *   Tab visibility and window/app focus do NOT matter: a lecture playing in a
 *   background tab while you code in another app counts. If the browser itself
 *   throttles or stops background playback, currentTime stops advancing and
 *   nothing is counted — we measure playback, we never force it.
 *
 * TWO METRICS per measured interval (V1.1):
 *   content — lecture content consumed = validated growth of video.currentTime.
 *             This is the PRIMARY metric (daily goal, streak, stats).
 *             2x for 5 real minutes → 10 minutes of content.
 *   active  — real elapsed time spent actively watching (wall clock, limited by
 *             the video's own progress). Secondary, shown as "actual watch time".
 *   They are measured side by side from the same interval — never added together.
 *
 * VALIDATION: content only counts when currentTime moved forward by an amount
 *   that normal playback at the current rate can explain in the elapsed real
 *   time. A seek (forward or backward), a lecture/source change or a replaced
 *   <video> is a discontinuity → 0 content for that interval, and measuring
 *   resumes from the new position. Sleep/stalls → the video doesn't advance → 0.
 *
 * No "+1 every second" counter: each tick compares performance.now() and
 *   currentTime with the previous tick (≈1 s while playing — driven by the
 *   video's own timeupdate events and a fallback timer — plus immediately on
 *   every play/pause/seek/rate/lifecycle event). Hidden tabs may have their
 *   timers throttled (≈1/s, or ≈1/min under intensive throttling), so a single
 *   interval can legitimately be long — the per-interval caps allow for that.
 */
(function (root) {
  'use strict';
  const NS = (root.__UdemyStreak = root.__UdemyStreak || {});

  const RULES = Object.freeze({
    TICK_MS: 1000,              // measurement cadence while a video is playing
    IDLE_SCAN_MS: 4000,         // cadence while paused / no video (cheap checks only)
    DORMANT_SCAN_MS: 2500,      // cadence on non-lecture Udemy pages (URL check only)
    FLUSH_MS: 5000,             // max unsaved time (crash loss bound)
    MAX_SEEK_CREDIT_S: 1.5,     // credit for an interval that contained a seek
    MAX_TICK_CREDIT_S: 90,      // hard cap for a single interval (covers ~1/min background timer throttling)
    MEDIA_SLACK_FACTOR: 1.1,    // tolerance for currentTime update granularity
    MEDIA_SLACK_S: 0.15,
    CONTENT_SLACK_FACTOR: 1.15, // currentTime may run slightly ahead of timer jitter
    CONTENT_SLACK_S: 0.25,
    MAX_TICK_CONTENT_S: 240,    // hard cap of content for a single interval (90 s at 2× + slack)
  });

  /**
   * ACTIVE (real) seconds for one measured interval.
   * @param {{wallSeconds:number, mediaDelta:number, playbackRate:number, seeked?:boolean}} m
   */
  function computeCredit(m) {
    const wall = Number(m.wallSeconds);
    if (!(wall > 0) || !Number.isFinite(wall)) return 0;
    const rate = Number(m.playbackRate) > 0 ? Number(m.playbackRate) : 1;
    const mediaDelta = Number(m.mediaDelta);
    if (!Number.isFinite(mediaDelta)) return 0;
    const mediaReal = mediaDelta / rate; // real seconds of playback implied by progress

    // A seek (or lecture switch) happened inside the interval: progress is not a
    // usable measure, so grant at most a short, bounded amount.
    if (m.seeked || mediaReal < -0.25 || mediaReal > wall * 1.5 + 1) {
      return Math.min(wall, RULES.MAX_SEEK_CREDIT_S);
    }
    // No forward progress at all (frozen/stalled video, sleep) → no watch time either.
    if (mediaDelta <= 0) return 0;
    const limitedByMedia = Math.max(0, mediaReal) * RULES.MEDIA_SLACK_FACTOR + RULES.MEDIA_SLACK_S;
    return Math.max(0, Math.min(wall, limitedByMedia, RULES.MAX_TICK_CREDIT_S));
  }

  /**
   * Lecture content consumed (video seconds) in one measured interval.
   * Returns 0 for any discontinuity (seek either way, source change) or no progress.
   * @param {{wallSeconds:number, mediaDelta:number, playbackRate:number, seeked?:boolean}} m
   */
  function computeContent(m) {
    const wall = Number(m.wallSeconds);
    const mediaDelta = Number(m.mediaDelta);
    if (!(wall > 0) || !Number.isFinite(wall) || !Number.isFinite(mediaDelta)) return 0;
    if (m.seeked) return 0;            // explicit seek / lecture change inside the interval
    if (mediaDelta <= 0) return 0;     // paused, stalled, or jumped backwards
    const rate = Number(m.playbackRate) > 0 ? Number(m.playbackRate) : 1;
    const expected = wall * rate;      // what normal playback could have advanced
    if (mediaDelta > expected * 1.5 + 1) return 0; // forward jump = seek, not watching
    return Math.max(0, Math.min(mediaDelta, expected * RULES.CONTENT_SLACK_FACTOR + RULES.CONTENT_SLACK_S, RULES.MAX_TICK_CONTENT_S));
  }

  /**
   * Measure one interval between two snapshots of the same lecture video.
   * @param {{perf:number, media:number, rate:number, src?:string}} base  snapshot when the interval opened
   * @param {{perf:number, media:number, src?:string, connected?:boolean}} now
   * @param {{seeked?:boolean}} [opts]
   * @returns {{active:number, content:number}}
   */
  function measureInterval(base, now, opts = {}) {
    if (!base || !now || now.connected === false) return { active: 0, content: 0 }; // video element replaced
    const wallSeconds = (now.perf - base.perf) / 1000;
    const srcChanged = !!(base.src && now.src && base.src !== now.src); // lecture changed in the same element
    const m = { wallSeconds, mediaDelta: now.media - base.media, playbackRate: base.rate, seeked: !!opts.seeked || srcChanged };
    return { active: computeCredit(m), content: computeContent(m) };
  }

  /**
   * Decide whether time should be counted right now.
   * @returns {{ ok: boolean, reason: string }}
   */
  function evaluateConditions(s) {
    if (!s.onLearnPage) return { ok: false, reason: 'not-learn-page' };
    // V2.1: the site adapter's verdict (e.g. YouTube video not in the Learning Library).
    if (s.gate && s.gate.ok === false) return { ok: false, reason: s.gate.reason || 'not-registered' };
    if (!s.hasVideo) return { ok: false, reason: 'no-video' };
    if (s.systemLocked) return { ok: false, reason: 'locked' };
    if (s.frozen) return { ok: false, reason: 'frozen' }; // page lifecycle frozen by the browser
    if (s.ended) return { ok: false, reason: 'ended' };
    if (s.paused) return { ok: false, reason: 'paused' };
    if (s.seeking || s.readyState < 2) return { ok: false, reason: 'buffering' };
    return { ok: true, reason: 'tracking' };
  }

  const REASON_TEXT = Object.freeze({
    'tracking': 'Tracking your learning time',
    'not-learn-page': 'Open a Udemy lecture to start tracking',
    'no-video': 'Waiting for the lecture video',
    'locked': 'Screen locked — paused',
    'frozen': 'Tab suspended by the browser — paused',
    'ended': 'Lecture ended — paused',
    'paused': 'Video paused',
    'buffering': 'Video buffering — paused',
    // V2.1 (YouTube)
    'not-registered': 'Not registered as learning — add it to your Learning Library to count it',
    'disabled': 'Disabled in your Learning Library — not counted',
    'checking': 'Checking your Learning Library…',
    'loading': 'Loading the video — paused',
    'ad': 'Ad playing — not counted',
  });

  NS.RULES = RULES;
  NS.computeCredit = computeCredit;
  NS.computeContent = computeContent;
  NS.measureInterval = measureInterval;
  NS.evaluateConditions = evaluateConditions;
  NS.REASON_TEXT = REASON_TEXT;
})(globalThis);
