/**
 * V1.1 browser test — playback-speed-aware tracking, in a real Chromium with the
 * real extension, against a mock Udemy lecture page playing a 60-minute video.
 *
 *   npm run test:speed                  # full-length scenarios (~20 min)
 *   SPEED_SCALE=0.2 npm run test:speed  # same scenarios, 5x shorter (quick check)
 *
 * Scenarios (full length):
 *   2× for 5 real min → ≈600 s content, ≈300 s actual; a 10-min goal completes
 *   1.5× for 4 real min → ≈360 s content       1× for 4 real min → ≈240 s content
 *   30 s, seek +5 min, 30 s → ≈60 s            30 s, seek back, 30 s → ≈60 s
 *   30 s, other tab 30 s, 30 s → ≈90 s (V1.2)  30 s, pause 30 s, 30 s → ≈60 s
 *   lecture switch at 2× (new <video>)         crash + restart keeps both metrics
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

const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-speed-'));
const profile = path.join(tmp, 'profile');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `  — ${detail}` : ''}`); };
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
async function boot() {
  chrome = await launchChrome({ executable, userDataDir: profile, extensionDir: path.join(root, 'extension'), hostRules: `MAP www.udemy.com 127.0.0.1:${port}`, headless: HEADLESS });
  cdp = chrome.cdp;
  SW = await findServiceWorker();
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

let page;
const call = (expr) => cdp.eval(page.session, expr);

/** Run fn, then report Δcontent, Δactual and Δvideo position. */
async function measure(fn) {
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
    record: r1,
  };
}
const fmt = (m) => `content ${m.content.toFixed(1)} s, actual ${m.active.toFixed(1)} s, video advanced ${m.video.toFixed(1)} s`;
const play = async (sec) => { await call('__test.play()'); await sleep(sec * 1000); };

try {
  console.log(`\nLearnStreak V1.1 — playback-speed browser test (scale ${SCALE})\n`);
  await boot();

  // Daily goal sits between the 2× scenario's actual time (5 min) and its content (10 min):
  // 7 min at full length. Only CONTENT can complete it; actual watch time alone cannot.
  const goalMin = Math.max(1, Math.floor((0.75 * S(600)) / 60));
  const opt = await openTab(`chrome-extension://${SW.extId}/src/options/options.html`);
  await sleep(600);
  await cdp.eval(opt.session, `(() => { document.getElementById('goalCustom').value = '${goalMin}'; document.getElementById('goalSave').click(); return true; })()`);
  await sleep(700);
  await cdp.send('Target.closeTarget', { targetId: opt.targetId });

  page = await openTab(LECTURE_URL);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(2500);
  const tabId = await swEval(`chrome.tabs.query({ url: 'https://*.udemy.com/*' }).then(t => t[0].id)`);
  const duration = await call(`document.querySelector('.player-zone video').duration`);
  check('mock lecture video is 60 minutes long', near(duration, 3600, 2), `${duration.toFixed(0)} s`);

  // ---- 2× for 5 real minutes (the reported bug)
  await call('__test.rate(2)');
  let pingRate = null;
  let m = await measure(async () => {
    await play(S(150));
    pingRate = await swEval(`chrome.tabs.sendMessage(${tabId}, { type: 'popup:ping' }).then(r => r.playbackRate)`);
    await sleep(S(150) * 1000);
  });
  check(`2× for ${S(300)} s real → content ≈${S(600)} s`, near(m.content, S(600), tol(S(600))), fmt(m));
  check(`2× → actual watch time ≈${S(300)} s (separate metric)`, near(m.active, S(300), tol(S(300))));
  check('2× → content matches how far the video actually advanced', near(m.content, m.video, tol(m.video)));
  check(`daily goal (${goalMin} min) completed by CONTENT; actual watch time alone would not have`, m.record.completed === true && (m.record.actualActiveSeconds < m.record.goalSeconds || SCALE < 0.5),
    `goal ${m.record.goalSeconds}s, content ${m.record.contentSeconds.toFixed(0)}s, actual ${m.record.actualActiveSeconds.toFixed(0)}s`);
  check('live tracker reports current speed 2× (shown in popup)', pingRate === 2, String(pingRate));

  // ---- 1.5× for 4 real minutes
  await call('__test.rate(1.5)');
  m = await measure(() => play(S(240)));
  check(`1.5× for ${S(240)} s real → content ≈${S(360)} s`, near(m.content, S(360), tol(S(360))) && near(m.active, S(240), tol(S(240))), fmt(m));

  // ---- 1× for 4 real minutes
  await call('__test.rate(1)');
  m = await measure(() => play(S(240)));
  check(`1× for ${S(240)} s real → content ≈${S(240)} s = actual`, near(m.content, S(240), tol(S(240))) && near(m.active, S(240), tol(S(240))), fmt(m));

  // ---- Seek forward 5 minutes between two watches
  m = await measure(async () => {
    await play(S(30));
    await call('__test.seekBy(300)');
    await sleep(S(30) * 1000);
  });
  check(`watch ${S(30)} s, seek +300 s, watch ${S(30)} s → content ≈${S(60)} s (not ${S(60) + 300})`, near(m.content, S(60), tol(S(60), 3)), fmt(m));

  // ---- Reverse seek
  m = await measure(async () => {
    await play(S(30));
    await call('__test.seekBy(-120)');
    await sleep(S(30) * 1000);
  });
  check(`watch ${S(30)} s, seek −120 s, watch ${S(30)} s → content ≈${S(60)} s, never negative`, near(m.content, S(60), tol(S(60), 3)) && m.content > 0, fmt(m));

  // ---- Tab switch while the video keeps playing
  let hidden = null; let playingHidden = null;
  m = await measure(async () => {
    await play(S(30));
    const other = await swEval(`chrome.tabs.create({ url: 'about:blank', active: true }).then(t => t.id)`);
    await sleep(500);
    hidden = await call('document.visibilityState');
    playingHidden = await call('!document.querySelector(".player-zone video").paused');
    await sleep(S(30) * 1000 - 500);
    await swEval(`chrome.tabs.update(${tabId}, { active: true }).then(() => chrome.tabs.remove(${other})).then(() => true)`);
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
    await sleep(S(30) * 1000);
  });
  check(`watch ${S(30)} s, other tab ${S(30)} s (video playing), watch ${S(30)} s → ≈${S(90)} s (V1.2: background playback counts)`,
    hidden === 'hidden' && playingHidden && near(m.content, S(90), tol(S(90), 3)), `${hidden}, ${fmt(m)}`);

  // ---- Pause
  m = await measure(async () => {
    await play(S(30));
    await call('__test.pause()');
    await sleep(S(30) * 1000);
    await play(S(30));
  });
  check(`watch ${S(30)} s, pause ${S(30)} s, watch ${S(30)} s → ≈${S(60)} s`, near(m.content, S(60), tol(S(60), 3)), fmt(m));

  // ---- Window focus lost while the video plays (V1.2: still counted)
  m = await measure(async () => {
    await play(S(30));
    const { targetId: win } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    await sleep(S(30) * 1000);
    await cdp.send('Target.closeTarget', { targetId: win });
    await cdp.send('Target.activateTarget', { targetId: page.targetId });
    await sleep(S(30) * 1000);
  });
  check(`window unfocused for ${S(30)} s (video playing) → still counted (≈${S(90)} s)`, near(m.content, S(90), tol(S(90), 3)), fmt(m));

  // ---- Lecture switch at 2× (SPA navigation, new <video>, far-apart positions)
  await call('__test.seekTo(2400)');
  await call('__test.rate(2)');
  await sleep(500);
  m = await measure(async () => {
    await play(S(20));
    await call('__test.nextLecture()'); // new element starts at 0:00 at 1×
    await sleep(S(20) * 1000);
  });
  check(`lecture switch: ${S(20)} s at 2× on lecture A (at 40:00) + ${S(20)} s at 1× on lecture B → ≈${S(60)} s, no 40-min jump`,
    near(m.content, S(60), tol(S(60), 3)), `content ${m.content.toFixed(1)} s, actual ${m.active.toFixed(1)} s`);

  // ---- Popup shows both metrics
  const totals = await today();
  const popup = await openTab(`chrome-extension://${SW.extId}/src/popup/popup.html`);
  await sleep(1200);
  const ui = await cdp.eval(popup.session, `({ content: document.getElementById('todayMin').textContent, actual: document.getElementById('activeToday').textContent, goal: document.getElementById('goalMin').textContent })`);
  const toMs = (s) => `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  check('popup: primary number = content consumed, secondary = actual watch time',
    ui.content === toMs(totals.contentSeconds) && ui.actual === toMs(totals.actualActiveSeconds) && totals.contentSeconds > totals.actualActiveSeconds,
    JSON.stringify(ui));
  await cdp.send('Target.closeTarget', { targetId: popup.targetId });

  // ---- Crash + restart keeps both metrics
  const saved = await today();
  chrome.proc.kill('SIGKILL');
  await sleep(1500);
  await boot();
  const after = await today();
  check('browser crash/restart → content and actual time persist',
    near(after.contentSeconds, saved.contentSeconds, 0.01) && near(after.actualActiveSeconds, saved.actualActiveSeconds, 0.01) && after.completed === true,
    `content ${after.contentSeconds.toFixed(1)} s, actual ${after.actualActiveSeconds.toFixed(1)} s`);
} catch (err) {
  check('speed test completed without errors', false, err.stack || String(err));
} finally {
  try { chrome?.proc.kill('SIGKILL'); } catch { /* ignore */ }
  server.close();
  await sleep(300);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
