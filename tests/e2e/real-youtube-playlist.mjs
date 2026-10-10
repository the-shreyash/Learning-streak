/**
 * V2.1 Phase C — playlist tracking against the REAL www.youtube.com (manual run).
 *
 *   CHROME_PATH=".../Google Chrome for Testing" npm run test:youtube:real
 *
 * NOT part of `npm test` / CI: it needs the network and depends on YouTube
 * (ads, layout, availability). The EXTENSION still makes no requests — only the
 * browser loads youtube.com, as it would for the user. The test drives the page
 * (play / click a playlist item) like a user would; the extension only observes.
 *
 * Playlists used (public): 3Blue1Brown "Neural networks" (10 videos) and
 * freeCodeCamp's uploads (2,000+ videos, the panel loads a window of ~100).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const executable = process.env.CHROME_PATH;
if (!executable) { console.error('Set CHROME_PATH to Chrome for Testing / Chromium (branded Chrome ignores --load-extension).'); process.exit(2); }
const HEADLESS = process.env.HEADFUL ? false : true;
const PLAY_S = Number(process.env.PLAY_S) || 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'streak-real-yt-'));

const P = 'PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi';
const P_ITEMS = ['aircAruvnKk', 'IHZwWFHWa-w', 'Ilg3gGewQ5U', 'tIeHLnjs5U8'];
const UPLOADS = 'UU8butISFwT-Wl7EV0hUK0BQ';
const UPLOADS_500 = 'oYMUKagK0n8';   // item #500 of the uploads list (2026-10-07)
const X = 'dQw4w9WgXcQ';             // unrelated

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `  — ${detail}` : ''}`); };
const f = (n) => Number(n).toFixed(1);
let chrome; let cdp; let SW;

async function findServiceWorker() {
  for (let t = 0; t < 60; t += 1) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find((x) => x.type === 'service_worker' && x.url.endsWith('/src/background/serviceWorker.js'));
    if (sw) {
      const session = await cdp.attach(sw.targetId);
      for (let i = 0; i < 40; i += 1) {
        try { if (await cdp.eval(session, `typeof chrome !== 'undefined' && !!chrome.storage`)) break; } catch { /* starting */ }
        await sleep(250);
      }
      return { session, extId: new URL(sw.url).host };
    }
    await sleep(250);
  }
  throw new Error('service worker not found');
}
async function openTab(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const session = await cdp.attach(targetId);
  for (let i = 0; i < 120; i += 1) {
    try { if ((await cdp.eval(session, 'document.readyState')) === 'complete') break; } catch { /* navigating */ }
    await sleep(250);
  }
  return { targetId, session };
}
const swEval = (e) => cdp.eval(SW.session, e);
const call = (p, e) => cdp.eval(p.session, e);
const TODAY = `(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })()`;
const ytContent = async () => (await swEval(`chrome.storage.local.get('dailyHistory').then(r => r.dailyHistory?.[${TODAY}]?.platforms?.youtube?.contentSeconds || 0)`));
const sessions = () => swEval(`chrome.storage.local.get('sessions').then(r => Object.values(r.sessions || {}))`);
const members = (list) => swEval(`chrome.storage.local.get('playlistMembership').then(r => r.playlistMembership?.[${JSON.stringify(list)}]?.videoIds || [])`);
/** The tracker's own live view of the tab (what the popup shows). */
const ping = (tabId) => swEval(`chrome.tabs.sendMessage(${tabId}, { type: 'popup:ping' })`);
const tabIdOf = async () => swEval(`chrome.tabs.query({ url: 'https://www.youtube.com/*' }).then(t => t.map(x => ({ id: x.id, url: x.url })))`);

const PAGE = {
  state: `(() => { const v = document.querySelector('video.html5-main-video'); const u = new URL(location.href);
    return { v: u.searchParams.get('v'), list: u.searchParams.get('list'), t: v ? v.currentTime : null, paused: v ? v.paused : null,
      ad: !!document.querySelector('#movie_player.ad-showing'), consent: location.hostname !== 'www.youtube.com' }; })()`,
  play: `(async () => { const v = document.querySelector('video.html5-main-video'); v.muted = true; await v.play().catch(() => {}); return !v.paused; })()`,
  pause: `(() => { document.querySelector('video.html5-main-video')?.pause(); return true; })()`,
  skipAd: `(() => { const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button'); if (b) b.click(); return !!b; })()`,
  clickPanelItem: (v) => `(() => { const a = [...document.querySelectorAll('ytd-playlist-panel-renderer#playlist ytd-playlist-panel-video-renderer a#wc-endpoint')].find(a => new URL(a.href).searchParams.get('v') === ${JSON.stringify(v)}); if (!a) return false; a.click(); return true; })()`,
  clickUnrelated: `(() => { const inPanel = new Set([...document.querySelectorAll('ytd-playlist-panel-video-renderer a#wc-endpoint')].map(a => new URL(a.href).searchParams.get('v')));
    const a = [...document.querySelectorAll('#secondary a[href^="/watch?v="]')].find(a => !a.closest('ytd-playlist-panel-renderer') && !inPanel.has(new URL(a.href).searchParams.get('v')) && !new URL(a.href).searchParams.has('list'));
    if (!a) return null; const v = new URL(a.href).searchParams.get('v'); a.click(); return v; })()`,
};

async function waitNoAd(page, maxMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = await call(page, PAGE.state);
    if (s.consent) throw new Error('YouTube showed a consent page; run with HEADFUL=1 and accept it, or use a region without it');
    if (!s.ad) return true;
    await call(page, PAGE.play);
    await call(page, PAGE.skipAd);
    await sleep(1000);
  }
  return false;
}
/** Play for `sec` (ads skipped/waited out first), pause, flush; Δ YouTube content. */
/**
 * Keep the page playing until `sec` seconds of NON-ad playback have been sampled
 * (YouTube may start an ad at any moment; ad time is correctly never counted).
 * The page is NOT paused here. Returns the samples: tracker reason + page state.
 */
async function playSampled(page, sec = PLAY_S, maxMs = 150_000) {
  const samples = [];
  let watched = 0;
  const t0 = Date.now();
  await call(page, PAGE.play);
  while (watched < sec && Date.now() - t0 < maxMs) {
    await sleep(2000);
    const tabs = await tabIdOf().catch(() => []);
    const live = tabs[0] ? await ping(tabs[0].id).catch(() => null) : null;
    const st = await call(page, PAGE.state);
    if (st.ad) { await call(page, PAGE.skipAd); await call(page, PAGE.play); } else if (!st.paused) watched += 2;
    samples.push({ reason: live?.reason, ad: st.ad, paused: st.paused, t: st.t });
  }
  if (process.env.TRACE) console.log(`      trace: ${samples.map((x) => `${x.reason}${x.ad ? '/AD' : ''}${x.paused ? '/paused' : ''}@${f(x.t)}`).join(' ')}`);
  return { samples, watched, ads: samples.filter((x) => x.ad).length };
}
/** Δ YouTube content for ≈`sec` s of non-ad playback (then pause + flush). */
async function playAndMeasure(page, sec = PLAY_S) {
  await waitNoAd(page);
  const before = await ytContent();
  const run = await playSampled(page, sec);
  await call(page, PAGE.pause);
  await sleep(2500);
  lastRun = run;
  return (await ytContent()) - before;
}
let lastRun = null;
const adNote = () => (lastRun?.ads ? ` (${lastRun.ads} ad sample(s) excluded)` : '');
async function waitForUrl(page, v, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await call(page, PAGE.state)).v === v) return true; await sleep(250); }
  return false;
}

try {
  console.log('\nLearningStreak V2.1 Phase C — REAL www.youtube.com playlist tracking\n');
  chrome = await launchChrome({ executable, userDataDir: path.join(tmp, 'profile'), extensionDir: path.join(root, 'extension'), hostRules: 'MAP unused.invalid 127.0.0.1', headless: HEADLESS, extraArgs: ['--mute-audio'] });
  cdp = chrome.cdp;
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  SW = await findServiceWorker();

  // ---- Register the playlist through the real options page
  const opt = await openTab(`chrome-extension://${SW.extId}/src/options/options.html#library`);
  await sleep(800);
  const submit = (url, title = '') => call(opt, `(async () => {
    if (document.getElementById('libForm').hidden) document.getElementById('libAddOpen').click();
    document.getElementById('libUrl').value = ${JSON.stringify(url)};
    document.getElementById('libTitle').value = ${JSON.stringify(title)};
    document.getElementById('libSubject').value = '';
    document.getElementById('libForm').requestSubmit();
    await new Promise(r => setTimeout(r, 700));
    return { error: document.getElementById('libError').hidden ? '' : document.getElementById('libError').textContent };
  })()`);
  const reg = await submit(`https://www.youtube.com/playlist?list=${P}`, 'Neural networks course');
  const lib = await swEval(`chrome.storage.local.get('library').then(r => r.library)`);
  check('register real playlist (options page)', !reg.error && lib[`youtube:playlist:${P}`]?.type === 'playlist' && Object.keys(lib).length === 1, reg.error || Object.keys(lib).join(','));
  const listed = await call(opt, `[...document.querySelectorAll('.lib-item')].map(li => li.querySelector('.lib-text').textContent).join(' / ')`);
  check('   Library lists it as "YouTube • Playlist"', /Neural networks course/.test(listed) && /YouTube • Playlist/.test(listed), listed);

  // ---- TEST 1: genuine member
  let page = await openTab(`https://www.youtube.com/watch?v=${P_ITEMS[2]}&list=${P}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(3000);
  let [tab] = await tabIdOf();
  let gain = await playAndMeasure(page);
  let live = await ping(tab.id);
  let ss = await sessions();
  let sx = ss.find((s) => s.contentId === P_ITEMS[2]);
  check(`TEST 1  genuine playlist member plays ${PLAY_S} s → TRACK`, gain >= PLAY_S * 0.6, `youtube +${f(gain)} s${adNote()}`);
  check('        session = the VIDEO (contentType video, contentId = video), playlist attributed', !!sx && sx.contentType === 'video' && sx.playlistId === P && sx.playlistTitle === 'Neural networks course', JSON.stringify(sx));
  const panelIds = await call(page, `[...document.querySelectorAll('ytd-playlist-panel-renderer#playlist ytd-playlist-panel-video-renderer a#wc-endpoint')].map(a => new URL(a.href).searchParams.get('v'))`);
  let known = await members(P);
  check('        membership persisted = exactly the items YouTube rendered in P\'s panel', known.length > 0 && known.length === panelIds.length && panelIds.every((v) => known.includes(v)) && P_ITEMS.every((v) => known.includes(v)), `${known.length} stored, ${panelIds.length} rendered`);

  // ---- TEST 3: move to the next playlist video (SPA, panel click)
  const clicked = await call(page, PAGE.clickPanelItem(P_ITEMS[3]));
  await waitForUrl(page, P_ITEMS[3]);
  await sleep(1500);
  gain = await playAndMeasure(page);
  ss = await sessions();
  check('TEST 3  SPA to the next video of the playlist → TRACK (re-verified)', clicked && gain >= PLAY_S * 0.6 && ss.some((s) => s.contentId === P_ITEMS[3] && s.playlistId === P), `youtube +${f(gain)} s, sessions ${ss.map((s) => s.contentId).join(',')}${adNote()}`);

  // ---- back to the previous one (A → B → A)
  await call(page, PAGE.clickPanelItem(P_ITEMS[2]));
  await waitForUrl(page, P_ITEMS[2]);
  await sleep(1500);
  gain = await playAndMeasure(page, 10);
  check('        … and back to the previous video → TRACK', gain >= 6, `youtube +${f(gain)} s`);

  // ---- TEST 4: leave the playlist for an unrelated recommendation
  const unrelated = await call(page, PAGE.clickUnrelated);
  if (unrelated) await waitForUrl(page, unrelated);
  await sleep(3000);
  const before4 = await ytContent();
  gain = await playAndMeasure(page);
  live = await ping(tab.id);
  const st4 = await call(page, PAGE.state);
  check('TEST 4  leave the playlist for an unrelated video → STOP', !!unrelated && gain === 0, `opened ${unrelated} (list=${st4.list ? 'yes' : 'no'}), youtube +${f(gain)} s, reason ${live?.reason}, total ${f(before4)} s`);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  // ---- TEST 2: unrelated video opened with ?list=<registered playlist>
  page = await openTab(`https://www.youtube.com/watch?v=${X}&list=${P}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(4000);
  [tab] = await tabIdOf();
  gain = await playAndMeasure(page);
  live = await ping(tab.id);
  const panelShown = await call(page, `!!document.querySelector('ytd-playlist-panel-renderer#playlist:not([hidden])')`);
  check('TEST 2  UNRELATED video opened with ?list=<registered playlist> → DO NOT TRACK', gain === 0 && live?.counting === false, `panel shown ${panelShown}, youtube +${f(gain)} s, reason ${live?.reason}`);
  check('        not a single credit for it in the data', !(await sessions()).some((s) => s.contentId === X));
  check('        and it was NOT added to the playlist\'s proven members', !(await members(P)).includes(X));
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  // ---- TEST 5: KNOWN member (proven in TEST 1's panel) opened by direct URL (no list=)
  page = await openTab(`https://www.youtube.com/watch?v=${P_ITEMS[0]}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(4000);
  [tab] = await tabIdOf();
  const panel5 = await call(page, `!!document.querySelector('ytd-playlist-panel-renderer#playlist:not([hidden])')`);
  gain = await playAndMeasure(page);
  live = await ping(tab.id);
  ss = await sessions();
  check('TEST 5  KNOWN member opened by direct URL (no list=, no panel) → TRACK', !panel5 && gain >= PLAY_S * 0.6 && ss.some((s) => s.contentId === P_ITEMS[0] && s.playlistId === P), `panel ${panel5}, youtube +${f(gain)} s, via ${live?.via}${adNote()}`);

  // ---- TEST 6: KNOWN member opened from a recommendation on that page (SPA)
  known = await members(P);
  const rec = await call(page, `(() => { const known = new Set(${JSON.stringify(known)}); const here = new URL(location.href).searchParams.get('v');
    const a = [...document.querySelectorAll('#secondary a[href^="/watch?v="]')].find(a => { const u = new URL(a.href); const v = u.searchParams.get('v'); return v !== here && known.has(v) && !u.searchParams.has('list'); });
    if (!a) return null; const v = new URL(a.href).searchParams.get('v'); a.click(); return v; })()`);
  if (rec) {
    await waitForUrl(page, rec);
    await sleep(3000);
    const st6 = await call(page, PAGE.state);
    gain = await playAndMeasure(page);
    live = await ping(tab.id);
    check('TEST 6  KNOWN member opened from a RECOMMENDATION (no list=) → TRACK', !st6.list && gain >= PLAY_S * 0.6, `opened ${rec}, list=${st6.list ? 'yes' : 'no'}, youtube +${f(gain)} s, via ${live?.via}${adNote()}`);
  } else {
    console.log('  ℹ TEST 6  no known member among this page\'s recommendations right now — skipped (not a failure)');
  }
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  // ---- TEST 7: KNOWN member opened from SEARCH results (SPA, no list=)
  page = await openTab('https://www.youtube.com/results?search_query=3blue1brown+neural+networks');
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(4000);
  [tab] = await tabIdOf();
  known = await members(P);
  let found = null;
  for (let i = 0; i < 20 && !found; i += 1) {
    found = await call(page, `(() => { const known = new Set(${JSON.stringify(known)});
      const a = [...document.querySelectorAll('ytd-video-renderer a#video-title, ytd-video-renderer a#thumbnail')].find(a => { try { const u = new URL(a.href); return known.has(u.searchParams.get('v')) && !u.searchParams.has('list'); } catch { return false; } });
      if (!a) return null; const v = new URL(a.href).searchParams.get('v'); a.click(); return v; })()`);
    if (!found) await sleep(500);
  }
  if (found) {
    await waitForUrl(page, found);
    await sleep(3000);
    const st7 = await call(page, PAGE.state);
    gain = await playAndMeasure(page);
    live = await ping(tab.id);
    check('TEST 7  KNOWN member opened from SEARCH (no list=) → TRACK', !st7.list && gain >= PLAY_S * 0.6, `opened ${found}, list=${st7.list ? 'yes' : 'no'}, youtube +${f(gain)} s, via ${live?.via}${adNote()}`);
  } else {
    check('TEST 7  KNOWN member opened from SEARCH (no list=) → TRACK', false, 'no known member found in the search results');
  }
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  // ---- TEST 8: an UNKNOWN video opened without list= (never proven) → still not counted
  page = await openTab(`https://www.youtube.com/watch?v=${X}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(4000);
  [tab] = await tabIdOf();
  gain = await playAndMeasure(page);
  live = await ping(tab.id);
  check('TEST 8  unknown video, no playlist proof → DO NOT TRACK', gain === 0, `youtube +${f(gain)} s, reason ${live?.reason}`);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  // ---- Background tab: a member keeps counting while another tab is in front
  page = await openTab(`https://www.youtube.com/watch?v=${P_ITEMS[1]}&list=${P}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(3000);
  await waitNoAd(page);
  [tab] = await tabIdOf();
  let before = await ytContent();
  await call(page, PAGE.play);
  await sleep(3000);
  const other = await openTab('about:blank');
  await cdp.send('Target.activateTarget', { targetId: other.targetId });
  await sleep(1000);
  lastRun = await playSampled(page, PLAY_S);
  const vis = await call(page, 'document.visibilityState');
  await call(page, PAGE.pause);
  await sleep(2500);
  gain = (await ytContent()) - before;
  check('BACKGROUND  member playing in a hidden tab → TRACK', vis === 'hidden' && gain >= PLAY_S * 0.6, `visibility ${vis}, youtube +${f(gain)} s${adNote()}`);

  // ---- Background autoplay to the next playlist item (does membership resolve while hidden?)
  await call(page, `(() => { const v = document.querySelector('video.html5-main-video'); v.currentTime = Math.max(0, v.duration - 6); return v.currentTime; })()`);
  await call(page, PAGE.play);
  await sleep(15_000); // ends → YouTube autoplays the next playlist item
  const st = await call(page, PAGE.state);
  before = await ytContent();
  await sleep(PLAY_S * 1000);
  live = await ping(tab.id);
  await call(page, PAGE.pause);
  await sleep(2500);
  gain = (await ytContent()) - before;
  console.log(`  ℹ BACKGROUND autoplay → next item: now ${st.v} (list ${st.list === P ? 'P' : st.list}), hidden=${(await call(page, 'document.visibilityState')) === 'hidden'}, youtube +${f(gain)} s, tracker reason "${live?.reason}"`);

  // ---- Hidden tab moves to the next playlist item (what autoplay does): does YouTube
  // update the panel's `selected` while hidden, so membership is proven in the background?
  const nextV = P_ITEMS[st.v === P_ITEMS[2] ? 3 : 2];
  await call(page, PAGE.clickPanelItem(nextV));
  await waitForUrl(page, nextV);
  await sleep(1500);
  before = await ytContent();
  lastRun = await playSampled(page, PLAY_S);
  live = await ping(tab.id);
  const hiddenNow = (await call(page, 'document.visibilityState')) === 'hidden';
  const selectedNow = await call(page, `[...document.querySelectorAll('ytd-playlist-panel-renderer#playlist ytd-playlist-panel-video-renderer[selected] a#wc-endpoint')].map(a => new URL(a.href).searchParams.get('v')).join(',')`);
  await call(page, PAGE.pause);
  await sleep(2500);
  gain = (await ytContent()) - before;
  console.log(`  ℹ BACKGROUND next playlist item while hidden: url ${nextV}, hidden=${hiddenNow}, panel selected=${selectedNow}, youtube +${f(gain)} s${adNote()}, tracker reasons while not in an ad: ${[...new Set(lastRun.samples.filter((x) => !x.ad).map((x) => x.reason))].join('/')}`);
  await cdp.send('Target.closeTarget', { targetId: other.targetId });
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  // ---- Long playlist (window of ~100 items), member at #500 and an unrelated video
  await submit(`https://www.youtube.com/playlist?list=${UPLOADS}`);
  page = await openTab(`https://www.youtube.com/watch?v=${UPLOADS_500}&list=${UPLOADS}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(4000);
  gain = await playAndMeasure(page);
  check('LONG     member #500 of a 2,000+ video playlist → TRACK', gain >= PLAY_S * 0.6, `youtube +${f(gain)} s${adNote()}`);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });
  page = await openTab(`https://www.youtube.com/watch?v=${X}&list=${UPLOADS}`);
  await cdp.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(4000);
  [tab] = await tabIdOf();
  gain = await playAndMeasure(page);
  live = await ping(tab.id);
  check('LONG     unrelated video with ?list=<long registered playlist> → DO NOT TRACK', gain === 0, `youtube +${f(gain)} s, reason ${live?.reason}`);
  await cdp.send('Target.closeTarget', { targetId: page.targetId });

  const all = await sessions();
  check('DATA     every YouTube session is a video; no session for an unrelated video', all.every((s) => s.contentType === 'video') && !all.some((s) => s.contentId === X), all.map((s) => `${s.contentId}${s.playlistId ? '@' + s.playlistId.slice(0, 6) : ''}=${f(s.contentSeconds)}s`).join(' '));
} catch (e) {
  check('run completed', false, e.stack || String(e));
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { chrome?.proc.kill('SIGKILL'); } catch { /* ignore */ }
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((r) => r.name).join('; ')}` : ''}\n`);
process.exit(failed.length ? 1 : 0);
