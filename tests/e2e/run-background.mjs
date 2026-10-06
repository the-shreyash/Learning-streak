/**
 * V1.2 browser test — tracking continues while the Udemy tab is in the background
 * or another application has focus, in a real Chromium with the real extension,
 * against a mock Udemy lecture page playing a 60-minute video.
 *
 *   npm run test:background                  # full-length scenarios (~12 min)
 *   SPEED_SCALE=0.2 npm run test:background  # same scenarios, 5x shorter
 *
 * Scenarios (full length):
 *   A  30 s visible + 30 s in another tab (playing)      → ≈60 s content, ≈60 s actual
 *   B  playing while another window/app has focus 30 s   → +≈30 s
 *   C  background, pause, wait 30 s                      → only pre-pause time
 *   D  background, lecture reaches its end               → stops at the end
 *   E  2× in the background for 5 real minutes           → ≈600 s content, ≈300 s actual
 *   F  background seek 5:00 → 15:00                      → jump not counted
 *   +  background lecture switch (40:00 → new lecture)   → no 40-min jump
 *   G  screen locked while playing in the background     → lock time not counted
 *
 * Nothing here keeps the tab alive or forces playback: if Chrome stopped the
 * video in the background, the "video advanced" numbers would show it and the
 * tracker would (correctly) record nothing.
 */
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './cdp.mjs';
import { startMockUdemy } from './mockUdemy.mjs';

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.E2E_NO_XVFB && spawnSync('which', ['xvfb-run']).status === 0) {
  const r = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, E2E_NO_XVFB: '1' } });
  process.exit(r.status ?? 1);
}
const HEADLESS = !process.env.DISPLAY;
const SCALE = Math.max(0.05, Number(process.env.SPEED_SCALE) || 1);
const S = (sec) => Math.round(sec * SCALE * 1000) / 1000; // scaled seconds
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const executable = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const videoPath = path.join(here, 'fixtures', 'lecture-60min.webm');
if (!existsSync(videoPath)) {
  mkdirSync(path.dirname(videoPath), { recursive: true });
  console.log('Generating 60-minute test video (one-time, ~2 min)…');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=16000', '-t', '3600', '-c:v', 'libvpx', '-b:v', '15k', '-c:a', 'libopus', '-b:a', '12k', videoPath]);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-bg-'));
const profile = path.join(tmp, 'profile');
const results = [];
const check = (name, ok, detail = '') => { if (/INCONCLUSIVE/.test(detail)) ok = false; results.push({ name, ok }); console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `  — ${detail}` : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// Tolerance: ~1 s per measured transition + 1.5 % of the expected amount.
const tol = (expected, transitions = 2) => 1.5 * transitions + expected * 0.015;

const { server, port } = await startMockUdemy({ videoPath, certDir: path.join(tmp, 'cert') });
const LECTURE_URL = 'https://www.udemy.com/course/machine-learning-az/learn/lecture/101';
let chrome; let cdp; let SW;

async function findServiceWorker() {
  for (let t = 0; t < 60; t += 1) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((x) => x.type === 'service_worker' && x.url.endsWith('/src/background/serviceWorker.js'));
    if (sw) {
      const session = await cdp.attach(sw.targetId);
      for (let i = 0; i < 40; i += 1) {
        try { if (await cdp.eval(session, `typeof chrome !== 'undefined' && !!chrome.storage`)) break; } catch { /* starting */ }
        await sleep(250);
      }
      return { session, extId: new URL(sw.url).host };
    }
    await sleep(250);
  }
  throw new Error('service worker not found');
}
async function openTab(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const session = await cdp.attach(targetId);
  for (let i = 0; i < 80; i += 1) {
    try { if ((await cdp.eval(session, 'document.readyState')) === 'complete') break; } catch { /* navigating */ }
    await sleep(150);
  }
  return { targetId, session };
}
const swEval = (e) => cdp.eval(SW.session, e);
const TODAY = `(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })()`;
const today = () => swEval(`chrome.storage.local.get('dailyHistory').then(r => r.dailyHistory?.[${TODAY}] || {})`);

let page; let tabId;
const call = (expr) => cdp.eval(page.session, expr);
const pageState = () => call(`({ vis: document.visibilityState, focus: document.hasFocus(), paused: document.querySelector('.player-zone video')?.paused, ended: document.querySelector('.player-zone video')?.ended })`);
const trackingTabs = () => swEval(`chrome.storage.session.get('trackingTabs').then(r => Object.keys(r.trackingTabs || {}).length)`);

// The REAL screen lock (chrome.idle) legitimately stops counting. If the machine
// running the test locks or idles into the screensaver mid-scenario, the result
// says nothing about background tracking — flag it instead of misreporting.
const realLockSeen = () => swEval(`(async () => {
  if (!globalThis.__lockWatch) {
    globalThis.__lockWatch = { seen: false };
    chrome.idle.onStateChanged.addListener((st) => { if (st === 'locked') globalThis.__lockWatch.seen = true; });
  }
  const now = !globalThis.__realQueryState && (await chrome.idle.queryState(60)) === 'locked';
  const seen = globalThis.__lockWatch.seen || now;
  globalThis.__lockWatch.seen = false;
  return seen;
})()`);

/** Run fn, then report Δcontent, Δactual and Δvideo position (of the current lecture video). */
async function measure(fn) {
  await realLockSeen();
  const r0 = await today();
  const v0 = await call('__test.time()');
  await fn();
  await call('__test.pause()');
  await sleep(1500); // pause → immediate flush
  const r1 = await today();
  return {
    content: (r1.contentSeconds || 0) - (r0.contentSeconds || 0),
    active: (r1.actualActiveSeconds || 0) - (r0.actualActiveSeconds || 0),
    video: (await call('__test.time()')) - v0,
    lockedBySystem: await realLockSeen(),
  };
}
const fmt = (m) => `content ${m.content.toFixed(1)} s, actual ${m.active.toFixed(1)} s, video advanced ${m.video.toFixed(1)} s${m.lockedBySystem ? '  ⚠ the test machine screen locked/idled during this scenario — INCONCLUSIVE, rerun with the screen unlocked' : ''}`;
const play = async (sec) => { await call('__test.play()'); await sleep(sec * 1000); };

/** Switch to another tab in the same window (Udemy tab becomes hidden). */
async function toOtherTab() {
  const other = await swEval(`chrome.tabs.create({ url: 'about:blank', active: true }).then(t => t.id)`);
  await sleep(500);
  return other;
}
async function backFromTab(other) {
  await swEval(`chrome.tabs.update(${tabId}, { active: true }).then(() => chrome.tabs.remove(${other})).then(() => true)`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(300);
}
/**
 * Leave the browser for "another application": another window takes focus and
 * the Udemy window is minimised (as when VS Code covers Chrome).
 */
async function toOtherApp() {
  const { targetId: win } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  let windowId = null;
  try {
    ({ windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId }));
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  } catch { /* window state not supported here: focus change alone still applies */ }
  await sleep(500);
  return { win, windowId };
}
async function backFromApp({ win, windowId }) {
  if (windowId != null) { try { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } catch { /* ignore */ } }
  await cdp.send('Target.closeTarget', { targetId: win });
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(300);
}

try {
  console.log(`\nLearnStreak V1.2 — background tracking browser test (scale ${SCALE})\n`);
  chrome = await launchChrome({ executable, userDataDir: profile, extensionDir: path.join(root, 'extension'), hostRules: `MAP www.udemy.com 127.0.0.1:${port}`, headless: HEADLESS });
  cdp = chrome.cdp;
  SW = await findServiceWorker();

  page = await openTab(LECTURE_URL);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(2500);
  tabId = await swEval(`chrome.tabs.query({ url: 'https://*.udemy.com/*' }).then(t => t[0].id)`);
  await call('__test.seekTo(60)');

  // ---- A: background tab
  let st = null;
  let m = await measure(async () => {
    await play(S(30));
    const other = await toOtherTab();
    st = await pageState();
    await sleep(S(30) * 1000 - 500);
    await backFromTab(other);
  });
  check(`A  watch ${S(30)} s, other tab ${S(30)} s (video playing) → ≈${S(60)} s content and actual (not ${S(30)})`,
    st.vis === 'hidden' && st.paused === false && near(m.content, S(60), tol(S(60))) && near(m.active, S(60), tol(S(60))), `${st.vis}, ${fmt(m)}`);

  // ---- B: another application focused
  let tracking = null;
  m = await measure(async () => {
    await play(S(10));
    const app = await toOtherApp();
    st = await pageState();
    await sleep(S(15) * 1000);
    tracking = await trackingTabs();
    await sleep(S(15) * 1000 - 500);
    await backFromApp(app);
  });
  check(`B  ${S(30)} s with another window/app focused (video playing) → +≈${S(30)} s, badge stays "tracking"`,
    st.focus === false && st.paused === false && tracking === 1 && near(m.content, S(40), tol(S(40))), `vis=${st.vis}, hasFocus=${st.focus}, ${fmt(m)}`);

  // ---- C: paused while in the background
  let pausedGain = null;
  m = await measure(async () => {
    await play(S(20));
    const app = await toOtherApp();
    await sleep(S(10) * 1000);
    await call('__test.pause()');
    await sleep(1500);
    const mid = await today();
    await sleep(S(30) * 1000);
    pausedGain = (await today()).contentSeconds - mid.contentSeconds;
    await backFromApp(app);
  });
  check(`C  background pause for ${S(30)} s → only the ≈${S(30)} s before the pause counts`,
    pausedGain === 0 && near(m.content, S(30), tol(S(30))), `gain while paused ${pausedGain}, ${fmt(m)}`);

  // ---- D: lecture reaches its end in the background
  await call(`__test.seekTo(${3600 - S(20)})`);
  await sleep(500);
  m = await measure(async () => {
    await call('__test.play()');
    const app = await toOtherApp();
    await sleep(S(40) * 1000);
    st = await pageState();
    await backFromApp(app);
  });
  check(`D  lecture ends in the background → counting stops at the end (≈${S(20)} s of ${S(40)} s)`,
    st.ended === true && near(m.content, S(20), tol(S(20))), `ended=${st.ended}, ${fmt(m)}`);

  // ---- E: 2× in the background for 5 real minutes
  await call('__test.seekTo(120)');
  await call('__test.rate(2)');
  await sleep(500);
  m = await measure(async () => {
    await call('__test.play()');
    const app = await toOtherApp();
    await sleep(S(300) * 1000);
    await backFromApp(app);
  });
  check(`E  2× in the background for ${S(300)} s real → content ≈${S(600)} s, actual ≈${S(300)} s`,
    near(m.content, S(600), tol(S(600))) && near(m.active, S(300), tol(S(300))) && near(m.content, m.video, tol(m.video)), fmt(m));
  await call('__test.rate(1)');

  // ---- F: seek 5:00 → 15:00 while the tab is hidden
  await call('__test.seekTo(300)');
  await sleep(500);
  m = await measure(async () => {
    await play(S(20));
    const other = await toOtherTab();
    await call('__test.seekTo(900)');
    await sleep(S(20) * 1000);
    await backFromTab(other);
  });
  check(`F  background seek 5:00 → 15:00 → only ≈${S(40)} s of playback counted (not +600 s)`,
    near(m.content, S(40), tol(S(40), 3)), fmt(m));

  // ---- Background lecture switch (40:00 → new lecture at 0:00)
  await call('__test.seekTo(2400)');
  await sleep(500);
  m = await measure(async () => {
    await play(S(10));
    const other = await toOtherTab();
    await sleep(S(10) * 1000);
    await call('__test.nextLecture()'); // new <video> at 0:00, autoplays
    await sleep(S(20) * 1000);
    await backFromTab(other);
  });
  check(`+  lecture switch in the background → ≈${S(40)} s, no 40-minute jump`,
    near(m.content, S(40), tol(S(40), 3)), `content ${m.content.toFixed(1)} s, actual ${m.active.toFixed(1)} s`);

  // ---- G: screen locked while playing in the background.
  // chrome.idle can't be locked from a test, so the worker's idle query is stubbed
  // to report "locked" and the same system:lock broadcast the worker sends is delivered.
  const setLock = (locked) => swEval(`(async () => {
    if (!globalThis.__realQueryState) globalThis.__realQueryState = chrome.idle.queryState.bind(chrome.idle);
    chrome.idle.queryState = ${locked} ? async () => 'locked' : globalThis.__realQueryState;
    await chrome.tabs.sendMessage(${tabId}, { type: 'system:lock', locked: ${locked} });
    return true;
  })()`);
  let lockedGain = null;
  m = await measure(async () => {
    await play(S(20));
    const other = await toOtherTab();
    await sleep(S(10) * 1000);
    await setLock(true);
    await sleep(1500);
    const mid = await today();
    await sleep(S(30) * 1000);
    lockedGain = (await today()).contentSeconds - mid.contentSeconds;
    await setLock(false);
    await sleep(S(10) * 1000);
    await backFromTab(other);
  });
  check(`G  locked for ${S(30)} s in the background → 0 counted while locked, resumes after unlock (≈${S(40)} s total)`,
    lockedGain === 0 && near(m.content, S(40), tol(S(40), 4)), `gain while locked ${lockedGain}, ${fmt(m)}`);
} catch (err) {
  check('background test completed without errors', false, err.stack || String(err));
} finally {
  try { chrome?.proc.kill('SIGKILL'); } catch { /* ignore */ }
  server.close();
  await sleep(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
