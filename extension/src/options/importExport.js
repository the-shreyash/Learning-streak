/** Export (download JSON) and import (file → validated preview → background). */
import { buildExport, validateImport, MAX_IMPORT_BYTES } from '../core/dataTransfer.js';
import { todayKeyFor, nowFor } from '../core/clock.js';
import { formatDuration } from '../core/format.js';
import { readState, sendToBackground, el } from '../shared/stateClient.js';

export async function exportData() {
  const state = await readState();
  const data = buildExport(state, todayKeyFor(state), nowFor(state));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `udemy-streak-${todayKeyFor(state)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return data;
}

export async function readImportFile(file) {
  if (!file) return { ok: false, errors: ['No file selected.'] };
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, errors: ['File is too large (max 5 MB).'] };
  const text = await file.text();
  return { ...validateImport(text), text };
}

export function renderImportSummary(container, result) {
  container.replaceChildren();
  if (!result.ok) {
    container.append(el('b', { class: 'err', text: 'This file can\'t be imported:' }),
      el('ul', {}, ...result.errors.map((e) => el('li', { class: 'err', text: e }))));
    return;
  }
  const s = result.summary;
  container.append(
    el('div', {}, el('b', { text: `${s.days} days` }), ` of history (${s.firstDay || '—'} → ${s.lastDay || '—'}), `,
      el('b', { text: `${s.completedDays} goal days` }), ', ', el('b', { text: formatDuration(s.totalSeconds) }), ' total',
      s.courses ? `, ${s.courses} courses.` : '.'),
  );
  if (s.legacyDays) container.append(el('div', { text: `${s.legacyDays} of these days were recorded by V1 as watch time (playback speed wasn't tracked then); they're kept as-is.` }));
  if (result.warnings?.length) container.append(el('ul', {}, ...result.warnings.map((w) => el('li', { text: w }))));
}

export function submitImport(text, mode) {
  return sendToBackground({ type: 'data:import', payload: text, mode });
}
