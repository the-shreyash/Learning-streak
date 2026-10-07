/**
 * V2.1 Phase B — YouTube single-video learning tracking in a real Chromium with
 * the real extension.
 *
 *   npm run test:youtube
 *
 * MOCKED FIXTURE: pages are served by tests/e2e/mockYouTube.mjs as
 * www.youtube.com (real URL shapes and 11-char video IDs, YouTube-like player
 * behaviour). The real site is NOT used here — see README "Manual verification".
 * A mock Udemy lecture runs alongside to prove Udemy is unaffected and that the
 * two never double count.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './cdp.mjs';
import { startMockUdemy } from './mockUdemy.mjs';
import { startMockYouTube } from './mockYouTube.mjs';

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.E2E_NO_XVFB && spawnSync('which', ['xvfb-run']).status === 0) {
  const r = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, E2E_NO_XVFB: '1' } });
  process.exit(r.status ?? 1);
}
const HEADLESS = !process.env.DISPLAY;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const executable = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-yt-'));
const videoPath = path.join(here, 'fixtures', 'lecture-60min.webm');

const A = 'aircAruvnKk'; // registered by the user in the test
const B = 'dQw4w9WgXcQ'; // never registered ("entertainment")
const TITLES = { [A]: 'But what is a neural network? | Deep learning chapter 1', [B]: 'Some music video' };

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `  — ${detail}` : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f = (n) => Number(n).toFixed(2);

const yt = await startMockYouTube({ videoPath, certDir: path.join(tmp, 'cert'), titles: TITLES });
const ud = await startMockUdemy({ videoPath, certDir: path.join(tmp, 'cert') });
const hostRules = `MAP www.youtube.com 127.0.0.1:${yt.port}, MAP www.udemy.com 127.0.0.1:${ud.port}`;
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
      await sleep(300);
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
const call = (p, e) => cdp.eval(p.session, e);
const TODAY = `(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })()`;
const today = () => swEval(`chrome.storage.local.get('dailyHistory').then(r => r.dailyHistory?.[${TODAY}] || {})`);
const storageAll = () => swEval('chrome.storage.local.get(null)');
const content = async () => (await today()).contentSeconds || 0;
const ytContent = async () => (await today()).platforms?.youtube?.contentSeconds || 0;

/** Δ content / actual / YouTube-attributed content over fn(), after a pause+flush. */
async function measure(page, fn) {
  const r0 = await today();
  await fn();
  await call(page, '__test.pause()');
  await sleep(1500);
  const r1 = await today();
  return {
    content: (r1.contentSeconds || 0) - (r0.contentSeconds || 0),
    active: (r1.actualActiveSeconds || 0) - (r0.actualActiveSeconds || 0),
    youtube: (r1.platforms?.youtube?.contentSeconds || 0) - (r0.platforms?.youtube?.contentSeconds || 0),
  };
}
const fmt = (m) => `content ${f(m.content)} s, actual ${f(m.active)} s, youtube ${f(m.youtube)} s`;
const play = async (page, sec) => { await call(page, '__test.play()'); await sleep(sec * 1000); };

async function popupStatus() {
  const pop = await openTab(`chrome-extension://${SW.extId}/src/popup/popup.html`);
  await sleep(1800);
  const ui = await call(pop, `({ shown: !document.getElementById('learnCard').hidden, state: document.getElementById('learnState').textContent,
    title: document.getElementById('learnTitle').textContent, metricsShown: !document.getElementById('learnMetrics').hidden,
    content: document.getElementById('learnContent').textContent, actual: document.getElementById('learnActual').textContent,
    hint: document.getElementById('learnHint').hidden ? '' : document.getElementById('learnHint').textContent,
    chip: document.getElementById('statusText').textContent, courseCardHidden: document.getElementById('courseCard').hidden })`);
  await cdp.send('Target.closeTarget', { targetId: pop.targetId });
  return ui;
}

try {
  console.log('\nLearnStreak V2.1 Phase B — YouTube (MOCKED FIXTURE www.youtube.com)\n');
  chrome = await launchChrome({ executable, userDataDir: path.join(tmp, 'profile'), extensionDir: path.join(root, 'extension'), hostRules, headless: HEADLESS });
  cdp = chrome.cdp;
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  SW = await findServiceWorker();
  check('extension loads; Learning Library starts empty', JSON.stringify((await storageAll()).library) === '{}');

  // ---- Unregistered before anything is registered
  let page = await openTab(`https://www.youtube.com/watch?v=${B}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(1500);
  let m = await measure(page, () => play(page, 8));
  check('1  unregistered video plays 8 s → zero time', m.content === 0 && m.active === 0, fmt(m));
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  // ---- Registration through the real options page UI
  const opt = await openTab(`chrome-extension://${SW.extId}/src/options/options.html#library`);
  await sleep(800);
  const submit = (url, title = '', subject = '') => call(opt, `(async () => {
    if (document.getElementById('libForm').hidden) document.getElementById('libAddOpen').click();
    document.getElementById('libUrl').value = ${JSON.stringify(url)};
    document.getElementById('libTitle').value = ${JSON.stringify(title)};
    document.getElementById('libSubject').value = ${JSON.stringify(subject)};
    document.getElementById('libForm').requestSubmit();
    await new Promise(r => setTimeout(r, 700));
    return { error: document.getElementById('libError').hidden ? '' : document.getElementById('libError').textContent, formOpen: !document.getElementById('libForm').hidden };
  })()`);
  let r = await submit('https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi');
  const r2 = await submit('https://example.com/watch?v=aircAruvnKk');
  check('registration: playlist / non-YouTube URLs rejected with a clear message, nothing stored',
    /single video/.test(r.error) && /Only YouTube/.test(r2.error) && JSON.stringify((await storageAll()).library) === '{}', `${r.error} | ${r2.error}`);
  r = await submit(`https://www.youtube.com/watch?v=${A}&list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi&index=1`, 'Neural networks', 'Deep Learning');
  let lib = (await storageAll()).library;
  const item = lib[`youtube:video:${A}`];
  check('registration: watch URL (with &list=) stores the single video, enabled', !r.error && !r.formOpen && Object.keys(lib).length === 1 && item?.targetId === A && item.type === 'video' && item.enabled === true && item.title === 'Neural networks' && item.subject === 'Deep Learning', JSON.stringify(item));
  r = await submit(`https://youtu.be/${A}?si=x`);
  check('registration: same video via youtu.be is refused as a duplicate', /already/.test(r.error) && Object.keys((await storageAll()).library).length === 1, r.error);
  await call(opt, `document.getElementById('libCancel').click(), true`);
  const listed = await call(opt, `[...document.querySelectorAll('.lib-item')].map(li => li.querySelector('.lib-text').textContent + ' | ' + li.querySelector('.lib-state').textContent)`);
  check('Learning Library list shows the entry (title, YouTube • Video, Enabled)', listed.length === 1 && /Neural networks/.test(listed[0]) && /YouTube • Video • Deep Learning/.test(listed[0]) && /Enabled/.test(listed[0]), listed.join(' / '));

  // ---- Registered video
  page = await openTab(`https://www.youtube.com/watch?v=${A}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(1500);
  const ytTabId = await swEval(`chrome.tabs.query({ url: 'https://www.youtube.com/*' }).then(t => t[0].id)`);
  m = await measure(page, () => play(page, 12));
  check('2  registered video plays 12 s → ≈12 s content, attributed to YouTube', near(m.content, 12, 1.6) && near(m.youtube, m.content, 0.01), fmt(m));
  let st = await storageAll();
  const sessions = Object.values(st.sessions);
  check('   LearningSession created for the video (platform youtube, library title + subject)', sessions.length === 1 && sessions[0].platform === 'youtube' && sessions[0].contentId === A && sessions[0].courseTitle === 'Neural networks' && sessions[0].subject === 'Deep Learning', JSON.stringify(sessions[0]));

  m = await measure(page, async () => { await sleep(6000); });
  check('3  paused for 6 s → time stops', m.content === 0 && m.active === 0, fmt(m));

  m = await measure(page, async () => { await play(page, 3); await call(page, '__test.seekBy(200)'); await sleep(3000); });
  check('4  seek +200 s mid-play → jump not counted (≈6 s)', near(m.content, 6, 2), fmt(m));

  await call(page, '__test.rate(2)');
  m = await measure(page, () => play(page, 10));
  check('5  2× for 10 s → ≈20 s content, ≈10 s actual', near(m.content, 20, 2.5) && near(m.active, 10, 1.6), fmt(m));
  await call(page, '__test.rate(1)');

  // ---- Background tab
  let vis = null;
  m = await measure(page, async () => {
    await play(page, 4);
    const other = await swEval(`chrome.tabs.create({ url: 'about:blank', active: true }).then(t => t.id)`);
    await sleep(500);
    vis = await call(page, '__test.state()');
    await sleep(7500);
    await swEval(`chrome.tabs.update(${ytTabId}, { active: true }).then(() => chrome.tabs.remove(${other})).then(() => true)`);
    await sleep(2000);
  });
  check('6  other Chrome tab active for 8 s (video playing) → counting continues (≈14 s)', vis.vis === 'hidden' && vis.paused === false && near(m.content, 14, 2.5), `${vis.vis}, ${fmt(m)}`);

  // ---- Another application (window minimised, another window focused)
  async function toOtherApp() {
    const { targetId: win } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    let windowId = null;
    try {
      ({ windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId }));
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } catch { /* not supported: focus change alone still applies */ }
    await sleep(500);
    return { win, windowId };
  }
  async function backFromApp({ win, windowId }) {
    if (windowId != null) { try { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } catch { /* ignore */ } }
    await cdp.send('Target.closeTarget', { targetId: win });
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
    await sleep(300);
  }
  let tracking = null;
  m = await measure(page, async () => {
    await play(page, 3);
    const app = await toOtherApp();
    vis = await call(page, '__test.state()');
    await sleep(4000);
    tracking = await swEval(`chrome.storage.session.get('trackingTabs').then(r => Object.keys(r.trackingTabs || {}).length)`);
    await sleep(4000);
    await backFromApp(app);
    await sleep(1000);
  });
  check('7  another application focused for 8 s (video playing) → counting continues (≈12 s), badge tracking', vis.focus === false && vis.paused === false && tracking === 1 && near(m.content, 12.5, 2.5), `hasFocus=${vis.focus}, ${fmt(m)}`);

  let pausedGain = null;
  m = await measure(page, async () => {
    await play(page, 4);
    const app = await toOtherApp();
    await sleep(3000);
    await call(page, '__test.pause()');
    await sleep(1500);
    const mid = await content();
    await sleep(6000);
    pausedGain = (await content()) - mid;
    await backFromApp(app);
  });
  check('8  paused while in the background → learning time stops', pausedGain === 0 && near(m.content, 7, 2), `gain while paused ${pausedGain}, ${fmt(m)}`);

  // ---- Screen lock (chrome.idle stubbed to "locked" + the worker's broadcast, as in run-background G)
  const setLock = (locked) => swEval(`(async () => {
    if (!globalThis.__realQueryState) globalThis.__realQueryState = chrome.idle.queryState.bind(chrome.idle);
    chrome.idle.queryState = ${locked} ? async () => 'locked' : globalThis.__realQueryState;
    await chrome.tabs.sendMessage(${ytTabId}, { type: 'system:lock', locked: ${locked} });
    return true;
  })()`);
  let lockedGain = null;
  m = await measure(page, async () => {
    await play(page, 4);
    await setLock(true);
    await sleep(1500);
    const mid = await content();
    await sleep(6000);
    lockedGain = (await content()) - mid;
    await setLock(false);
    await sleep(10000);
  });
  // Resume can lag the unlock by up to one lock poll (4 s, unchanged V1 behaviour) — same tolerance as run-background G.
  check('9  screen locked while playing → 0 counted while locked, resumes after unlock', lockedGain === 0 && m.content > 8 && m.content <= 14.5, `gain while locked ${lockedGain}, ${fmt(m)} (expected 4 s before + up to 10 s after unlock)`);

  // ---- Popup while learning
  await call(page, '__test.play()');
  await sleep(2500);
  let ui = await popupStatus();
  check('10 popup: "Learning · YouTube", library title, Content / Actual (m s)', ui.shown && ui.state === 'Learning' && ui.title === 'Neural networks' && ui.metricsShown && /^\d+m \d\ds$/.test(ui.content) && /^\d+m \d\ds$/.test(ui.actual) && ui.courseCardHidden && ui.chip === 'Tracking', JSON.stringify(ui));

  // ---- SPA: registered A → unregistered B while playing
  let afterNav = null;
  m = await measure(page, async () => {
    await sleep(3000);
    const before = await content();
    await call(page, `__test.navigate('${B}')`);
    await sleep(1500);
    const atNav = await content();
    await sleep(8000);
    afterNav = (await content()) - atNav;
    check('   (A counted right up to the navigation)', atNav - before > 2, `${f(atNav - before)} s`);
  });
  const stB = await call(page, '__test.state()');
  check('11 SPA navigation A (registered) → B (unregistered) while playing → tracking stops immediately', stB.id === B && afterNav === 0, `B playing for ≈8 s, gained ${afterNav}`);
  ui = await popupStatus();
  check('12 popup on the unregistered video: "Not registered as learning"', ui.shown && ui.state === 'Not registered as learning' && !ui.metricsShown && ui.chip === 'Not registered', JSON.stringify(ui));

  // ---- SPA: unregistered B → registered A
  m = await measure(page, async () => {
    await call(page, '__test.play()');
    await call(page, `__test.navigate('${A}')`);
    await sleep(10000);
  });
  check('13 SPA navigation B → A → tracking resumes with genuine playback (≈10 s)', near(m.content, 10, 2.5) && near(m.youtube, m.content, 0.01), fmt(m));

  // ---- Ad inside the registered video
  m = await measure(page, async () => { await call(page, '__test.ad(true)'); await play(page, 6); await call(page, '__test.ad(false)'); });
  check('14 ad playing (#movie_player.ad-showing) → not counted', m.content === 0, fmt(m));

  // ---- Disable / enable / delete through the options page, while playing
  const toggle = (on) => call(opt, `(() => { const t = document.querySelector('[data-lib-toggle="youtube:video:${A}"]'); if (t.checked !== ${on}) t.click(); return t.checked; })()`);
  m = await measure(page, async () => { await play(page, 3); await toggle(false); await sleep(1500); const mid = await content(); await sleep(5000); afterNav = (await content()) - mid; });
  check('15 disabled in the Learning Library while playing → stops', afterNav === 0 && (await storageAll()).library[`youtube:video:${A}`].enabled === false, `gain after disable ${afterNav}, ${fmt(m)}`);
  m = await measure(page, async () => { await toggle(true); await play(page, 6); });
  check('16 re-enabled → counts again (≈6 s)', near(m.content, 6, 2), fmt(m));
  // A person deletes from the visible options page (Chrome doesn't deliver a <dialog>'s
  // close event in a hidden tab, so the confirm dialog needs the tab in front).
  await cdp.send('Target.activateTarget', { targetId: opt.targetId });
  await sleep(300);
  await call(opt, `(() => { document.querySelector('[data-lib-delete="youtube:video:${A}"]').click(); return true; })()`);
  await sleep(300);
  await call(opt, `(() => { document.getElementById('confirmOk').click(); return true; })()`);
  await sleep(800);
  m = await measure(page, () => play(page, 6));
  lib = (await storageAll()).library;
  check('17 deleted from the library → no longer counts; earlier time kept', m.content === 0 && JSON.stringify(lib) === '{}' && (await ytContent()) > 40, `${fmt(m)}, youtube today ${f(await ytContent())} s, library ${JSON.stringify(Object.keys(lib))}`);

  // ---- Re-register; Udemy + YouTube at the same time never double count
  await submit(`https://youtu.be/${A}`);
  const udemy = await openTab('https://www.udemy.com/course/machine-learning-az/learn/lecture/101');
  await sleep(3000);
  const before = await today();
  const t0 = Date.now();
  await call(page, '__test.play()');
  await call(udemy, '__test.play()');
  await sleep(10000);
  await call(udemy, '__test.pause()');
  await call(page, '__test.pause()');
  await sleep(1500);
  const elapsed = (Date.now() - t0) / 1000;
  const after = await today();
  const gainedActive = after.actualActiveSeconds - before.actualActiveSeconds;
  const gainedUdemy = (after.platforms?.udemy?.contentSeconds || 0) - (before.platforms?.udemy?.contentSeconds || 0);
  const gainedYt = (after.platforms?.youtube?.contentSeconds || 0) - (before.platforms?.youtube?.contentSeconds || 0);
  check('18 Udemy lecture and YouTube video playing at once → one wall clock, no duplicate credit', gainedActive <= elapsed + 0.5 && near(gainedActive, 10, 2.5) && gainedUdemy + gainedYt <= elapsed + 0.5, `actual +${f(gainedActive)} s in ${f(elapsed)} s (udemy ${f(gainedUdemy)}, youtube ${f(gainedYt)})`);

  // ---- Udemy unaffected
  m = await measure(udemy, () => play(udemy, 8));
  st = await storageAll();
  check('19 Udemy still tracked automatically (≈8 s, course total unchanged in shape)', near(m.content, 8, 1.6) && m.youtube === 0 && st.courses['machine-learning-az']?.platform === undefined, fmt(m));

  // ---- Data integrity
  const rec = await today();
  const ytSessions = Object.values(st.sessions).filter((s) => s.platform === 'youtube');
  const sessionSum = ytSessions.reduce((a, s) => a + s.contentSeconds, 0);
  check('20 daily aggregation: platforms.youtube == Σ YouTube sessions; Udemy + YouTube == day total',
    near(rec.platforms.youtube.contentSeconds, sessionSum, 0.01) && near(rec.platforms.youtube.contentSeconds + rec.platforms.udemy.contentSeconds, rec.contentSeconds, 0.01),
    `youtube ${f(rec.platforms.youtube.contentSeconds)} (sessions ${f(sessionSum)}), udemy ${f(rec.platforms.udemy.contentSeconds)}, total ${f(rec.contentSeconds)}`);
  check('   no YouTube session or time for the unregistered video, ever', !ytSessions.some((s) => s.contentId === B) && !st.courses[`youtube:video:${B}`]);
} catch (err) {
  check('YouTube E2E completed without errors', false, err.stack || String(err));
} finally {
  try { chrome?.proc.kill('SIGKILL'); } catch { /* ignore */ }
  yt.server.close(); ud.server.close();
  await sleep(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
