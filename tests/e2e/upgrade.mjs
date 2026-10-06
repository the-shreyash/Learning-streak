/**
 * V1 → V1.1 upgrade in a real browser: V1-shaped data (watchedSeconds) already in
 * storage keeps its streak and calendar, and new watching adds content on top.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './cdp.mjs';
import { startMockUdemy } from './mockUdemy.mjs';

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.E2E_NO_XVFB && spawnSync('which', ['xvfb-run']).status === 0) {
  const r = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, E2E_NO_XVFB: '1' } });
  process.exit(r.status ?? 1);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-upgrade-'));
let failed = 0;
const check = (n, c, d = '') => { if (!c) failed += 1; console.log(`${c ? '  ✔' : '  ✘'} ${n}${d ? `  — ${d}` : ''}`); };
const { server, port } = await startMockUdemy({ videoPath: path.join(here, 'fixtures', 'lecture-av.webm'), certDir: path.join(tmp, 'cert') });
const { proc, cdp } = await launchChrome({ executable: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', userDataDir: path.join(tmp, 'p'), extensionDir: path.join(root, 'extension'), hostRules: `MAP www.udemy.com 127.0.0.1:${port}`, headless: !process.env.DISPLAY });
try {
  console.log('\nV1 → V1.1 upgrade\n');
  await sleep(1500);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const swInfo = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background/serviceWorker.js'));
  const extId = new URL(swInfo.url).host;
  const sw = await cdp.attach(swInfo.targetId);
  for (let i = 0; i < 40; i += 1) { if (await cdp.eval(sw, 'typeof chrome !== "undefined" && !!chrome.storage').catch(() => false)) break; await sleep(200); }
  const KEY = `(n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }`;
  // Exactly what V1.0 wrote:
  await cdp.eval(sw, `(async () => { const k = ${KEY}; await chrome.storage.local.clear(); await chrome.storage.local.set({
    schemaVersion: 1,
    settings: { dailyGoalMinutes: 10, notificationsEnabled: false, reminderEnabled: false, reminderTime: '20:00', requireWindowFocus: true },
    dailyHistory: {
      [k(-3)]: { watchedSeconds: 700, goalSeconds: 600, completed: true, celebrationShown: true },
      [k(-2)]: { watchedSeconds: 650, goalSeconds: 600, completed: true, celebrationShown: true },
      [k(-1)]: { watchedSeconds: 900, goalSeconds: 600, completed: true, celebrationShown: true },
      [k(0)]:  { watchedSeconds: 240, goalSeconds: 600, completed: false },
    },
    courses: { 'machine-learning-az': { title: 'Machine Learning A-Z', totalSeconds: 2490, lastWatchedAt: Date.now() } },
    meta: { longestStreak: 3, currentCourse: null, installedAt: Date.now(), creditedUntil: 0, lastGoalNotifiedDay: null },
    debug: { clockOffsetMs: 0 } }); return true; })()`);

  const { targetId: popId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup/popup.html` });
  const pop = await cdp.attach(popId);
  await sleep(1200);
  const ui = await cdp.eval(pop, `({ streak: document.getElementById('streakNum').textContent, today: document.getElementById('todayMin').textContent, actual: document.getElementById('activeToday').textContent, best: document.getElementById('statBest').textContent })`);
  check('V1 history keeps its streak (3) and best (3 days) after upgrade', ui.streak === '3' && ui.best === '3 days', JSON.stringify(ui));
  check("today's V1 minutes still count toward the goal (4m 00s)", ui.today === '4m 00s' && ui.actual === '4m 00s');
  await cdp.eval(pop, `document.getElementById('openCalendar').click(), true`);
  await sleep(400);
  const tip = await cdp.eval(pop, `[...document.querySelectorAll('.cell')].map(c => c.title).find(t => t.includes('V1 record')) || ''`);
  check('calendar marks V1 days as legacy records', tip.includes('V1 record (watch time, speed not tracked)'), tip);
  await cdp.send('Target.closeTarget', { targetId: popId });

  // Watch 2× for ~180 s of real time? Keep it short: 2× for 15 s → +30 s content on top of 240 legacy.
  const { targetId } = await cdp.send('Target.createTarget', { url: 'https://www.udemy.com/course/machine-learning-az/learn/lecture/7' });
  const page = await cdp.attach(targetId);
  await sleep(3000);
  await cdp.eval(page, '__test.rate(2)');
  await cdp.eval(page, '__test.play()');
  await sleep(15000);
  await cdp.eval(page, '__test.pause()');
  await sleep(1500);
  const st = await cdp.eval(sw, 'chrome.storage.local.get(null)');
  const k0 = await cdp.eval(sw, `(${KEY})(0)`);
  const k1 = await cdp.eval(sw, `(${KEY})(-1)`);
  const d = st.dailyHistory[k0];
  check('storage migrated to schema v2 on first write', st.schemaVersion === 2 && st.dailyHistory[k1].legacySeconds === 900 && st.dailyHistory[k1].watchedSeconds === undefined, JSON.stringify(st.dailyHistory[k1]));
  check('today: legacy 240 s kept + new content ≈30 s at 2× + actual ≈255 s', d.legacySeconds === 240 && Math.abs(d.contentSeconds - 30) < 2.5 && Math.abs(d.actualActiveSeconds - 255) < 2, JSON.stringify(d));
  check('course total: legacy kept, new content added', st.courses['machine-learning-az'].legacySeconds === 2490 && Math.abs(st.courses['machine-learning-az'].contentSeconds - 30) < 2.5, JSON.stringify(st.courses['machine-learning-az']));
} catch (e) {
  check('upgrade test ran without errors', false, e.stack);
} finally {
  proc.kill('SIGKILL'); server.close(); await sleep(300); rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} upgrade checks failed` : '\nUpgrade OK');
process.exit(failed ? 1 : 0);
