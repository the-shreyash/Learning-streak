/**
 * V2.2 — Coursera lecture tracking in a real Chromium with the real extension.
 *
 *   npm run test:coursera
 *
 * MOCKED FIXTURE: pages are served by tests/e2e/mockCoursera.mjs as
 * www.coursera.org (real URL shapes and item ids; the player behaviour is an
 * ASSUMPTION — the signed-in Coursera player could not be inspected). The real
 * site is NOT used here — see README "Manual verification (Coursera)".
 * A mock Udemy lecture runs alongside to prove Udemy is unaffected and that the
 * two never double count.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, resolveChromeExecutable, resolveHeadless } from './cdp.mjs';
import { startMockUdemy } from './mockUdemy.mjs';
import { startMockCoursera } from './mockCoursera.mjs';

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.E2E_NO_XVFB && spawnSync('which', ['xvfb-run']).status === 0) {
  const r = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, E2E_NO_XVFB: '1' } });
  process.exit(r.status ?? 1);
}
const HEADLESS = resolveHeadless();
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const executable = resolveChromeExecutable();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-cs-'));
const videoPath = path.join(here, 'fixtures', 'lecture-60min.webm');

const COURSE = 'learning-how-to-learn';
const LANDING = `/learn/${COURSE}`;
const A = `/learn/${COURSE}/lecture/75EsZ/introduction-to-the-focused-and-diffuse-modes`;
const B = `/learn/${COURSE}/lecture/1bYD5/terrence-sejnowski-and-barbara-oakley-introduction-to-the-course-structure`;
const C = `/learn/${COURSE}/lecture/GVacn/using-the-focused-and-diffuse-modes-or-a-little-dali-will-do-you`;
const QUIZ = `/learn/${COURSE}/quiz/AbCdE/practice-quiz`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `  — ${detail}` : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f = (n) => Number(n).toFixed(2);

const cs = await startMockCoursera({ videoPath, certDir: path.join(tmp, 'cert') });
const ud = await startMockUdemy({ videoPath, certDir: path.join(tmp, 'cert') });
const hostRules = `MAP www.coursera.org 127.0.0.1:${cs.port}, MAP www.udemy.com 127.0.0.1:${ud.port}`;
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
const sessions = async () => Object.values((await storageAll()).sessions || {}).sort((a, b) => a.startedAt - b.startedAt);
const byLecture = async () => (await sessions()).filter((s) => s.platform === 'coursera').reduce((m, s) => ({ ...m, [s.lessonId]: (m[s.lessonId] || 0) + s.contentSeconds }), {});

/** Δ content / actual / Coursera-attributed content over fn(), after a pause+flush. */
async function measure(page, fn) {
  const r0 = await today();
  await fn();
  await call(page, '__test.pause()');
  await sleep(1500);
  const r1 = await today();
  return {
    content: (r1.contentSeconds || 0) - (r0.contentSeconds || 0),
    active: (r1.actualActiveSeconds || 0) - (r0.actualActiveSeconds || 0),
    coursera: (r1.platforms?.coursera?.contentSeconds || 0) - (r0.platforms?.coursera?.contentSeconds || 0),
  };
}
const fmt = (m) => `content ${f(m.content)} s, actual ${f(m.active)} s, coursera ${f(m.coursera)} s`;
const play = async (page, sec) => { await call(page, '__test.play()'); await sleep(sec * 1000); };
const ping = (tabId) => swEval(`chrome.tabs.sendMessage(${tabId}, { type: 'popup:ping' })`);

async function popupStatus() {
  const pop = await openTab(`chrome-extension://${SW.extId}/src/popup/popup.html`);
  await sleep(1800);
  const ui = await call(pop, `({ chip: document.getElementById('statusText').textContent, course: document.getElementById('courseTitle').textContent,
    label: document.getElementById('courseLabel').textContent, learnCardShown: !document.getElementById('learnCard').hidden })`);
  await cdp.send('Target.closeTarget', { targetId: pop.targetId });
  return ui;
}

try {
  console.log('\nLearningStreak V2.2 — Coursera (MOCKED FIXTURE www.coursera.org)\n');
  chrome = await launchChrome({ executable, userDataDir: path.join(tmp, 'profile'), extensionDir: path.join(root, 'extension'), hostRules, headless: HEADLESS });
  cdp = chrome.cdp;
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  SW = await findServiceWorker();
  check('extension loads with www.coursera.org host access', (await swEval(`chrome.runtime.getManifest().host_permissions`)).includes('https://www.coursera.org/*'));

  // ---- Course landing page: a promo video plays, nothing counts
  const page = await openTab(`https://www.coursera.org${LANDING}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(6000);
  const tabId = await swEval(`chrome.tabs.query({ url: 'https://www.coursera.org/*' }).then(t => t[0].id)`);
  let p = await ping(tabId);
  check('1  course landing page with a playing promo video → not a lecture, zero time', p.onLearnPage === false && p.reason === 'not-learn-page' && ((await today()).contentSeconds || 0) === 0, `${p.reason}`);

  // ---- Lecture A (SPA navigation from the landing page)
  await call(page, `__test.go(${JSON.stringify(A)})`);
  await sleep(1500);
  p = await ping(tabId);
  check('2  lecture page detected: course + lecture identity', p.onLearnPage && p.platform === 'coursera' && p.lecture?.id === '75EsZ' && p.course?.key === `coursera:course:${COURSE}`, JSON.stringify({ course: p.course, lecture: p.lecture }));
  let m = await measure(page, () => play(page, 12));
  check('3  lecture plays 12 s → ≈12 s content, attributed to Coursera', near(m.content, 12, 1.6) && near(m.coursera, m.content, 0.01), fmt(m));
  let ss = await sessions();
  check('   LearningSession for the lecture (platform coursera, course slug, item id)', ss.length === 1 && ss[0].platform === 'coursera' && ss[0].contentId === COURSE && ss[0].lessonId === '75EsZ', JSON.stringify(ss[0]));

  m = await measure(page, async () => { await sleep(6000); });
  check('4  paused for 6 s → time stops', m.content === 0 && m.active === 0, fmt(m));

  m = await measure(page, async () => { await play(page, 3); await call(page, '__test.seekBy(200)'); await sleep(3000); });
  check('5  seek +200 s mid-play → jump not counted (≈6 s)', near(m.content, 6, 2), fmt(m));

  await call(page, '__test.rate(2)');
  m = await measure(page, () => play(page, 10));
  check('6  2× for 10 s → ≈20 s content, ≈10 s actual', near(m.content, 20, 2.5) && near(m.active, 10, 1.6), fmt(m));
  await call(page, '__test.rate(1)');

  // ---- Background tab
  let vis = null;
  m = await measure(page, async () => {
    await play(page, 4);
    const other = await swEval(`chrome.tabs.create({ url: 'about:blank', active: true }).then(t => t.id)`);
    await sleep(500);
    vis = await call(page, '__test.state()');
    await sleep(7500);
    await swEval(`chrome.tabs.update(${tabId}, { active: true }).then(() => chrome.tabs.remove(${other})).then(() => true)`);
    await sleep(2000);
  });
  check('7  other tab active for 8 s (lecture playing) → counting continues (≈14 s)', vis.vis === 'hidden' && vis.paused === false && near(m.content, 14, 2.5), `${vis.vis}, ${fmt(m)}`);

  // ---- Popup
  await call(page, '__test.play()');
  await sleep(1500);
  const ui = await popupStatus();
  await call(page, '__test.pause()');
  await sleep(1500);
  check('8  popup: "Tracking" with the Coursera course as current course', ui.chip === 'Tracking' && ui.course === 'Learning How To Learn' && ui.label === 'Current course' && !ui.learnCardShown, JSON.stringify(ui));

  // ---- SPA navigation to lecture B while playing
  const before = await byLecture();
  await call(page, '__test.play()');
  await sleep(4000);
  await call(page, `__test.go(${JSON.stringify(B)}, { delayMs: 800 })`);
  await sleep(10000);
  await call(page, '__test.pause()');
  await sleep(1500);
  let after = await byLecture();
  const dA = (after['75EsZ'] || 0) - (before['75EsZ'] || 0);
  const dB = after['1bYD5'] || 0;
  check('9  "Next" (SPA) to lecture B: ≈4 s stay with A, ≈9 s go to B, nothing more', near(dA, 4, 1.6) && near(dB, 9, 2) && dA + dB <= 14.8 + 0.5, `A +${f(dA)} s, B ${f(dB)} s`);
  ss = (await sessions()).filter((s) => s.platform === 'coursera');
  check('   a new LearningSession for lecture B', ss.at(-1).lessonId === '1bYD5' && ss.filter((s) => s.lessonId === '1bYD5').length === 1, ss.map((s) => s.lessonId).join(','));

  // ---- The old lecture keeps playing under the new URL (stale player)
  const b0 = await byLecture();
  await call(page, '__test.play()');
  await sleep(2000);
  await call(page, `__test.go(${JSON.stringify(C)}, { delayMs: 6000, stale: true })`);
  await sleep(2500);
  p = await ping(tabId);
  await sleep(9500);
  await call(page, '__test.pause()');
  await sleep(1500);
  after = await byLecture();
  const sB = (after['1bYD5'] || 0) - (b0['1bYD5'] || 0);
  const sC = after.GVacn || 0;
  check('10 old lecture still playing 6 s after the route change → counted for neither; C counts once its own video plays', p.reason === 'loading' && near(sB, 2, 1.2) && near(sC, 6, 2), `reason during stale: ${p.reason}; B +${f(sB)} s, C ${f(sC)} s`);

  // ---- Leaving to a quiz (whose page has its own playing video)
  m = await measure(page, async () => {
    await call(page, `__test.go(${JSON.stringify(QUIZ)})`);
    await sleep(6000);
  });
  p = await ping(tabId);
  check('11 quiz page (a video plays there) → not a lecture, zero time', m.content === 0 && p.onLearnPage === false && p.reason === 'not-learn-page', `${fmt(m)}, ${p.reason}`);

  // ---- Udemy + Coursera together; Udemy unaffected
  await call(page, `__test.go(${JSON.stringify(A)})`);
  await sleep(1500);
  const udemy = await openTab('https://www.udemy.com/course/machine-learning-az/learn/lecture/101');
  await sleep(3000);
  const r0 = await today();
  const t0 = Date.now();
  await call(page, '__test.play()');
  await call(udemy, '__test.play()');
  await sleep(10000);
  await call(udemy, '__test.pause()');
  await call(page, '__test.pause()');
  await sleep(1500);
  const elapsed = (Date.now() - t0) / 1000;
  const r1 = await today();
  const gainedActive = r1.actualActiveSeconds - r0.actualActiveSeconds;
  const gU = (r1.platforms?.udemy?.contentSeconds || 0) - (r0.platforms?.udemy?.contentSeconds || 0);
  const gC = (r1.platforms?.coursera?.contentSeconds || 0) - (r0.platforms?.coursera?.contentSeconds || 0);
  check('12 Udemy lecture and Coursera lecture playing at once → one wall clock, no duplicate credit', gainedActive <= elapsed + 0.5 && near(gainedActive, 10, 2.5) && gU + gC <= elapsed + 0.5, `actual +${f(gainedActive)} s in ${f(elapsed)} s (udemy ${f(gU)}, coursera ${f(gC)})`);

  m = await measure(udemy, () => play(udemy, 8));
  const st = await storageAll();
  check('13 Udemy still tracked automatically (≈8 s, V1 course shape, nothing to Coursera)', near(m.content, 8, 1.6) && m.coursera === 0 && st.courses['machine-learning-az']?.platform === undefined, fmt(m));

  // ---- Data integrity
  const rec = await today();
  const csSessions = Object.values(st.sessions).filter((s) => s.platform === 'coursera');
  const sum = csSessions.reduce((a, s) => a + s.contentSeconds, 0);
  const course = st.courses[`coursera:course:${COURSE}`];
  check('14 daily aggregation: platforms.coursera == Σ Coursera sessions == course total; Udemy + Coursera == day total',
    near(rec.platforms.coursera.contentSeconds, sum, 0.01) && near(course.contentSeconds, sum, 0.01) && course.platform === 'coursera'
      && near(rec.platforms.coursera.contentSeconds + rec.platforms.udemy.contentSeconds, rec.contentSeconds, 0.01),
    `coursera ${f(rec.platforms.coursera.contentSeconds)} (sessions ${f(sum)}, course ${f(course.contentSeconds)}), udemy ${f(rec.platforms.udemy.contentSeconds)}, total ${f(rec.contentSeconds)}`);
  check('   nothing recorded for the quiz item or the course landing page', !csSessions.some((s) => !['75EsZ', '1bYD5', 'GVacn'].includes(s.lessonId)), csSessions.map((s) => s.lessonId).join(','));
} catch (err) {
  check('Coursera E2E completed without errors', false, err.stack || String(err));
} finally {
  try { chrome?.proc.kill('SIGKILL'); } catch { /* ignore */ }
  cs.server.close(); ud.server.close();
  await sleep(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
