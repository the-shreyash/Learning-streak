/** Popup controller: reads state, polls Udemy / YouTube tabs (incl. background ones) for live status. */
import { readState, onStateChange, sendToBackground } from '../shared/stateClient.js';
import { todayKeyFor } from '../core/clock.js';
import { learningSecondsOf, activeSecondsOf } from '../core/records.js';
import { renderDashboard } from './dashboard.js';
import { createCalendar } from './calendar.js';
import { showCelebration } from './celebration.js';
import { renderLearningStatus } from './learningStatus.js';
import '../content/activityRules.js'; // provides REASON_TEXT on globalThis.__UdemyStreak

const REASON_TEXT = globalThis.__UdemyStreak?.REASON_TEXT || {};
const SHORT_REASON = {
  'tracking': 'Tracking',
  'paused': 'Paused',
  'ended': 'Lecture ended',
  'buffering': 'Buffering',
  'frozen': 'Tab suspended',
  'locked': 'Screen locked',
  'no-video': 'No video found',
  'not-learn-page': 'Not on a lecture',
  // V2.1 (YouTube)
  'not-registered': 'Not registered',
  'disabled': 'Disabled',
  'checking': 'Checking…',
  'loading': 'Loading',
  'ad': 'Ad playing',
};
const TRACKED_URL_RE = /^https:\/\/(([a-z0-9-]+\.)*udemy\.com|www\.youtube\.com)\//i;
const TRACKED_TAB_PATTERNS = ['https://*.udemy.com/*', 'https://www.youtube.com/*'];

const $ = (id) => document.getElementById(id);
let state = null;
let live = null;           // latest tracker status from the most relevant Udemy tab
let view = 'dashboard';
let celebrating = false;
let displayed = { dayKey: null, learning: 0, active: 0 };

const todayKey = () => todayKeyFor(state);

/**
 * Today's learning (content + legacy) and actual watch seconds, stored + unsaved
 * live values. Never visibly ticks backwards mid-session.
 */
function todayLive() {
  const key = todayKey();
  const rec = state.dailyHistory[key];
  const learning = learningSecondsOf(rec) + (live?.unsavedContent || 0);
  const active = activeSecondsOf(rec) + (live?.unsavedActive || 0);
  if (displayed.dayKey !== key || learning < displayed.learning - 30 || active < displayed.active - 15) {
    displayed = { dayKey: key, learning, active };
  }
  displayed.learning = Math.max(displayed.learning, learning);
  displayed.active = Math.max(displayed.active, active);
  return { learning: displayed.learning, active: displayed.active };
}

const calendar = createCalendar({ getState: () => state, getTodayKey: todayKey, getTodayLive: todayLive });

function renderStatus() {
  const chip = $('status');
  let mode = 'idle';
  let text = 'Not on Udemy';
  let title = 'Open a Udemy lecture to start tracking';
  if (live) {
    mode = live.counting ? 'tracking' : 'paused';
    text = SHORT_REASON[live.reason] || 'Paused';
    title = REASON_TEXT[live.reason] || '';
    if (!live.onLearnPage) mode = 'idle';
    if (live.platform === 'youtube' && !live.onLearnPage) { text = 'Not on a video'; title = 'Open a YouTube video from your Learning Library to start tracking'; }
  }
  chip.dataset.state = mode;
  $('statusText').textContent = text;
  chip.title = title;
}

function maybeCelebrate(info) {
  const key = todayKey();
  const rec = state.dailyHistory[key];
  if (celebrating || !rec?.completed || rec.celebrationShown) return;
  celebrating = true;
  // Mark as shown immediately so closing the popup early never re-triggers it.
  sendToBackground({ type: 'ui:ackCelebration', dayKey: key }).catch(() => {});
  showCelebration({ goalSeconds: rec.goalSeconds, streak: info.streaks.current, onClose: () => {} });
}

function render() {
  if (!state) return;
  renderStatus();
  if (view === 'dashboard') {
    const info = renderDashboard(state, todayKey(), todayLive(), live);
    $('courseCard').hidden = renderLearningStatus(state, live);
    maybeCelebrate(info);
  } else {
    calendar.render();
  }
}

function setView(next) {
  view = next;
  $('viewDashboard').hidden = next !== 'dashboard';
  $('viewCalendar').hidden = next !== 'calendar';
  if (next === 'calendar') calendar.resetToToday();
  render();
}

const pingTab = (tab) => chrome.tabs.sendMessage(tab.id, { type: 'popup:ping' }).catch(() => null); // no tracker in that tab

/**
 * Live status from the most relevant tracked tab. Since V1.2 a lecture keeps
 * counting in a background tab, so look beyond the active tab: the active tab
 * if it's Udemy / YouTube, else any tracked tab that is counting, else one on a
 * lecture / video.
 */
async function pingTrackedTabs() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeLive = active?.id && TRACKED_URL_RE.test(active.url || '') ? await pingTab(active) : null;
    if (activeLive?.counting) { live = activeLive; return; }
    const others = (await chrome.tabs.query({ url: TRACKED_TAB_PATTERNS })).filter((t) => t.id !== active?.id && !t.discarded);
    const lives = (await Promise.all(others.map(pingTab))).filter(Boolean);
    live = lives.find((l) => l.counting) || activeLive || lives.find((l) => l.onLearnPage) || null;
  } catch {
    live = null;
  }
}

async function reload() {
  state = await readState();
  render();
}

async function init() {
  $('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openCalendar').addEventListener('click', () => setView('calendar'));
  $('openLibrary').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#library') }));
  $('calBack').addEventListener('click', () => setView('dashboard'));
  $('calPrev').addEventListener('click', () => calendar.step(-1));
  $('calNext').addEventListener('click', () => calendar.step(1));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('celebrate').hidden) { $('celebrate').hidden = true; return; }
    if (e.key === 'Escape' && view === 'calendar') { e.preventDefault(); setView('dashboard'); }
    if (view === 'calendar' && e.key === 'ArrowLeft') calendar.step(-1);
    if (view === 'calendar' && e.key === 'ArrowRight') calendar.step(1);
  });

  await Promise.all([reload(), pingTrackedTabs()]);
  render();
  onStateChange(reload);
  setInterval(async () => { await pingTrackedTabs(); render(); }, 1000);
}

init();
