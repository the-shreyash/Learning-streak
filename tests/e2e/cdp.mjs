/**
 * Minimal Chrome DevTools Protocol client (no Playwright), used so the browser
 * behaves exactly like a normal Chrome: real tab visibility and window focus
 * (Playwright's focus emulation keeps every page "visible + focused").
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CI_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// Per-platform executable inside a Playwright `chromium-<rev>` directory (newest layout first).
const PW_LAYOUTS = {
  darwin: [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['chrome-linux64/chrome', 'chrome-linux/chrome'],
  win32: ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'],
};

function playwrightCacheDirs() {
  const home = os.homedir();
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === 'darwin' && path.join(home, 'Library/Caches/ms-playwright'),
    process.platform === 'linux' && path.join(home, '.cache/ms-playwright'),
    process.platform === 'win32' && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ].filter(Boolean);
}

/**
 * Chromium binary for the E2E suites. Branded Google Chrome ignores
 * --load-extension, so only Chromium / Chrome for Testing will work.
 * Order: CHROME_PATH → CI path → newest Playwright-cached Chromium.
 */
export function resolveChromeExecutable() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CHROME_PATH does not exist: ${fromEnv}`);
    return fromEnv;
  }
  if (existsSync(CI_CHROME)) return CI_CHROME;
  const tried = [CI_CHROME];
  for (const dir of playwrightCacheDirs()) {
    let revs = [];
    try { revs = readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)); } catch { /* missing */ }
    revs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const rev of revs) {
      for (const rel of PW_LAYOUTS[process.platform] || []) {
        const candidate = path.join(dir, rev, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
    tried.push(`${dir}/chromium-*`);
  }
  throw new Error(
    'No Chromium found for the E2E tests. Searched:\n'
    + tried.map((t) => `  - ${t}`).join('\n')
    + '\nSet CHROME_PATH to a Chromium or Chrome for Testing binary (branded Google Chrome ignores --load-extension),'
    + '\nor install one with: npx playwright install chromium',
  );
}

/**
 * Browser mode for the E2E suites. HEADLESS=0|false → visible Chrome (needs a
 * real graphical session: a logged-in macOS desktop, or an X display on Linux);
 * HEADLESS=1|true → headless. Unset keeps the default: headless unless DISPLAY
 * is set (on Linux the suites re-run themselves under xvfb-run first).
 */
export function resolveHeadless() {
  const v = (process.env.HEADLESS || '').trim().toLowerCase();
  if (['0', 'false', 'no'].includes(v)) return false;
  if (['1', 'true', 'yes'].includes(v)) return true;
  if (v) throw new Error(`HEADLESS must be 0/1/true/false, got: ${process.env.HEADLESS}`);
  return !process.env.DISPLAY;
}

export class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
    // If the browser goes away, fail pending calls instead of hanging the suite.
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed (browser exited)'));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed (browser exited)'));
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  waitFor(pred, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error('waitFor timeout')); }, timeout);
      const off = this.on((m) => { if (pred(m)) { clearTimeout(t); off(); resolve(m); } });
    });
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }
  /** Evaluate an expression in a session; awaits promises; returns the value. */
  async eval(sessionId, expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export async function launchChrome({ executable, userDataDir, extensionDir, hostRules, headless = true, extraArgs = [] }) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    `--host-resolver-rules=${hostRules}`,
    '--ignore-certificate-errors',
    '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1280,800',
    '--no-sandbox',
    '--no-proxy-server', // test traffic must reach the local mock server directly
    // macOS: keep a visible Chrome for Testing from prompting for Keychain access.
    ...(process.platform === 'darwin' ? ['--use-mock-keychain', '--password-store=basic'] : []),
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`Chrome did not start:\n${buf}`)), 20000);
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('error', (err) => { clearTimeout(t); reject(new Error(`Could not launch Chrome at ${executable}: ${err.message}`)); });
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}):\n${buf}`)));
  });
  // Diagnostics: if Chrome exits without the harness killing it, say how (exit
  // code 0 = orderly quit, a signal = crash/kill) with its last stderr lines.
  let tail = [];
  proc.stderr.on('data', (d) => { tail = tail.concat(d.toString().split('\n').filter(Boolean)).slice(-40); });
  proc.on('exit', (code, signal) => {
    if (proc.killed) return;
    console.error(`\n  ⚠ Chrome exited unexpectedly at ${new Date().toISOString()} (code ${code}, signal ${signal})`);
    for (const line of tail) console.error(`      ${line.length > 240 ? `${line.slice(0, 240)}…` : line}`);
  });
  const cdp = await CDP.connect(wsUrl);
  return { proc, cdp };
}
