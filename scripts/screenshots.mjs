/**
 * Dev tool: renders the popup and options page with realistic seeded data in
 * light and dark themes. Usage: node scripts/screenshots.mjs <outDir>
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../tests/e2e/cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'screenshots'));
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-shots-'));
const { proc, cdp } = await launchChrome({
  executable: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  userDataDir: tmp, extensionDir: path.join(root, 'extension'), hostRules: 'MAP none 127.0.0.1',
});

try {
  await sleep(1500);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const swInfo = targetInfos.find((t) => t.type === 'service_worker');
  const extId = new URL(swInfo.url).host;
  const sw = await cdp.attach(swInfo.targetId);
  for (let i = 0; i < 40; i += 1) { if (await cdp.eval(sw, 'typeof chrome !== "undefined" && !!chrome.storage').catch(() => false)) break; await sleep(200); }

  // Seed: 7-day streak ending yesterday, best 21, today 42/60 min, several courses.
  await cdp.eval(sw, `(async () => {
    const key = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const day = (n) => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + n); return key(d); };
    const h = {};
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 75; i >= 30; i--) { const r = rnd(); if (r < .25) continue; const m = r < .45 ? 10 + rnd()*19 : r < .6 ? 30 + rnd()*29 : 60 + rnd()*50; h[day(-i)] = { watchedSeconds: m*60, goalSeconds: 3600, completed: m >= 60, celebrationShown: true }; } // older days: V1 (legacy) records
    for (let i = 29; i >= 9; i--) { const c = (62 + rnd()*40)*60; h[day(-i)] = { contentSeconds: c, actualActiveSeconds: c / 1.5, goalSeconds: 3600, completed: true, celebrationShown: true }; }
    h[day(-8)] = { contentSeconds: 22*60, actualActiveSeconds: 22*60, goalSeconds: 3600, completed: false };
    for (let i = 7; i >= 1; i--) { const c = (61 + rnd()*45)*60; h[day(-i)] = { contentSeconds: c, actualActiveSeconds: c / 1.6, goalSeconds: 3600, completed: true, celebrationShown: true }; }
    h[day(0)] = { contentSeconds: 8*60 + 24, actualActiveSeconds: 4*60 + 12, goalSeconds: 3600, completed: false };
    await chrome.storage.local.set({
      dailyHistory: h,
      courses: {
        'machinelearning': { title: 'Machine Learning A-Z: AI, Python & R + ChatGPT Prize', totalSeconds: 18*3600 + 42*60, lastWatchedAt: Date.now() },
        'python-bootcamp': { title: '100 Days of Code: The Complete Python Pro Bootcamp', totalSeconds: 11*3600 + 8*60, lastWatchedAt: 1 },
        'react-the-complete-guide': { title: 'React - The Complete Guide (incl. Next.js, Redux)', totalSeconds: 7*3600 + 13*60, lastWatchedAt: 1 },
        'deep-learning': { title: 'Deep Learning A-Z: Hands-On Artificial Neural Networks', totalSeconds: 3*3600 + 2*60, lastWatchedAt: 1 },
      },
      meta: { longestStreak: 21, currentCourse: { key: 'machinelearning', title: 'Machine Learning A-Z: AI, Python & R + ChatGPT Prize', updatedAt: Date.now() }, installedAt: Date.now(), creditedUntil: 0, lastGoalNotifiedDay: null },
    });
    return true;
  })()`);

  async function shoot(url, name, width, height, scheme, after) {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    const s = await cdp.attach(targetId);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, s);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, s);
    await sleep(900);
    if (after) { await cdp.eval(s, after); await sleep(700); }
    const h = await cdp.eval(s, "Math.ceil(document.querySelector('.app')?.getBoundingClientRect().height || document.documentElement.scrollHeight)");
    const w = await cdp.eval(s, 'document.documentElement.scrollWidth');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: Math.min(Math.max(h, 200), height), deviceScaleFactor: 2, mobile: false }, s);
    await sleep(300);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, s);
    writeFileSync(path.join(out, `${name}-${scheme}.png`), Buffer.from(data, 'base64'));
    console.log(`${name}-${scheme}.png  content ${w}x${h}`);
    await cdp.send('Target.closeTarget', { targetId });
  }

  for (const scheme of ['dark', 'light']) {
    await shoot(`chrome-extension://${extId}/src/popup/popup.html`, 'popup-dashboard', 360, 600, scheme);
    await shoot(`chrome-extension://${extId}/src/popup/popup.html`, 'popup-calendar', 360, 600, scheme, `document.getElementById('openCalendar').click()`);
    await shoot(`chrome-extension://${extId}/src/options/options.html`, 'options', 900, 1700, scheme);
  }
  // Complete today → celebration
  await cdp.eval(sw, `chrome.storage.local.get('dailyHistory').then(({ dailyHistory: h }) => { const k = Object.keys(h).sort().pop(); h[k] = { ...h[k], contentSeconds: 3605, actualActiveSeconds: 1900, completed: true }; return chrome.storage.local.set({ dailyHistory: h }); }).then(() => true)`);
  await shoot(`chrome-extension://${extId}/src/popup/popup.html`, 'popup-celebration', 360, 600, 'dark');
  await shoot(`chrome-extension://${extId}/src/popup/popup.html`, 'popup-complete', 360, 600, 'dark');
} finally {
  proc.kill('SIGKILL');
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
