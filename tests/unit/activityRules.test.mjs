import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod } from './helpers.mjs';

await mod('content/activityRules.js');
const { computeCredit, evaluateConditions, measureInterval } = globalThis.__UdemyStreak;

const base = { onLearnPage: true, hasVideo: true, systemLocked: false, frozen: false, ended: false, paused: false, seeking: false, readyState: 4 };

test('normal 1x playback: full real time credited', () => {
  assert.equal(computeCredit({ wallSeconds: 1, mediaDelta: 1, playbackRate: 1 }), 1);
  assert.equal(computeCredit({ wallSeconds: 1.02, mediaDelta: 0.98, playbackRate: 1 }), 1.02);
});

test('Case 6: 1.5x and 2x count REAL time, not lecture time', () => {
  assert.equal(computeCredit({ wallSeconds: 1, mediaDelta: 1.5, playbackRate: 1.5 }), 1);
  assert.equal(computeCredit({ wallSeconds: 1, mediaDelta: 2, playbackRate: 2 }), 1);
  // 60 real minutes at 2x → 60 minutes, not 120
  let total = 0;
  for (let i = 0; i < 3600; i += 1) total += computeCredit({ wallSeconds: 1, mediaDelta: 2, playbackRate: 2 });
  assert.equal(Math.round(total), 3600);
});

test('Case 8: sleep — wall clock jumps but video did not advance → ~0 credit', () => {
  assert.ok(computeCredit({ wallSeconds: 3 * 3600, mediaDelta: 0, playbackRate: 1 }) < 0.2);
  assert.ok(computeCredit({ wallSeconds: 3 * 3600, mediaDelta: 1, playbackRate: 1 }) < 1.3);
});

test('stall/buffering: credit limited by actual progress', () => {
  const c = computeCredit({ wallSeconds: 1, mediaDelta: 0.3, playbackRate: 1 });
  assert.ok(c > 0.3 && c < 0.6);
});

test('seek inside an interval grants at most a bounded amount', () => {
  assert.equal(computeCredit({ wallSeconds: 1, mediaDelta: 300, playbackRate: 1 }), 1);
  assert.equal(computeCredit({ wallSeconds: 1, mediaDelta: -120, playbackRate: 1 }), 1);
  assert.equal(computeCredit({ wallSeconds: 10, mediaDelta: 400, playbackRate: 1 }), 1.5);
  assert.equal(computeCredit({ wallSeconds: 1, mediaDelta: 1, playbackRate: 1, seeked: true }), 1);
});

test('garbage input → 0', () => {
  assert.equal(computeCredit({ wallSeconds: 0, mediaDelta: 1, playbackRate: 1 }), 0);
  assert.equal(computeCredit({ wallSeconds: -1, mediaDelta: 1, playbackRate: 1 }), 0);
  assert.equal(computeCredit({ wallSeconds: 1, mediaDelta: NaN, playbackRate: 1 }), 0);
  assert.equal(computeCredit({ wallSeconds: 1, mediaDelta: 1, playbackRate: 0 }), 1); // rate fallback 1
});

test('counting conditions', () => {
  assert.deepEqual(evaluateConditions(base), { ok: true, reason: 'tracking' });
  assert.equal(evaluateConditions({ ...base, paused: true }).reason, 'paused');           // Case 5
  assert.equal(evaluateConditions({ ...base, frozen: true }).reason, 'frozen');           // browser suspended the page
  assert.equal(evaluateConditions({ ...base, systemLocked: true }).reason, 'locked');
  assert.equal(evaluateConditions({ ...base, ended: true, paused: true }).reason, 'ended');
  assert.equal(evaluateConditions({ ...base, readyState: 1 }).reason, 'buffering');
  assert.equal(evaluateConditions({ ...base, seeking: true }).reason, 'buffering');
  assert.equal(evaluateConditions({ ...base, hasVideo: false }).reason, 'no-video');
  assert.equal(evaluateConditions({ ...base, onLearnPage: false }).reason, 'not-learn-page');
});

test('V1.2: tab visibility and window focus never stop counting', () => {
  // Even if a caller still passes the V1.1 inputs, they are ignored.
  assert.equal(evaluateConditions({ ...base, visible: false }).ok, true);                                   // background tab
  assert.equal(evaluateConditions({ ...base, pageFocused: false }).ok, true);                               // another app focused
  assert.equal(evaluateConditions({ ...base, visible: false, pageFocused: false, requireWindowFocus: true }).ok, true); // old setting
  // ...but playback state and lock still do
  assert.equal(evaluateConditions({ ...base, visible: false, paused: true }).ok, false);
  assert.equal(evaluateConditions({ ...base, visible: false, ended: true }).ok, false);
  assert.equal(evaluateConditions({ ...base, visible: false, systemLocked: true }).ok, false);
});

test('V1.2: throttled background timer (one ~60 s interval) is credited in full', () => {
  const at1x = measureInterval({ perf: 0, media: 100, rate: 1 }, { perf: 60_000, media: 160 });
  assert.ok(Math.abs(at1x.content - 60) < 0.01 && Math.abs(at1x.active - 60) < 0.01, JSON.stringify(at1x));
  const at2x = measureInterval({ perf: 0, media: 100, rate: 2 }, { perf: 61_000, media: 222 });
  assert.ok(Math.abs(at2x.content - 122) < 0.01 && Math.abs(at2x.active - 61) < 0.01, JSON.stringify(at2x));
});
