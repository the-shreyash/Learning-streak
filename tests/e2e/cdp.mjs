/**
 * Minimal Chrome DevTools Protocol client (no Playwright), used so the browser
 * behaves exactly like a normal Chrome: real tab visibility and window focus
 * (Playwright's focus emulation keeps every page "visible + focused").
 */
import { spawn } from 'node:child_process';

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
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
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
    proc.on('exit', (code) => reject(new Error(`Chrome exited (${code}):\n${buf}`)));
  });
  const cdp = await CDP.connect(wsUrl);
  return { proc, cdp };
}
