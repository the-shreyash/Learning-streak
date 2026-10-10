/**
 * V2.2 — Coursera playback through the REAL content scripts (main.js loop +
 * sites.js Coursera adapter + courseraDetector.js + shared VideoTracker /
 * activity rules), driven deterministically by tests/unit/courseraHarness.mjs.
 * Background answers come from the real engine.
 *
 * MOCKED PAGE: the authenticated Coursera player could not be inspected, so the
 * harness plays each plausible player behaviour (new element / reused element /
 * old lecture still playing after the route change / iframe player).
 *
 * Tolerance: the loop measures in ≈1 s intervals and drops the interval that
 * contains a transition, so each start/stop may lose up to ≈1 s (never gain).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCourseraWorld } from './courseraHarness.mjs';

const COURSE = 'learning-how-to-learn';
const A = `/learn/${COURSE}/lecture/75EsZ/introduction-to-the-focused-and-diffuse-modes`;
const B = `/learn/${COURSE}/lecture/1bYD5/terrence-sejnowski-and-barbara-oakley-introduction-to-the-course-structure`;
const C = `/learn/${COURSE}/lecture/GVacn/using-the-focused-and-diffuse-modes-or-a-little-dali-will-do-you`;
const S = 1000;
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ≈${expected} ±${tol}, got ${actual}`);

async function watching(path = A, opts = {}) {
  const w = createCourseraWorld();
  await w.open(path, opts);
  return w;
}

// ---- detection / eligibility ----------------------------------------------------------

test('coursera page: a lecture is detected — course and lecture identity in the status', async () => {
  const w = await watching();
  const p = structuredClone(w.ping()); // plain objects (the sandbox has its own Object prototype)
  assert.equal(p.platform, 'coursera');
  assert.equal(p.onLearnPage, true);
  assert.equal(p.hasVideo, true);
  assert.deepEqual(p.course, { key: `coursera:course:${COURSE}`, title: 'Learning How To Learn' });
  assert.deepEqual(p.lecture, { id: '75EsZ', title: 'Introduction To The Focused And Diffuse Modes' });
});

test('coursera page: genuine playback → content + actual time, one session for the lecture', async () => {
  const w = await watching();
  w.play();
  await w.advance(60 * S);
  w.pause();
  await w.settle();
  near(w.content(), 60, 1.5, 'content');
  near(w.active(), 60, 1.5, 'actual');
  assert.equal(w.ping().reason, 'paused');
  const ss = w.sessions();
  assert.equal(ss.length, 1);
  assert.equal(ss[0].platform, 'coursera');
  assert.equal(ss[0].contentId, COURSE);
  assert.equal(ss[0].lessonId, '75EsZ');
  assert.equal(ss[0].lessonTitle, 'Introduction To The Focused And Diffuse Modes');
  near(w.day().platforms.coursera.contentSeconds, 60, 1.5);
  assert.ok(w.credits.every((c) => c.source?.platform === 'coursera' && c.course === undefined), 'Coursera credits carry a source, never a Udemy course');
});

test('coursera page: non-lecture pages never count, even with a video playing', async () => {
  for (const path of [
    '/', '/search?query=python', '/browse/data-science', `/learn/${COURSE}`,
    `/learn/${COURSE}/home/welcome`, `/learn/${COURSE}/supplement/AbCdE/reading`,
    `/learn/${COURSE}/quiz/AbCdE/practice-quiz`, `/learn/${COURSE}/exam/AbCdE/final`,
    '/specializations/machine-learning-introduction',
  ]) {
    const w = await watching(path);
    w.play();
    await w.advance(20 * S);
    w.pause();
    await w.settle();
    assert.equal(w.content(), 0, path);
    assert.equal(w.credits.length, 0, path);
    assert.equal(w.ping().onLearnPage, false, path);
    assert.equal(w.ping().reason, 'not-learn-page', path);
  }
});

test('coursera page: player detection — the lecture <video> is used, a small preview never counts', async () => {
  const w = await watching(A, { player: 'none', preview: true });
  await w.advance(20 * S);
  assert.equal(w.ping().reason, 'no-video', 'a thumbnail-sized video is not the lecture');
  assert.equal(w.credits.length, 0);
});

test('coursera page: a player the script cannot see (cross-origin iframe) counts nothing', async () => {
  const w = await watching(A, { player: 'iframe' });
  await w.advance(30 * S);
  const p = w.ping();
  assert.equal(p.onLearnPage, true);
  assert.equal(p.hasVideo, false);
  assert.equal(p.reason, 'no-video');
  assert.equal(w.credits.length, 0);
});

// ---- playback rules ---------------------------------------------------------------------

test('coursera playback: pause / resume — paused time is not counted', async () => {
  const w = await watching();
  w.play();
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  const atPause = w.content();
  await w.advance(60 * S);
  assert.equal(w.content(), atPause, 'nothing while paused');
  w.play();
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  near(w.content(), 40, 2);
});

test('coursera playback: ended lecture stops counting', async () => {
  const w = createCourseraWorld({ duration: 30 });
  await w.open(A);
  w.play();
  await w.advance(60 * S);
  await w.settle();
  near(w.content(), 30, 1.5, 'only the 30 s the video lasted');
  assert.equal(w.ping().reason, 'ended');
});

test('coursera playback: buffering, frozen decoder and lifecycle freeze are not counted', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.buffer(true);
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'buffering');
  w.buffer(false);
  await w.advance(10 * S);
  w.freezeDecoder(true); // claims to play, currentTime never moves, no event
  await w.advance(30 * S);
  w.freezeDecoder(false);
  w.lifecycleFreeze(true);
  await w.advance(1 * S);
  assert.equal(w.ping().reason, 'frozen');
  w.lifecycleFreeze(false);
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 3, 'only real progress');
  near(w.active(), 30, 3, 'stalled time is not watch time either');
});

test('coursera playback: forward and backward seeks are not counted; baseline resets', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.seekTo(w.player().currentTime + 300); // skip 5 minutes
  await w.advance(10 * S);
  w.seekTo(5);                             // jump back
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 2, 'only played seconds, no jump');
});

test('coursera playback: 2x speed → content doubles, actual stays real time', async () => {
  const w = await watching();
  w.rate(2);
  w.play();
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  near(w.content(), 60, 2.5, 'content');
  near(w.active(), 30, 1.5, 'actual');
  assert.equal(w.ping().playbackRate, 2);
});

test('coursera playback: player element re-rendered on the same lecture → no double count, keeps counting', async () => {
  const w = await watching();
  w.play();
  await w.advance(20 * S);
  w.rerender();
  await w.advance(20 * S);
  w.pause();
  await w.settle();
  near(w.content(), 40, 2);
  assert.ok(w.content() <= 40.5, 'never more than real playback');
  assert.deepEqual(Object.keys(w.byLecture()), ['75EsZ']);
});

test('coursera playback: background tab with throttled timers keeps counting genuine playback', async () => {
  const w = await watching();
  w.play();
  await w.advance(5 * S);
  w.hide();
  w.blur();
  w.throttleMs = 60_000; // intensive throttling: timers ≈ once a minute; timeupdate still drives measurement
  await w.advance(120 * S);
  w.show();
  w.pause();
  await w.settle();
  near(w.content(), 125, 3);
});

test('coursera playback: background tab with the video stopped by the browser counts nothing', async () => {
  const w = await watching();
  w.play();
  await w.advance(5 * S);
  w.hide();
  w.freezeDecoder(true);
  await w.advance(60 * S);
  w.show();
  w.freezeDecoder(false);
  w.pause();
  await w.settle();
  near(w.content(), 5, 1.5);
});

test('coursera playback: screen lock and system sleep follow the shared engine', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.lock(true);
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'locked');
  w.lock(false);
  await w.advance(10 * S);
  w.asleep = true;
  await w.advance(600 * S); // lid closed: nothing runs, the video does not move
  w.asleep = false;
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 3);
});

// ---- navigation / identity --------------------------------------------------------------

for (const mode of ['replace', 'reuse']) {
  test(`coursera navigation (${mode} player): lecture change splits attribution, nothing leaks`, async () => {
    const w = await watching();
    w.play();
    await w.advance(30 * S);
    w.navigate(B, { mode, swapDelayMs: 800 });
    await w.advance(30 * S);
    w.pause();
    await w.settle();
    const by = w.byLecture();
    near(by['75EsZ'], 30, 1.5, 'A');
    near(by['1bYD5'], 29, 2, 'B');
    assert.ok(by['75EsZ'] + by['1bYD5'] <= 60.5, 'never more than real playback');
    const [sa, sb] = w.sessions();
    assert.equal(w.sessions().length, 2, 'one session per lecture');
    assert.equal(sa.lessonId, '75EsZ');
    assert.equal(sb.lessonId, '1bYD5');
    assert.ok(sb.startedAt >= sa.endedAt, 'B starts after A ends');
    assert.deepEqual(w.ping().lecture.id, '1bYD5');
  });
}

test('coursera navigation: the OLD lecture still playing under the new URL never counts for either', async () => {
  const w = await watching();
  w.play();
  await w.advance(20 * S);
  w.navigate(B, { mode: 'stale', swapDelayMs: 15 * S }); // route changes; A keeps playing 15 s
  await w.advance(5 * S);
  assert.equal(w.ping().reason, 'loading', 'old media is not the new lecture');
  await w.advance(25 * S);
  w.pause();
  await w.settle();
  const by = w.byLecture();
  near(by['75EsZ'], 20, 1.5, 'A only up to the route change');
  near(by['1bYD5'], 15, 2, 'B only once its own media plays');
});

test('coursera navigation: lecture change while paused — the new lecture needs its own playback', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  w.navigate(B, { mode: 'replace', keepPlaying: false });
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'paused');
  w.play();
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  const by = w.byLecture();
  near(by['75EsZ'], 10, 1.5);
  near(by['1bYD5'], 10, 1.5);
});

test('coursera navigation: browser back (popstate) re-attributes to the earlier lecture', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.navigate(B);
  await w.advance(10 * S);
  w.back(A);
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  const by = w.byLecture();
  near(by['75EsZ'], 20, 2.5);
  near(by['1bYD5'], 10, 2);
  assert.deepEqual(w.sessions().map((s) => s.lessonId), ['75EsZ', '1bYD5', '75EsZ']);
});

test('coursera navigation: rapid lecture hopping never credits more than real playback', async () => {
  const w = await watching();
  w.play();
  for (const p of [B, C, A, B, C]) {
    await w.advance(700);
    w.navigate(p, { mode: 'stale', swapDelayMs: 400 });
  }
  await w.advance(10 * S);
  w.pause();
  await w.settle();
  assert.ok(w.content() <= 14, `credited ${w.content()} s of ≈13.5 s real playback`);
  near(w.byLecture()['GVacn'] || 0, 10, 2, 'the lecture finally watched');
});

test('coursera navigation: leaving to a quiz / course home stops counting at once', async () => {
  const w = await watching();
  w.play();
  await w.advance(20 * S);
  w.navigate(`/learn/${COURSE}/quiz/AbCdE/practice-quiz`, { mode: 'leave' });
  await w.advance(30 * S);
  assert.equal(w.ping().reason, 'not-learn-page');
  await w.settle();
  near(w.content(), 20, 1.5);
  w.navigate(`/learn/${COURSE}/home/welcome`, { mode: 'leave' });
  await w.advance(10 * S);
  assert.equal(w.ping().onLearnPage, false);
  near(w.content(), 20, 1.5);
});

test('coursera navigation: a quiz page whose own video keeps playing never counts', async () => {
  const w = await watching();
  w.play();
  await w.advance(10 * S);
  w.navigate(`/learn/${COURSE}/quiz/AbCdE/practice-quiz`, { mode: 'stale', swapDelayMs: 60 * S });
  await w.advance(30 * S);
  await w.settle();
  near(w.content(), 10, 1.5);
});

// ---- robustness ---------------------------------------------------------------------------

test('coursera robustness: re-injection (extension update) → one tracker, one listener set, no double count', async () => {
  const w = await watching();
  const listeners = w.docListenerCount('play');
  const runtime = w.runtimeListenerCount();
  w.inject();
  w.inject();
  await w.advance(100);
  assert.equal(w.docListenerCount('play'), listeners, 'old instances removed their media listeners');
  assert.equal(w.runtimeListenerCount(), runtime, 'old instances removed their runtime listener');
  w.play();
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 1.5);
});

test('coursera robustness: many lecture changes do not accumulate listeners', async () => {
  const w = await watching();
  const before = ['play', 'timeupdate', 'loadstart'].map((t) => w.docListenerCount(t));
  w.play();
  for (let i = 0; i < 10; i += 1) {
    w.navigate(i % 2 ? A : B);
    await w.advance(2 * S);
  }
  assert.deepEqual(['play', 'timeupdate', 'loadstart'].map((t) => w.docListenerCount(t)), before);
});

test('coursera robustness: script injected while a lecture is already playing counts only from then on', async () => {
  const w = createCourseraWorld();
  // page loaded and playing before the extension (e.g. installed mid-lecture)
  await w.open(A, { inject: false });
  w.play();
  await w.advance(40 * S);
  assert.equal(w.credits.length, 0);
  w.inject();
  await w.advance(30 * S);
  w.pause();
  await w.settle();
  near(w.content(), 30, 1.5, 'only after injection');
  assert.deepEqual(Object.keys(w.byLecture()), ['75EsZ']);
});
