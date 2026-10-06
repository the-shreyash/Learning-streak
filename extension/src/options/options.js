/** Options page controller. All writes go through the background worker. */
import { GOAL_PRESETS_MINUTES, DEBUG_TOOLS, MIN_GOAL_MINUTES, MAX_GOAL_MINUTES } from '../config/config.js';
import { readState, onStateChange, sendToBackground, el } from '../shared/stateClient.js';
import { computeStreaks } from '../core/streakEngine.js';
import { todayKeyFor, effectiveOffset } from '../core/clock.js';
import { pluralize } from '../core/format.js';
import { exportData, readImportFile, renderImportSummary, submitImport } from './importExport.js';

const $ = (id) => document.getElementById(id);
let state = null;
let pendingImport = null;

function toast(message, { error = false } = {}) {
  const t = $('toast');
  t.textContent = message;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function confirmDialog({ title, body, requireTyping = false, okLabel = 'Confirm' }) {
  const dlg = $('confirmDialog');
  $('confirmTitle').textContent = title;
  $('confirmBody').textContent = body;
  $('confirmOk').textContent = okLabel;
  $('confirmTypeWrap').hidden = !requireTyping;
  const input = $('confirmType');
  input.value = '';
  const ok = $('confirmOk');
  ok.disabled = requireTyping;
  input.oninput = () => { ok.disabled = input.value.trim().toUpperCase() !== 'RESET'; };
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.returnValue = 'cancel';
    dlg.showModal();
    (requireTyping ? input : ok).focus();
  });
}

async function saveSettings(patch, message = 'Saved') {
  try {
    await sendToBackground({ type: 'settings:update', patch });
    toast(message);
  } catch (e) {
    toast(`Couldn't save: ${e.message}`, { error: true });
  }
}

// ---------------------------------------------------------------------------
function renderGoal() {
  const goal = state.settings.dailyGoalMinutes;
  const chips = $('goalChips');
  const isPreset = GOAL_PRESETS_MINUTES.includes(goal);
  chips.replaceChildren(
    ...GOAL_PRESETS_MINUTES.map((m) => {
      const b = el('button', { class: 'chip', role: 'radio', 'aria-checked': String(goal === m), text: `${m} min` });
      b.addEventListener('click', () => saveSettings({ dailyGoalMinutes: m }, `Daily goal set to ${m} minutes`));
      return b;
    }),
    (() => {
      const b = el('button', { class: 'chip', role: 'radio', 'aria-checked': String(!isPreset), text: isPreset ? 'Custom' : `Custom · ${goal} min` });
      b.addEventListener('click', () => { $('goalCustom').focus(); $('goalCustom').select(); });
      return b;
    })(),
  );
  if (document.activeElement !== $('goalCustom')) $('goalCustom').value = String(goal);
}

function renderToggles() {
  const s = state.settings;
  $('notifEnabled').checked = s.notificationsEnabled;
  $('reminderEnabled').checked = s.reminderEnabled;
  $('reminderEnabled').disabled = !s.notificationsEnabled;
  $('reminderTime').value = s.reminderTime;
  $('reminderTime').disabled = !s.notificationsEnabled || !s.reminderEnabled;
}

function renderHeader() {
  const { current, longest } = computeStreaks(state.dailyHistory, todayKeyFor(state), state.meta.longestStreak);
  $('headStat').replaceChildren(el('b', { text: `🔥 ${pluralize(current, 'day')}` }), `Best: ${pluralize(longest, 'day')}`);
}

function renderDebug() {
  if (!DEBUG_TOOLS) return;
  $('debugPanel').hidden = false;
  const off = effectiveOffset(state);
  $('debugClock').textContent = `Simulated today: ${todayKeyFor(state)}${off ? ` (clock +${Math.round(off / 86_400_000)}d)` : ''}`;
}

function render() {
  renderGoal();
  renderToggles();
  renderHeader();
  renderDebug();
}

// ---------------------------------------------------------------------------
function bind() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  $('goalSave').addEventListener('click', () => {
    const v = Number($('goalCustom').value);
    if (!Number.isInteger(v) || v < MIN_GOAL_MINUTES || v > MAX_GOAL_MINUTES) {
      toast(`Enter a whole number between ${MIN_GOAL_MINUTES} and ${MAX_GOAL_MINUTES}.`, { error: true });
      return;
    }
    saveSettings({ dailyGoalMinutes: v }, `Daily goal set to ${v} minutes`);
  });
  $('goalCustom').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('goalSave').click(); });

  $('notifEnabled').addEventListener('change', (e) => saveSettings({ notificationsEnabled: e.target.checked }));
  $('reminderEnabled').addEventListener('change', (e) => saveSettings({ reminderEnabled: e.target.checked }, e.target.checked ? `Reminder set for ${$('reminderTime').value}` : 'Reminder off'));
  $('reminderTime').addEventListener('change', (e) => { if (e.target.value) saveSettings({ reminderTime: e.target.value }, `Reminder set for ${e.target.value}`); });

  $('exportBtn').addEventListener('click', async () => {
    try { await exportData(); toast('Exported your streak data'); } catch (e) { toast(`Export failed: ${e.message}`, { error: true }); }
  });
  $('importBtn').addEventListener('click', () => { $('importFile').value = ''; $('importFile').click(); });
  $('importFile').addEventListener('change', async (e) => {
    const result = await readImportFile(e.target.files[0]);
    pendingImport = result.ok ? result : null;
    renderImportSummary($('importSummary'), result);
    $('importPreview').hidden = false;
    $('importConfirm').disabled = !result.ok;
    document.querySelectorAll('input[name="importMode"]').forEach((r) => { r.disabled = !result.ok; });
  });
  $('importCancel').addEventListener('click', () => { pendingImport = null; $('importPreview').hidden = true; });
  $('importConfirm').addEventListener('click', async () => {
    if (!pendingImport) return;
    const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'merge';
    if (mode === 'replace') {
      const ok = await confirmDialog({ title: 'Replace all data?', body: 'Your current history, streaks and settings will be overwritten by the file. Consider exporting a backup first.', okLabel: 'Replace' });
      if (!ok) return;
    }
    try {
      const res = await submitImport(pendingImport.text, mode);
      if (!res?.ok) throw new Error((res?.errors || ['Import failed']).join(' '));
      toast(`Imported ${res.summary.days} days`);
      pendingImport = null;
      $('importPreview').hidden = true;
    } catch (e) {
      toast(e.message, { error: true });
    }
  });

  $('resetBtn').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset all statistics?',
      body: 'This permanently deletes your streaks, daily history and course totals. Your settings are kept. This cannot be undone — export a backup first if unsure.',
      requireTyping: true,
      okLabel: 'Reset statistics',
    });
    if (!ok) return;
    try { await sendToBackground({ type: 'data:reset' }); toast('Statistics reset'); } catch (e) { toast(e.message, { error: true }); }
  });

  if (DEBUG_TOOLS) {
    document.querySelectorAll('[data-debug]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const res = await sendToBackground({ type: 'debug:action', action: b.dataset.debug, minutes: Number(b.dataset.minutes) || 0, rate: Number(b.dataset.rate) || 1 });
        toast(`${b.textContent.trim()} ✓ (today = ${res.todayKey})`);
      } catch (e) { toast(e.message, { error: true }); }
    }));
  }
}

async function reload() {
  state = await readState();
  render();
}

bind();
reload();
onStateChange(reload);
