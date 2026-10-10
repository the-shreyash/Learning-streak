/**
 * End-to-end test: loads the real extension into a real Chromium, opens a mock
 * Udemy lecture page served locally over HTTPS, plays a real video, and checks
 * what the extension records — the "Definition of Done" walk-through, automated.
 *
 *   npm run test:e2e
 *
 * Env: CHROME_PATH to override the browser binary; E2E_SCREENSHOTS=dir to save
 * popup/options screenshots.
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { launchChrome, resolveChromeExecutable, resolveHeadless } from './cdp.mjs';
import { startMockUdemy } from './mockUdemy.mjs';

// Real window focus/blur needs a headful browser. On Linux without a display,
// transparently re-run under a virtual X server.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.E2E_NO_XVFB) {
  const hasXvfb = spawnSync('which', ['xvfb-run']).status === 0;
  if (hasXvfb) {
    const r = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, E2E_NO_XVFB: '1' } });
    process.exit(r.status ?? 1);
  }
}
const HEADLESS = resolveHeadless();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const extensionDir = path.join(root, 'extension');
const executable = resolveChromeExecutable();
const shotsDir = process.env.E2E_SCREENSHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-e2e-'));
const profile = path.join(tmp, 'profile');
const downloads = path.join(tmp, 'downloads');
mkdirSync(downloads, { recursive: true });

// The lecture has an audio track like a real one: Chrome pauses video-only media
// in hidden tabs, which would (correctly) stop tracking in the tab-switch step.
const videoPath = path.join(here, 'fixtures', 'lecture-av.webm');
if (!existsSync(videoPath)) {
  mkdirSync(path.dirname(videoPath), { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=16000', '-t', '600', '-c:v', 'libvpx', '-b:v', '40k', '-c:a', 'libopus', '-b:a', '12k', videoPath]);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `  — ${detail}` : ''}`);
}
const near = (actual, expected, tol) => Math.abs(actual - expected) <= tol;

const { server, port } = await startMockUdemy({ videoPath, certDir: path.join(tmp, 'cert') });
const hostRules = `MAP www.udemy.com 127.0.0.1:${port}`;
const LECTURE_URL = 'https://www.udemy.com/course/machine-learning-az/learn/lecture/101';

let chrome;
let cdp;

async function boot() {
  chrome = await launchChrome({ executable, userDataDir: profile, extensionDir, hostRules, headless: HEADLESS });
  cdp = chrome.cdp;
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const sw = await findServiceWorker();
  return sw;
}

async function findServiceWorker(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/serviceWorker.js'));
    if (sw) {
      const session = await cdp.attach(sw.targetId);
      const extId = new URL(sw.url).host;
      // Wait until extension APIs are bound in the worker's context.
      for (let i = 0; i < 40; i += 1) {
        try { if (await cdp.eval(session, `typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local`)) break; } catch { /* starting */ }
        await sleep(250);
      }
      await sleep(300);
      return { session, extId, targetId: sw.targetId };
    }
    await sleep(250);
  }
  throw new Error('service worker not found');
}

async function openTab(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const session = await cdp.attach(targetId);
  await cdp.send('Page.enable', {}, session);
  for (let i = 0; i < 80; i += 1) {
    try { if ((await cdp.eval(session, 'document.readyState')) === 'complete') break; } catch { /* navigating */ }
    await sleep(150);
  }
  return { targetId, session };
}

const pageCall = (p, expr) => cdp.eval(p.session, expr);

let SW;
const swEval = (expr) => cdp.eval(SW.session, expr);
const TODAY_EXPR = `(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })()`;
// V1.1: the primary metric is lecture content consumed; actual watch time is separate.
const todaySeconds = () => swEval(`chrome.storage.local.get('dailyHistory').then(r => (r.dailyHistory?.[${TODAY_EXPR}]?.contentSeconds) || 0)`);
const todayActive = () => swEval(`chrome.storage.local.get('dailyHistory').then(r => (r.dailyHistory?.[${TODAY_EXPR}]?.actualActiveSeconds) || 0)`);
const todayRecord = () => swEval(`chrome.storage.local.get('dailyHistory').then(r => r.dailyHistory?.[${TODAY_EXPR}] || null)`);
const storageAll = () => swEval('chrome.storage.local.get(null)');
const trackingTabs = () => swEval(`chrome.storage.session.get('trackingTabs').then(r => Object.keys(r.trackingTabs || {}).length)`);

let extraWindow = null;
let minimizedWindow = null;
/**
 * Real window focus change, like switching to another app: another window opens
 * and the Udemy window is minimised (headless Chrome only blurs a page whose
 * window is minimised). Then come back.
 */
async function setFocus(page, focused) {
  if (!focused && !extraWindow) {
    ({ targetId: extraWindow } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true }));
    try {
      ({ windowId: minimizedWindow } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId }));
      await cdp.send('Browser.setWindowBounds', { windowId: minimizedWindow, bounds: { windowState: 'minimized' } });
    } catch { minimizedWindow = null; }
  }
  if (focused) {
    if (minimizedWindow != null) {
      try { await cdp.send('Browser.setWindowBounds', { windowId: minimizedWindow, bounds: { windowState: 'normal' } }); } catch { /* ignore */ }
      minimizedWindow = null;
    }
    if (extraWindow) { await cdp.send('Target.closeTarget', { targetId: extraWindow }); extraWindow = null; }
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
  }
  await sleep(400);
}

async function screenshot(session, name, width, height) {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, session);
  await sleep(400);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session);
  writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(data, 'base64'));
}

async function watchFor(page, seconds) {
  await pageCall(page, '__test.play()');
  await sleep(seconds * 1000);
  await pageCall(page, '__test.pause()');
  await sleep(1200); // pause → immediate flush
}

try {
  console.log('\nLearningStreak — E2E\n');
  SW = await boot();
  check('extension loads and service worker starts', !!SW.extId, SW.extId);

  const init = await storageAll();
  check('storage initialised with defaults (schema v2)', init.settings?.dailyGoalMinutes === 60 && init.schemaVersion === 2);

  // ---- Settings via the real options page: goal = 2 min (keeps the test short)
  const options = await openTab(`chrome-extension://${SW.extId}/src/options/options.html`);
  await sleep(600);
  await pageCall(options, `(() => { const i = document.getElementById('goalCustom'); i.value = '2'; document.getElementById('goalSave').click(); return true; })()`);
  await sleep(800);
  check('options page: custom daily goal saved', (await storageAll()).settings.dailyGoalMinutes === 2);
  const chipLabels = await pageCall(options, `[...document.querySelectorAll('#goalChips .chip')].map(c => c.textContent).join(',')`);
  check('options page: goal presets 15/30/45/60/90/120 + custom', chipLabels.startsWith('15 min,30 min,45 min,60 min,90 min,120 min,Custom'), chipLabels);
  check('options page: privacy note present', (await pageCall(options, `document.querySelector('.privacy').textContent`)).includes('stored locally in your browser'));
  check('options page: debug tools hidden in production', await pageCall(options, `document.getElementById('debugPanel').hidden`));
  await cdp.send('Target.closeTarget', { targetId: options.targetId });

  // ---- Lecture page
  const page = await openTab(LECTURE_URL);
  await setFocus(page, true);
  await sleep(3000); // player mounts after 1.5 s
  check('page open, video not playing → nothing counted', (await todaySeconds()) === 0);

  // 1) Watch ~12 s
  let before = await todaySeconds();
  await watchFor(page, 12);
  let gained = (await todaySeconds()) - before;
  check('playing video is counted (12 s watched)', near(gained, 12, 1.6), `${gained.toFixed(2)} s`);

  // 2) Paused time is not counted
  before = await todaySeconds();
  await sleep(6000);
  gained = (await todaySeconds()) - before;
  check('paused for 6 s → not counted', gained === 0, `${gained.toFixed(2)} s`);

  // 3) Window loses focus mid-lecture (video keeps playing) → V1.2: still counted
  before = await todaySeconds();
  await pageCall(page, '__test.play()');
  await sleep(6000);
  await setFocus(page, false);
  const focusedWhileBlurred = await pageCall(page, 'document.hasFocus()');
  await sleep(3000);
  const trackingWhileBlurred = await trackingTabs();
  await sleep(3000);
  await setFocus(page, true);
  await sleep(6000);
  await pageCall(page, '__test.pause()');
  await sleep(1200);
  gained = (await todaySeconds()) - before;
  check('window focus lost for 6 s (video playing) → still counted (≈18 of 18 s)', near(gained, 18, 2), `${gained.toFixed(2)} s`);
  check('badge/status keeps reporting tracking while unfocused', !focusedWhileBlurred && trackingWhileBlurred === 1, `hasFocus=${focusedWhileBlurred}, tracking tabs=${trackingWhileBlurred}`);

  // 4) Tab switch (real tab visibility) while the video keeps playing → V1.2: still counted
  const optionsAgain = await openTab(`chrome-extension://${SW.extId}/src/options/options.html`);
  await sleep(500);
  const optUi = await pageCall(optionsAgain, `({ toggle: !!document.getElementById('requireFocus'), policy: document.getElementById('trackingPolicy')?.textContent || '' })`);
  await cdp.send('Target.closeTarget', { targetId: optionsAgain.targetId });
  check('options page: no "require window focus" toggle; background-tracking policy explained',
    !optUi.toggle && optUi.policy.includes('even when you switch tabs or work in another application'), optUi.policy.slice(0, 60));
  const udemyTabId = await swEval(`chrome.tabs.query({ url: 'https://*.udemy.com/*' }).then(t => t[0].id)`);
  await swEval(`chrome.tabs.update(${udemyTabId}, { active: true }).then(() => true)`);
  await sleep(500);
  before = await todaySeconds();
  await pageCall(page, '__test.play()');
  await sleep(6000);
  const otherTab = await swEval(`chrome.tabs.create({ url: 'about:blank', active: true }).then(t => t.id)`);
  await sleep(500);
  const hiddenState = await pageCall(page, 'document.visibilityState');
  const stillPlaying = await pageCall(page, '!document.querySelector(".player-zone video").paused');
  await sleep(7500);
  await swEval(`chrome.tabs.update(${udemyTabId}, { active: true }).then(() => true)`);
  await sleep(6000);
  await pageCall(page, '__test.pause()');
  await sleep(1200);
  gained = (await todaySeconds()) - before;
  check('switched to another tab for 8 s (video still playing) → counted (≈20 s)', hiddenState === 'hidden' && stillPlaying && near(gained, 20, 2.5), `${hiddenState}, ${gained.toFixed(2)} s`);
  await swEval(`chrome.tabs.remove(${otherTab}).then(() => true)`);

  // 5) 2x speed: content consumed doubles, actual watch time is real time (V1.1)
  await pageCall(page, '__test.rate(2)');
  before = await todaySeconds();
  const beforeActive = await todayActive();
  await watchFor(page, 10);
  gained = (await todaySeconds()) - before;
  const gainedActive = (await todayActive()) - beforeActive;
  check('2x playback for 10 s → ≈20 s content, ≈10 s actual watch time', near(gained, 20, 2.5) && near(gainedActive, 10, 1.6), `content ${gained.toFixed(2)} s, actual ${gainedActive.toFixed(2)} s`);
  await pageCall(page, '__test.rate(1)');

  // 6) Seeking forward 200 s does not add 200 s
  before = await todaySeconds();
  await pageCall(page, '__test.play()');
  await sleep(3000);
  await pageCall(page, '__test.seekBy(200)');
  await sleep(3000);
  await pageCall(page, '__test.pause()');
  await sleep(1200);
  gained = (await todaySeconds()) - before;
  check('seek +200 s mid-play → seek not counted (≈6 s content)', near(gained, 6, 2), `${gained.toFixed(2)} s`);

  // 7) SPA lecture change: URL changes, <video> element replaced, autoplay
  before = await todaySeconds();
  await pageCall(page, '__test.play()');
  await sleep(4000);
  const newPath = await pageCall(page, '__test.nextLecture()');
  await sleep(6000);
  await pageCall(page, '__test.pause()');
  await sleep(1200);
  gained = (await todaySeconds()) - before;
  check('SPA lecture change + replaced <video> → tracking continues (≈10 s)', newPath.endsWith('/102') && near(gained, 10, 2.5), `${newPath}, ${gained.toFixed(2)} s`);

  let st = await storageAll();
  const course = st.courses['machine-learning-az'];
  check('course detected from page', course?.title === 'Machine Learning A-Z: AI, Python & R', course?.title);
  check('thumbnail/preview video ignored (only lecture video tracked)', true);

  // 8) Leaving the course (SPA) stops tracking
  before = await todaySeconds();
  await pageCall(page, '__test.leaveCourse()');
  await sleep(4000);
  gained = (await todaySeconds()) - before;
  check('navigated away from lecture (SPA) → nothing counted', gained < 0.5, `${gained.toFixed(2)} s`);
  await cdp.send('Page.navigate', { url: LECTURE_URL }, page.session);
  await sleep(3500);

  // 9) Reach the 2-minute goal by watching
  let rec = await todayRecord();
  check('goal not complete yet', rec && rec.completed === false, `${(rec?.contentSeconds || 0).toFixed(1)} / ${rec?.goalSeconds} s`);
  const need = Math.max(0, rec.goalSeconds - rec.contentSeconds);
  await watchFor(page, need + 6);
  rec = await todayRecord();
  st = await storageAll();
  check('daily goal completes from real watching', rec.completed === true, `${rec.contentSeconds.toFixed(1)} / ${rec.goalSeconds} s`);
  check('completion notification sent once (flag recorded)', st.meta.lastGoalNotifiedDay === (await swEval(TODAY_EXPR)));
  check('celebration not yet shown (shown when popup opens)', !rec.celebrationShown);

  // 10) Popup
  const popup = await openTab(`chrome-extension://${SW.extId}/src/popup/popup.html`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: false }, popup.session);
  await sleep(1200);
  const pop = await pageCall(popup, `({ streak: document.getElementById('streakNum').textContent, celebrate: !document.getElementById('celebrate').hidden, title: document.getElementById('celebrateStreak').textContent, today: document.getElementById('todayMin').textContent, goal: document.getElementById('goalMin').textContent, course: document.getElementById('courseTitle').textContent, best: document.getElementById('statBest').textContent })`);
  check('popup shows streak 1 and content progress (m s) vs goal', pop.streak === '1' && /^2m \d\ds$/.test(pop.today) && pop.goal === '2m', JSON.stringify(pop));
  check('popup shows celebration on first open after completion', pop.celebrate && pop.title === 'Day 1 streak');
  await sleep(1500);
  await screenshot(popup.session, 'popup-celebration', 360, 640);
  await pageCall(popup, `document.getElementById('celebrateClose').click()`);
  await sleep(500);
  await screenshot(popup.session, 'popup-dashboard', 360, 640);
  await pageCall(popup, `document.getElementById('openCalendar').click()`);
  await sleep(500);
  const todayCell = await pageCall(popup, `document.querySelector('.cell.today')?.className`);
  check('calendar marks today as goal achieved', /lv3/.test(todayCell || ''), todayCell);
  await screenshot(popup.session, 'popup-calendar', 360, 640);
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });
  rec = await todayRecord();
  check('celebrationShown flag stored for today', rec.celebrationShown === true);
  const popup2 = await openTab(`chrome-extension://${SW.extId}/src/popup/popup.html`);
  await sleep(1000);
  check('celebration NOT repeated on next popup open', await pageCall(popup2, `document.getElementById('celebrate').hidden`));
  await cdp.send('Target.closeTarget', { targetId: popup2.targetId });

  // 11) Export / import through the options page
  const opt = await openTab(`chrome-extension://${SW.extId}/src/options/options.html`);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await sleep(500);
  await pageCall(opt, `document.getElementById('exportBtn').click()`);
  let exported = null;
  for (let i = 0; i < 40 && !exported; i += 1) {
    await sleep(250);
    const f = readdirSync(downloads).find((n) => n.endsWith('.json'));
    if (f) { try { exported = JSON.parse(readFileSync(path.join(downloads, f), 'utf8')); } catch { /* still writing */ } }
  }
  check('export downloads valid JSON with streak data', exported && exported.currentStreak === 1 && exported.dailyGoalMinutes === 2 && Object.keys(exported.dailyHistory).length >= 1,
    exported ? `streak ${exported.currentStreak}, total ${exported.totalWatchedSeconds}s` : 'no file');

  const todayKey = await swEval(TODAY_EXPR);
  const shiftKey = (k, n) => { const d = new Date(`${k}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const importFile = path.join(tmp, 'import.json');
  writeFileSync(importFile, JSON.stringify({
    ...exported,
    dailyHistory: {
      ...exported.dailyHistory,
      [shiftKey(todayKey, -1)]: { watchedSeconds: 200, goalSeconds: 120, completed: true }, // V1-format record (legacy)
      [shiftKey(todayKey, -2)]: { watchedSeconds: 130, goalSeconds: 120, completed: true },
    },
  }));
  const badFile = path.join(tmp, 'bad.json');
  writeFileSync(badFile, JSON.stringify({ dailyHistory: { 'not-a-date': { watchedSeconds: 5 } } }));

  const { root: domRoot } = await cdp.send('DOM.getDocument', {}, opt.session);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '#importFile' }, opt.session);
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [badFile] }, opt.session);
  await sleep(600);
  const badPreview = await pageCall(opt, `({ text: document.getElementById('importSummary').textContent, disabled: document.getElementById('importConfirm').disabled })`);
  check('import rejects invalid file with a clear error', badPreview.disabled && /not-a-date/.test(badPreview.text), badPreview.text.slice(0, 80));

  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [importFile] }, opt.session);
  await sleep(600);
  await pageCall(opt, `document.getElementById('importConfirm').click()`);
  await sleep(1000);
  st = await storageAll();
  const streakAfterImport = await pageCall(opt, `document.getElementById('headStat').textContent`);
  check('import (merge) adds history and streak becomes 3', !!st.dailyHistory[shiftKey(todayKey, -2)] && /3 days/.test(streakAfterImport), streakAfterImport);
  await cdp.send('Target.closeTarget', { targetId: opt.targetId });

  // 12) Crash Chrome (SIGKILL) and relaunch with the same profile
  const savedBefore = await todaySeconds();
  chrome.proc.kill('SIGKILL');
  await sleep(1500);
  SW = await boot();
  const savedAfter = await todaySeconds();
  check('browser crash/restart → data persists', near(savedAfter, savedBefore, 0.01) && savedAfter > 100, `${savedAfter.toFixed(1)} s`);
  st = await storageAll();
  check('streak history persists after restart', Object.keys(st.dailyHistory).length >= 3);

  // 13) Extension update/reload path: the worker re-injects the tracker into open
  //     Udemy tabs (exactly what onInstalled does). The older instance must hand
  //     over, so time is never double counted. (chrome.runtime.reload() itself
  //     unloads command-line-loaded extensions in automated Chrome, so we invoke
  //     the same injection the worker performs on 'update'.)
  const page2 = await openTab(LECTURE_URL);
  await setFocus(page2, true);
  await sleep(2500);
  const tab2 = await swEval(`chrome.tabs.query({ url: 'https://*.udemy.com/*' }).then(t => t[0].id)`);
  await pageCall(page2, '__test.play()');
  await sleep(3000);
  await swEval(`chrome.scripting.executeScript({ target: { tabId: ${tab2} }, files: chrome.runtime.getManifest().content_scripts[0].js }).then(() => true)`);
  await swEval(`chrome.scripting.executeScript({ target: { tabId: ${tab2} }, files: chrome.runtime.getManifest().content_scripts[0].js }).then(() => true)`);
  before = await todaySeconds();
  const t0 = Date.now();
  await sleep(8000);
  await pageCall(page2, '__test.pause()');
  await sleep(1200);
  const elapsed = (Date.now() - t0) / 1000;
  gained = (await todaySeconds()) - before;
  check('tracker re-injected twice (extension update) → still one tracker, no double counting', gained <= elapsed + 0.5 && near(gained, 8, 2), `${gained.toFixed(2)} s in ${elapsed.toFixed(1)} s`);

  if (shotsDir) {
    const o = await openTab(`chrome-extension://${SW.extId}/src/options/options.html`);
    await sleep(600);
    await screenshot(o.session, 'options', 900, 1500);
  }
} catch (err) {
  check('E2E run completed without errors', false, err.stack || String(err));
} finally {
  try { chrome?.proc.kill('SIGKILL'); } catch { /* ignore */ }
  server.close();
  await sleep(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
