/**
 * V1.1 — playback-speed-aware tracking. Simulates the content script's
 * measurement loop (1 s ticks + event-driven ticks) with a virtual clock and a
 * virtual <video>, using the real measureInterval/evaluateConditions rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, localMs } from './helpers.mjs';

await mod('content/activityRules.js');
const { measureInterval, computeContent, evaluateConditions } = globalThis.__UdemyStreak;
const { applyCredit } = await mod('core/timerEngine.js');
const { createDefaultState } = await mod('core/schema.js');
const { computeStreaks } = await mod('core/streakEngine.js');

/** Virtual lecture + tracker loop mirroring content/main.js tick(). */
function makeSession({ duration = 3600 } = {}) {
  const v = { t: 0, rate: 1, paused: true, src: 'lecture-A', connected: true, duration };
  // visible/focused are still fed in (as the real page would report them) to prove they're ignored.
  const env = { visible: true, focused: true, locked: false, tickSec: 1 };
  let now = 0;            // virtual performance.now() in ms
  let baseline = null;
  const total = { active: 0, content: 0 };

  function conditionsOk() {
    return evaluateConditions({
      onLearnPage: true, hasVideo: v.connected, systemLocked: env.locked, frozen: false,
      visible: env.visible, pageFocused: env.focused,
      ended: v.t >= v.duration, paused: v.paused || v.t >= v.duration, seeking: false, readyState: 4,
    }).ok;
  }
  function tick(seeked = false) {
    if (baseline) {
      const r = measureInterval(baseline, { perf: now, media: v.t, src: v.src, connected: v.connected }, { seeked });
      total.active += r.active;
      total.content += r.content;
    }
    baseline = conditionsOk() ? { perf: now, media: v.t, rate: v.rate, src: v.src } : null;
  }
  /**
   * Advance real time by `sec`, ticking every `env.tickSec` (1 s normally; a hidden
   * tab's timers may be throttled to ~60 s). Events still tick immediately.
   */
  function run(sec) {
    for (let i = 0; i < sec; i += 1) {
      now += 1000;
      if (!v.paused) v.t = Math.min(v.duration, v.t + v.rate); // the video keeps playing even in a background tab
      if ((i + 1) % env.tickSec === 0 || i === sec - 1) tick();
    }
  }
  /** Machine asleep: real time passes, nothing runs, the video does not advance. */
  function sleepFor(sec) { now += sec * 1000; }
  return {
    v, env, total,
    play() { v.paused = false; tick(); },
    pause() { v.paused = true; tick(); },
    setRate(r) { tick(); v.rate = r; tick(); },             // 'ratechange' event
    seekTo(t) { v.t = t; tick(true); tick(); },             // 'seeking' then 'seeked'
    hide() { env.visible = false; tick(); },                // visibilitychange
    show() { env.visible = true; tick(); },
    blur() { env.focused = false; tick(); },                // another app (e.g. VS Code) focused
    focus() { env.focused = true; tick(); },
    lock() { env.locked = true; tick(); },                  // system:lock from chrome.idle
    unlock() { env.locked = false; tick(); },
    throttle(sec) { env.tickSec = sec; },
    sleepFor,
    changeLecture(sameElement = true) {                     // SPA lecture switch
      if (sameElement) { v.src = 'lecture-B'; v.t = 0; tick(true); } else { v.connected = false; tick(); v.connected = true; v.src = 'lecture-B'; v.t = 0; tick(); }
    },
    run,
  };
}
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `expected ≈${b} ±${tol}, got ${a}`);

test('2× for 5 real minutes → ≈600 s content, ≈300 s actual (the reported bug)', () => {
  const s = makeSession(); s.setRate(2); s.play(); s.run(300); s.pause();
  near(s.total.content, 600, 3);
  near(s.total.active, 300, 2);
});

test('1.5× for 4 real minutes → ≈360 s content', () => {
  const s = makeSession(); s.setRate(1.5); s.play(); s.run(240); s.pause();
  near(s.total.content, 360, 3);
  near(s.total.active, 240, 2);
});

test('1× for 4 real minutes → ≈240 s content = actual', () => {
  const s = makeSession(); s.play(); s.run(240); s.pause();
  near(s.total.content, 240, 2);
  near(s.total.active, 240, 2);
});

test('seek: 0:00 → 0:20, seek to 5:00, → 5:10 counts 30 s, not 5m10s', () => {
  const s = makeSession(); s.play(); s.run(20);
  s.seekTo(300); s.run(10); s.pause();
  near(s.total.content, 30, 1);
});

test('seek forward 5 minutes between two 30 s watches → ≈60 s content', () => {
  const s = makeSession(); s.play(); s.run(30); s.seekTo(s.v.t + 300); s.run(30); s.pause();
  near(s.total.content, 60, 1.5);
});

test('reverse seek 10:00 → 5:00 adds no negative time and resumes from new position', () => {
  const s = makeSession(); s.v.t = 600; s.play(); s.run(10);
  s.seekTo(300); s.run(10); s.pause();
  near(s.total.content, 20, 1);
  assert.ok(s.total.content >= 0);
});

test('undetected jump (no seeking event) is still treated as a discontinuity', () => {
  assert.equal(computeContent({ wallSeconds: 1, mediaDelta: 1200, playbackRate: 1 }), 0);
  assert.equal(computeContent({ wallSeconds: 1, mediaDelta: -300, playbackRate: 2 }), 0);
  assert.equal(computeContent({ wallSeconds: 1, mediaDelta: 2, playbackRate: 2 }), 2);
  assert.equal(computeContent({ wallSeconds: 2, mediaDelta: 4, playbackRate: 2 }), 4);   // spec example 100 → 104
  assert.equal(computeContent({ wallSeconds: 2, mediaDelta: 2, playbackRate: 1 }), 2);   // spec example 100 → 102
});

// ---- V1.2 background tracking -------------------------------------------------

test('V1.2 A: background tab — 30 s visible + 30 s in another tab (video playing) → ≈60 s content & actual', () => {
  const s = makeSession(); s.play(); s.run(30); s.hide(); s.run(30); s.show(); s.pause();
  near(s.total.content, 60, 1.5);
  near(s.total.active, 60, 1.5);
});

test('V1.2 B: another app focused (VS Code) for 30 s, video playing → +30 s', () => {
  const s = makeSession(); s.play(); s.run(30); s.blur(); s.hide(); s.run(30); s.focus(); s.show(); s.pause();
  near(s.total.content, 60, 1.5);
});

test('V1.2 C: paused while in the background → only the time before the pause counts', () => {
  const s = makeSession(); s.play(); s.run(30); s.blur(); s.hide(); s.run(10); s.pause(); s.run(30); s.focus(); s.show(); s.run(5);
  near(s.total.content, 40, 1.5);
  near(s.total.active, 40, 1.5);
});

test('V1.2 D: lecture ends while in the background → counting stops at the end', () => {
  const s = makeSession({ duration: 100 }); s.v.t = 70; s.play(); s.blur(); s.hide(); s.run(120); s.focus(); s.show();
  near(s.total.content, 30, 1);
  near(s.total.active, 30, 1);
});

test('V1.2 E: 2× in the background for 5 real minutes → ≈600 s content, ≈300 s actual', () => {
  const s = makeSession(); s.setRate(2); s.play(); s.blur(); s.hide(); s.run(300); s.focus(); s.show(); s.pause();
  near(s.total.content, 600, 3);
  near(s.total.active, 300, 2);
});

test('V1.2 E (throttled): 2× hidden with timers throttled to once a minute → still ≈600 s / ≈300 s', () => {
  const s = makeSession(); s.setRate(2); s.play(); s.hide(); s.throttle(60); s.run(300); s.throttle(1); s.show(); s.pause();
  near(s.total.content, 600, 3);
  near(s.total.active, 300, 2);
});

test('V1.2 F: seek 5:00 → 15:00 while in the background is not counted', () => {
  const s = makeSession(); s.v.t = 270; s.play(); s.run(30); s.hide(); s.seekTo(900); s.run(30); s.show(); s.pause();
  near(s.total.content, 60, 1.5);
});

test('V1.2: lecture switch in the background (40:00 → 0:00) resets the baseline', () => {
  const s = makeSession(); s.v.t = 2400; s.play(); s.hide(); s.run(10); s.changeLecture(true); s.run(10); s.show(); s.pause();
  near(s.total.content, 20, 1);
  const r = makeSession(); r.v.t = 2400; r.play(); r.hide(); r.run(10); r.changeLecture(false); r.run(10); r.show(); r.pause();
  near(r.total.content, 20, 1.5);
});

test('V1.2 G: screen locked while playing in the background → lock time not counted', () => {
  const s = makeSession(); s.play(); s.hide(); s.run(30); s.lock(); s.run(120); s.unlock(); s.run(30); s.show(); s.pause();
  near(s.total.content, 60, 1.5);
});

test('V1.2 G: machine sleeps for 2 h mid-play (no ticks, video frozen) → 0 for the sleep', () => {
  const s = makeSession(); s.play(); s.hide(); s.run(30); s.sleepFor(7200); s.run(30); s.pause();
  near(s.total.content, 60, 1.5);
  near(s.total.active, 60, 1.5);
});

test('V1.2: background playback that the browser stalls (paused=false but no progress) → nothing', () => {
  const s = makeSession(); s.play(); s.hide(); s.run(10);
  s.v.rate = 0; s.run(120); // currentTime frozen while "playing"
  near(s.total.content, 10, 0.5);
  near(s.total.active, 10, 0.5);
});

test('pause for 30 s → ≈60 s, pause gap not counted', () => {
  const s = makeSession(); s.play(); s.run(30); s.pause(); s.run(30); s.play(); s.run(30); s.pause();
  near(s.total.content, 60, 1.5);
});

test('lecture change (same element, new src) does not add the position difference', () => {
  const s = makeSession(); s.v.t = 1500; s.play(); s.run(10);
  s.changeLecture(true); s.run(10); s.pause();
  near(s.total.content, 20, 1);
});

test('video element replaced → new baseline, no double counting', () => {
  const s = makeSession(); s.play(); s.run(10); s.changeLecture(false); s.run(10); s.pause();
  near(s.total.content, 20, 1.5);
});

test('rate change mid-play is measured at the right rate on each side', () => {
  const s = makeSession(); s.play(); s.run(60); s.setRate(2); s.run(60); s.setRate(1.25); s.run(40); s.pause();
  near(s.total.content, 60 + 120 + 50, 3);
  near(s.total.active, 160, 2);
});

test('sleep: real clock jumps 2 h, video did not advance → nothing', () => {
  assert.deepEqual(measureInterval({ perf: 0, media: 100, rate: 2 }, { perf: 7_200_000, media: 100 }), { active: 0, content: 0 });
});

test('video end stops counting', () => {
  const s = makeSession({ duration: 100 }); s.v.t = 80; s.setRate(2); s.play(); s.run(30); s.pause();
  near(s.total.content, 20, 1);
});

test('goal uses content: 35 min actual at ~1.7× = 60 min content → goal complete, streak kept', () => {
  process.env.TZ = 'Asia/Kolkata';
  let st = createDefaultState();
  st.dailyHistory['2026-10-05'] = { contentSeconds: 3600, actualActiveSeconds: 3600, goalSeconds: 3600, completed: true };
  const start = localMs(2026, 10, 6, 10, 0);
  const chunks = (35 * 60) / 5;
  for (let i = 1; i <= chunks; i += 1) st = applyCredit(st, { endMs: start + i * 5000, active: 5, content: 3600 / chunks }).state;
  const d = st.dailyHistory['2026-10-06'];
  near(d.actualActiveSeconds, 2100, 0.1);
  near(d.contentSeconds, 3600, 0.1);
  assert.equal(d.completed, true);
  assert.equal(computeStreaks(st.dailyHistory, '2026-10-06').current, 2);
  process.env.TZ = 'UTC';
});

test('midnight: 2× session 11:59 PM → 12:01 AM splits content and actual by real time', () => {
  process.env.TZ = 'Asia/Kolkata';
  let st = createDefaultState();
  const start = localMs(2026, 10, 6, 23, 59, 0);
  for (let i = 1; i <= 24; i += 1) st = applyCredit(st, { endMs: start + i * 5000, active: 5, content: 10 }).state; // 2 real minutes
  near(st.dailyHistory['2026-10-06'].actualActiveSeconds, 60, 0.01);
  near(st.dailyHistory['2026-10-06'].contentSeconds, 120, 0.01);
  near(st.dailyHistory['2026-10-07'].actualActiveSeconds, 60, 0.01);
  near(st.dailyHistory['2026-10-07'].contentSeconds, 120, 0.01);
  // a single chunk straddling midnight is split proportionally
  const r = applyCredit(createDefaultState(), { endMs: localMs(2026, 10, 8, 0, 0, 2), active: 5, content: 10 });
  near(r.state.dailyHistory['2026-10-07'].contentSeconds, 6, 0.001);
  near(r.state.dailyHistory['2026-10-08'].contentSeconds, 4, 0.001);
  process.env.TZ = 'UTC';
});

test('background rejects implausible content (more than playback could explain)', () => {
  const r = applyCredit(createDefaultState(), { endMs: Date.now(), active: 5, content: 5000 });
  assert.ok(r.appliedContent <= 5 * 16 + 5);
  assert.equal(applyCredit(createDefaultState(), { endMs: Date.now(), active: 0, content: 10 }).appliedContent, 0);
  // legacy V1-style message still accepted as actual time only
  const legacy = applyCredit(createDefaultState(), { endMs: Date.now(), seconds: 5 });
  assert.equal(legacy.appliedSeconds, 5);
  assert.equal(legacy.appliedContent, 0);
});
