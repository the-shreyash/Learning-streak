/**
 * V2.1 Phase B — YouTube playback through the REAL content scripts (main.js loop
 * + sites.js YouTube adapter + youtubeDetector.js), driven deterministically by
 * tests/unit/contentHarness.mjs. Background answers come from the real engine.
 *
 * Tolerance: the loop measures in ≈1 s intervals and drops the interval that
 * contains a transition, so each start/stop may lose up to ≈1 s (never gain).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './contentHarness.mjs';

const A = 'aircAruvnKk';   // registered
const B = 'IHZwWFHWa-w';   // not registered
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ≈${expected} ±${tol}, got ${actual}`);
const S = 1000;
/** Stored + not-yet-flushed (≤ 5 s) content. */
const counted = (w) => w.content() + (w.ping().unsavedContent || 0);

async function watching(id = A, opts = {}) {
  const w = createWorld({ registered: [A], ...opts });
  await w.open(id);
  return w;
}

test('play: registered video → content and actual time counted, LearningSession created', async () => {
  const w = await watching();
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  near(w.content(), 60, 1.5, 'content');
  near(w.active(), 60, 1.5, 'actual');
  const [s] = w.sessions();
  assert.equal(w.sessions().length, 1);
  assert.equal(s.platform, 'youtube');
  assert.equal(s.contentId, A);
  near(s.contentSeconds, 60, 1.5);
  assert.ok(w.credits.every((c) => c.source?.contentId === A && c.course === undefined), 'YouTube credits carry a source, never a Udemy course');
});

test('play: unregistered video → zero time and not a single credit sent', async () => {
  const w = await watching(B);
  w.play();
  await w.advance(90 * S);
  w.pause();
  await w.settle();
  assert.equal(w.content(), 0);
  assert.equal(w.active(), 0);
  assert.equal(w.credits.length, 0);
  const p = w.ping();
  assert.equal(p.platform, 'youtube');
  assert.equal(p.registration, 'not-registered');
  assert.equal(p.counting, false);
  assert.equal(p.reason, 'not-registered');
  assert.equal(p.video.id, B);
});

test('pause / resume: paused time is not counted', async () => {
  const w = await watching();
  w.play();
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  const atPause = w.content();
  await w.advance(60 * S);
  assert.equal(w.content(), atPause, 'nothing while paused');
  assert.equal(w.ping().reason, 'paused');
  w.play();
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  near(w.content(), 40, 2);
});

test('seek: forward and backward jumps are not counted', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.seekTo(w.video.currentTime + 300); // skip 5 minutes
  await w.advance(10 * S);
  w.seekTo(5);                          // jump back
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 2.5, 'only the 30 s actually played');
});

test('end: counting stops when the video ends', async () => {
  const w = await watching(A, { duration: 30 });
  w.play();
  await w.advance(90 * S);
  await w.settle();
  assert.equal(w.video.ended, true);
  near(w.content(), 30, 1.5);
  near(w.active(), 30, 1.5);
  assert.equal(w.ping().reason, 'ended');
});

test('stalled / frozen: "playing" but currentTime not moving → nothing counted', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.stalled = true;
  await w.advance(30 * S);
  w.stalled = false;
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 20, 2);
  near(w.active(), 20, 2.5);
});

test('speed: 2× and 1.5× — content follows the video, actual is real time', async () => {
  const w = await watching();
  w.rate(2);
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  near(w.content(), 120, 2.5, '2× content');
  near(w.active(), 60, 1.5, '2× actual');
  w.rate(1.5);
  w.play();
  await w.advance(40 * S);
  w.pause();
  await w.settle();
  near(w.content(), 180, 4, '+1.5× content');
  near(w.active(), 100, 2.5);
});

test('background tab: counting continues while the video genuinely progresses, even with timers throttled to 1/min', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.hide();
  w.throttleMs = 60 * S; // Chrome's intensive background throttling
  await w.advance(120 * S);
  w.show();
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 140, 2.5);
  near(w.active(), 140, 2.5);
});

test('background tab: pausing in the background stops the time', async () => {
  const w = await watching();
  w.play();
  w.hide();
  w.throttleMs = 1 * S;
  await w.advance(30 * S);
  w.pause();
  await w.advance(5 * S);
  const atPause = w.content();
  await w.advance(60 * S);
  assert.equal(w.content(), atPause);
  near(atPause, 30, 1.5);
});

test('background tab: browser stops delivering progress → nothing fabricated', async () => {
  const w = await watching();
  w.play();
  w.hide();
  w.throttleMs = 60 * S;
  await w.advance(10 * S);
  const before = w.content() + (w.ping().unsavedContent || 0);
  w.stalled = true;          // the browser stopped the media pipeline
  w.timeupdates = false;
  await w.advance(180 * S);  // only throttled timer ticks arrive
  w.pause();
  await w.settle();
  near(w.content(), before, 1.5, 'no time while the video did not advance');
});

test('application switch (window blur): counting continues', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.blur();
  await w.advance(30 * S);
  assert.equal(w.ping().counting, true);
  w.focus();
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 50, 1.5);
});

test('screen lock and sleep: no time counted, nothing invented on wake', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.lock(true);
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'locked');
  w.lock(false);
  await w.advance(10 * S);
  near(counted(w), 20, 2, 'lock');
  w.asleep = true;           // lid closed: clocks jump, nothing runs, video frozen
  await w.advance(10 * 60 * S);
  w.asleep = false;
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 2.5, 'sleep');
  assert.ok(w.active() < 33, `no fabricated actual time (${w.active()})`);
});

test('SPA: registered A → unregistered B while playing → tracking stops immediately', async () => {
  const w = await watching();
  w.play();
  await w.advance(20 * S);
  await w.navigate(B);
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  near(w.content(), 20, 1.2, 'only A');
  assert.ok(w.content() <= 20.05, 'not a fraction of B credited');
  assert.equal(w.credits.filter((c) => c.source.contentId === B).length, 0, 'no credit ever names B');
  assert.equal(w.ping().reason, 'not-registered');
});

test('SPA: the interval running when the video ID changes is dropped, never attributed to the old video', async () => {
  const w = await watching();
  w.play();
  await w.advance(10_400); // mid-interval
  const playedUnderA = w.video.currentTime;
  w.silentUrl(B);          // no media event: only the identity check can catch it
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  assert.ok(w.content() <= playedUnderA + 1e-6, `credited ${w.content()} > played under A ${playedUnderA}`);
  near(w.content(), playedUnderA, 1.2);
});

test('SPA: unregistered B → registered A → tracking resumes with A\'s genuine playback', async () => {
  const w = await watching(B);
  w.play();
  await w.advance(20 * S);
  await w.navigate(A);
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 1.5);
  assert.equal(w.sessions().length, 1);
  assert.equal(w.sessions()[0].contentId, A);
});

test('SPA: URL already says A but B\'s media is still playing → not credited until A\'s media loads', async () => {
  const w = await watching(B);
  w.play();
  await w.advance(10 * S);
  await w.navigate(A, { swapDelayMs: 3000 }); // B keeps playing 3 s under A's URL
  await w.advance(2900);
  assert.equal(w.ping().counting, false, 'B media under A URL');
  assert.equal(w.ping().reason, 'loading');
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  near(w.content(), 20, 1.5, 'only A media after the swap');
});

test('SPA: A → B → A (both legs registered A) never credits B, sessions stay per video', async () => {
  const w = await watching();
  w.play();
  await w.advance(15 * S);
  await w.navigate(B);
  await w.advance(15 * S);
  await w.navigate(A);
  await w.advance(15 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 2);
  assert.ok(w.sessions().every((s) => s.contentId === A));
});

test('SPA: leaving the watch page (home / miniplayer) stops tracking', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.leaveToHome();
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  near(w.content(), 10, 1.2);
});

test('library: registering the playing video starts counting; disabling stops it at once', async () => {
  const w = await watching(B);
  w.play();
  await w.advance(10 * S);
  assert.equal(w.content(), 0);
  w.register(B);
  await w.advance(20 * S);
  assert.equal(w.ping().counting, true);
  w.setEnabled(B, false);
  await w.advance(100);
  assert.equal(w.ping().counting, false, 'stops at once');
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'disabled');
  w.pause();
  await w.settle();
  // The background judges each chunk when it arrives: the ≤ 5 s not yet flushed at
  // the moment of disabling is rejected too (conservative), nothing after it counts.
  assert.ok(w.content() >= 14 && w.content() <= 20.05, `${w.content()}`);
});

test('library: a missed "changed" broadcast is caught by the background — credit rejected, tab stops', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.setEnabled(A, false, { broadcast: false });
  await w.advance(30 * S);
  const counted = w.content();
  assert.equal(w.ping().counting, false, 'the rejected credit told the tab');
  assert.equal(w.ping().reason, 'disabled');
  near(counted, 10, 1.5, 'nothing after the disable was recorded');
});

test('ads: an ad playing inside a registered video is not counted', async () => {
  const w = await watching();
  w.ad(true);
  w.play();
  await w.advance(15 * S);
  assert.equal(w.ping().reason, 'ad');
  w.ad(false);
  await w.advance(15 * S);
  w.pause();
  await w.settle();
  near(w.content(), 15, 1.5);
});

test('delivery: background unreachable → chunks kept and delivered later in order, never twice', async () => {
  const w = await watching();
  w.play();
  w.dropCredits = true;
  await w.advance(20 * S);
  assert.equal(w.content(), 0);
  near(w.ping().unsavedContent, 20, 1.5);
  w.dropCredits = false;
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  near(w.content(), 40, 1.5);
  assert.equal(w.ping().unsavedContent, 0);
});

test('re-injection (extension update): one tracker survives, no double counting', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.inject();
  w.inject();
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  assert.ok(w.content() <= 40.3, `not double counted (${w.content()})`);
  near(w.content(), 40, 2);
});

test('popup ping: live status shows registration, title, unsaved time and speed', async () => {
  const w = await watching();
  w.rate(2);
  w.play();
  await w.advance(3 * S);
  const p = w.ping();
  assert.equal(p.platform, 'youtube');
  assert.equal(p.registration, 'registered');
  assert.equal(p.counting, true);
  assert.equal(p.onLearnPage, true);
  assert.deepEqual(JSON.parse(JSON.stringify(p.video)), { id: A, title: `Video ${A}` });
  assert.equal(p.playbackRate, 2);
  assert.ok(p.unsavedContent > 0);
});
