/**
 * V2.1 — live status card for opt-in platforms (YouTube): is the video in the
 * Learning Library, and what has this learning session counted so far.
 */
import { formatMinSec } from '../core/format.js';
import { nowFor } from '../core/clock.js';
import { SESSION_GAP_MS } from '../core/learningEngine.js';

const $ = (id) => document.getElementById(id);

/** The video's still-open LearningSession (same rule the engine uses to continue one), or null. */
function openSessionFor(state, platform, contentId) {
  let best = null;
  for (const s of Object.values(state.sessions || {})) {
    if (s.platform === platform && s.contentId === contentId && (!best || s.endedAt > best.endedAt)) best = s;
  }
  return best && nowFor(state) - best.endedAt <= SESSION_GAP_MS ? best : null;
}

const STATE_TEXT = {
  'paused': 'Paused', 'ended': 'Ended', 'buffering': 'Buffering', 'loading': 'Loading', 'ad': 'Ad playing',
  'locked': 'Screen locked', 'frozen': 'Tab suspended', 'no-video': 'Waiting for the video', 'checking': 'Checking…',
};

const UNREGISTERED = {
  'not-registered': ['Not registered as learning', 'Only videos in your Learning Library — or in a playlist you added — count.'],
  'disabled': ['Disabled in Learning Library', 'Enable it in the Learning Library to count it.'],
  'not-in-playlist': ['Not in your registered playlist', 'YouTube doesn\'t list this video in that playlist, so it isn\'t counted.'],
  'playlist-unverified': ['Playlist membership not confirmed', 'Only videos YouTube shows as part of your registered playlist count.'],
};

/**
 * @returns {boolean} whether the card is shown (it replaces the course card)
 */
export function renderLearningStatus(state, live) {
  const card = $('learnCard');
  const show = live?.platform === 'youtube' && !!live.video;
  card.hidden = !show;
  if (!show) return false;

  const { id, title } = live.video;
  const registered = live.registration === 'registered';
  card.dataset.state = live.counting ? 'learning' : registered ? 'registered' : 'unregistered';
  $('learnTitle').textContent = title || `YouTube video ${id}`;
  $('learnTitle').title = $('learnTitle').textContent;

  const unregistered = UNREGISTERED[live.registration];
  let heading;
  if (live.counting) heading = live.via === 'playlist' ? 'Learning · via playlist' : 'Learning';
  else if (unregistered) heading = unregistered[0];
  else heading = STATE_TEXT[live.reason] || 'Paused';
  $('learnState').textContent = heading;

  const metrics = $('learnMetrics');
  const hint = $('learnHint');
  metrics.hidden = !registered;
  hint.hidden = registered;
  if (registered) {
    // Sessions are per video (contentId), whether it counts directly or through a playlist.
    const session = openSessionFor(state, 'youtube', id);
    $('learnContent').textContent = formatMinSec((session?.contentSeconds || 0) + (live.unsavedContent || 0));
    $('learnActual').textContent = formatMinSec((session?.actualActiveSeconds || 0) + (live.unsavedActive || 0));
  } else {
    hint.textContent = unregistered ? unregistered[1] : 'Only videos in your Learning Library count.';
  }
  return true;
}
