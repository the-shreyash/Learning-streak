/**
 * Verifies the developer simulation panel (+minutes, complete today, next day)
 * on a temporary copy of the extension with DEBUG_TOOLS = true.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, resolveChromeExecutable } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-debug-'));
const extCopy = path.join(tmp, 'extension');
cpSync(path.join(root, 'extension'), extCopy, { recursive: true });
const cfg = path.join(extCopy, 'src/config/config.js');
writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('DEBUG_TOOLS = false', 'DEBUG_TOOLS = true'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { proc, cdp } = await launchChrome({ executable: resolveChromeExecutable(), userDataDir: path.join(tmp, 'p'), extensionDir: extCopy, hostRules: 'MAP none 127.0.0.1' });
let failed = 0;
const check = (n, c, d = '') => { if (!c) failed += 1; console.log(`${c ? '  ✔' : '  ✘'} ${n}${d ? `  — ${d}` : ''}`); };
try {
  await sleep(1500);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const extId = new URL(targetInfos.find((t) => t.type === 'service_worker').url).host;
  const { targetId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
  const s = await cdp.attach(targetId);
  await sleep(1000);
  const click = async (action, minutes) => { await cdp.eval(s, `document.querySelector('[data-debug="${action}"]${minutes ? `[data-minutes="${minutes}"]` : ''}').click(), true`); await sleep(500); };
  const head = () => cdp.eval(s, `document.getElementById('headStat').textContent`);
  const clock = () => cdp.eval(s, `document.getElementById('debugClock').textContent`);
  check('debug panel visible when DEBUG_TOOLS = true', !(await cdp.eval(s, `document.getElementById('debugPanel').hidden`)));
  await click('addMinutes', 30); await click('addMinutes', 10);
  check('+30 +10 minutes → goal not complete, streak 0', /0 days/.test(await head()), await head());
  await click('addMinutes', 30);
  check('+30 more (70 min) → streak 1', /🔥 1 day/.test(await head()), await head());
  await click('nextDay');
  check('move to next day → streak still alive (1)', /🔥 1 day/.test(await head()), `${await head()} | ${await clock()}`);
  await click('addMinutes', 60);
  check('+60 on day 2 → streak 2', /🔥 2 days/.test(await head()), await head());
  await click('nextDay'); await click('nextDay');
  check('skip a whole day → streak broken (0), best stays 2', /🔥 0 days.*Best: 2 days/.test(await head()), await head());
  await click('completeToday');
  check('complete today → new streak 1', /🔥 1 day.*Best: 2 days/.test(await head()), await head());
  await click('nextDay');
  await cdp.eval(s, `document.querySelector('[data-debug="addMinutes"][data-rate="2"]').click(), true`); await sleep(500);
  const rec = await cdp.eval(s, `chrome.storage.local.get('dailyHistory').then(r => { const k = Object.keys(r.dailyHistory).sort().pop(); return r.dailyHistory[k]; })`);
  check('"+10 min content at 2×" → 600 s content, 300 s actual', rec.contentSeconds === 600 && rec.actualActiveSeconds === 300, JSON.stringify(rec));
  await click('resetClock');
  check('reset clock returns to real today', !/clock \+/.test(await clock()), await clock());
} finally {
  proc.kill('SIGKILL'); await sleep(300); rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} debug-tool checks failed` : '\nDebug tools OK');
process.exit(failed ? 1 : 0);
