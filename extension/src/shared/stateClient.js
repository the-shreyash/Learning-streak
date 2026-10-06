/**
 * Read-only access to persisted state for UI pages, plus a tiny RPC helper to
 * ask the background worker (the single writer) to change things.
 */
import { migrate } from '../storage/migrationService.js';
import { STATE_KEYS } from '../storage/storageService.js';

export async function readState() {
  const raw = await chrome.storage.local.get(STATE_KEYS);
  return migrate(raw).state;
}

export function onStateChange(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && STATE_KEYS.some((k) => k in changes)) callback();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function sendToBackground(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (res && res.ok === false && res.error) throw new Error(res.error);
  return res;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, val); else node.style[prop] = val;
      }
    }
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
}
