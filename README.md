# 🔥 Udemy Learning Streak

A personal Chrome extension (Manifest V3) that keeps a LeetCode-style daily streak for Udemy. It only counts lectures you actually watch. Everything stays on your computer.

> **Current stable release: v1.2.1.** It has been verified on a real Udemy lecture and is the stable baseline for future work (V2). It tracks in background tabs and while other apps are in front, stops on pause, counts 2× playback as extra content, and doesn't count seeking.

- Your goal counts **lecture content consumed** (V1.1): how far the video really advanced while it was playing. 5 minutes at 2× = 10 minutes of content. **Actual watch time** is tracked alongside it.
- **V1.2: if the video is genuinely playing and progressing, it counts — regardless of which tab or application you're using.** Code in VS Code, take notes or browse another tab while the lecture plays; it's still tracked.
- Pauses, ended or frozen videos, a locked screen, sleep, buffering and seeking are **not** counted.
- You get a daily goal (15/30/45/60/90/120 or custom minutes), a current streak, a best streak, totals, a contribution calendar, per-course totals, a one-time celebration, optional reminders, and JSON export/import.
- No backend, no login, no analytics. It **never** touches Udemy's course progress, playback or input.

---

## Install (load unpacked)

1. Unzip the project anywhere, for example `~/udemy-learning-streak`.
2. Open **`chrome://extensions`**.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the **`extension`** folder inside the project. This is the folder that contains `manifest.json`, not the project root.
6. Pin the extension: click the puzzle icon → pin **Udemy Learning Streak**.
7. Open any Udemy lecture (`https://www.udemy.com/course/<course>/learn/lecture/...`) and press play. The toolbar badge turns **orange** while it is tracking.

If a Udemy tab was already open before you installed, the extension adds the tracker to it automatically. Reloading the tab also works.

### After changing the code

- Go to `chrome://extensions` → **Udemy Learning Streak** → click the **⟳ reload** icon.
- Your data is kept: it lives in `chrome.storage.local`, and reloading the extension doesn't clear it.
- Open Udemy tabs get the new tracker automatically. Popup and options changes show up the next time you open them.
- If you edit a service-worker file, click **service worker** on the extension card to see its console.

---

## How learning is counted (V1.1)

LearnStreak records two numbers for every day:

| Metric | What it is | Used for |
|---|---|---|
| **Lecture content** (`contentSeconds`) | How far the lecture video really advanced while you were actively watching | **Daily goal, streak, calendar, stats** |
| **Actual watch time** (`actualActiveSeconds`) | Real time you spent actively watching | Shown underneath for reference |

At 1× they're equal. At 2×, 5 real minutes = **10 minutes of content** and 5 minutes of actual watch time. A 60-minute goal can be completed in 35 real minutes at ~1.7×. That's intentional.

| Situation | Content counted? |
|---|---|
| Lecture playing (Udemy tab active or not, Chrome focused or not) | ✅ video progress |
| 1.5× / 2× playback | ✅ video progress (10 real min at 1.5× ≈ 15 min content) |
| Video paused / ended / buffering | ❌ |
| **Seeking** (dragging the progress bar), forward or back | ❌ never counts as watching; tracking resumes from the new position |
| Switching lecture / the player recreating the `<video>` | ❌ the jump between lectures isn't counted; tracking restarts on the new video |
| Switched to another tab (video still playing) | ✅ (V1.2) |
| Another app in front, e.g. VS Code (video still playing) | ✅ (V1.2) |
| Paused / seeked / switched lecture while in the background | same rules as in the foreground |
| Chrome itself pauses or freezes the background video | ❌ the video isn't progressing, so nothing is counted |
| Screen locked / laptop asleep | ❌ |
| Session crossing midnight (11:59 PM → 12:01 AM) | split between both days by actual timestamps |
| Looking at the extension popup while watching | ✅ (opening the popup doesn't pause tracking) |

**How it's measured.** There's no "+1 every second" counter. About once a second while a video plays, and immediately on every play, pause, seek, rate change, page-lifecycle or lock event, the tracker compares two snapshots of the same `<video>`:

- the real time that passed (`performance.now()`) → **actual watch time**, never more than the video's own progress allows
- how far `currentTime` moved → **content**, accepted only when normal playback at the current speed could explain it in that much real time (`Δvideo ≤ Δreal × rate`, small tolerance)

A backwards move, a jump bigger than the playback rate can explain, a `seeking` event, a new video source or a replaced element counts as a discontinuity: that interval adds **0** content, and measuring restarts from the new position. The two metrics are measured side by side from the same interval. They're never added together.

**Background tabs (V1.2 / V1.2.1).** Tab visibility and window focus don't affect counting. Measurement is driven by the playing video's own `timeupdate` events (fired by the media pipeline, not by page timers) with a timer as fallback, so it keeps its ≈1 s cadence in a hidden tab. Even if Chrome slows a hidden tab's timers (to about once a minute in some cases), that only makes a measured interval longer, and each one is still validated against how far the video moved. The popup shows the live status of a lecture playing in any Udemy tab, not only the active one. LearnStreak never keeps a tab awake, never forces playback and never bypasses browser policies: if Chrome stops a background video, `currentTime` stops moving and nothing is counted.

> **Updating an unpacked install:** Chrome does not pick up changed files on its own. After pulling a new version, click **Reload** on the extension card in `chrome://extensions` and check the version on the Options page (it should say v1.2.1). Until you reload, Chrome keeps running the old code — e.g. V1.1, which deliberately paused in background tabs.

Credit is saved to storage at least every **5 seconds**, and right away when tracking stops or the page closes. A browser crash loses at most a few seconds.

**Streak rules.** A day is complete when its lecture content (plus any V1 legacy time, see below) reaches `goalSeconds` on your local calendar date.

- Your streak is the run of completed days ending today, or ending yesterday if today isn't done yet. It's still alive until midnight.
- Miss a full day and it resets. The next completed day starts a new streak at 1.
- Closing the browser never affects the streak.
- Each day keeps the goal it had. Changing the goal affects today (if not yet completed) and future days.
- A completed day stays completed.
- Your best streak never goes down.

---

## Using it

- **Popup**: shows your streak, today's progress bar, the current or last course, Today / This week / Best / Total, and a status chip (Tracking / Paused / Screen locked …). **View calendar** opens the month heatmap (‹ › to browse past months) and per-course totals.
- **Badge**: shows today's minutes. Orange means tracking now, green means today's goal is done, grey means idle.
- **Settings** (gear icon, or right-click the icon → Options):
  - daily goal
  - notifications and a daily reminder time
  - Export / Import (merge or replace, validated first) / Reset statistics (asks you to type `RESET`)

---

## YouTube — opt-in Learning Library (V2.1, in development)

YouTube never counts by itself. A YouTube video counts **only** if you added it to your **Learning Library** (Settings → Learning Library → *+ Add YouTube Content*) and it's **enabled**. Nothing else is used to decide: no AI, titles, channels, categories or keywords.

- **Adding**: paste a video link. `youtube.com/watch?v=…` (also `m.`, or no `www.`), `youtu.be/…`, `/embed/…` and `/live/…` work, and extra parameters like `&t=`, `&si=` and `&list=` are ignored. The video ID (11 characters) is the identity, so the same video can't be added twice under another link form. Links that can't be parsed reliably are refused, and so are playlists, Shorts and other sites. Title and subject are optional. You can enable, disable or delete each entry; time you already learned stays when you delete one.
- **Counting**: the same measurement as Udemy (V1.2.1): genuine forward video progress, speed-aware content plus real "actual" time. It keeps counting in a background tab or while another app is in front. Pause, end, seeking, stalls, ads, screen lock and sleep don't count.
- **Unregistered videos**: the YouTube tab doesn't even send time for them. The background worker also rejects any YouTube credit whose video isn't an enabled Library item. That check runs against the same state it writes, so a stale tab can't sneak time in.
- **Switching videos inside YouTube (SPA)**: identity is the URL's `v=`, checked on every measurement and on every `timeupdate`. A measurement interval during which the ID changed is dropped. YouTube reuses one `<video>` and swaps its source *after* changing the URL, so each media source is tied to the video ID the URL showed when it loaded. Time only counts while the element plays a source loaded for the current ID.
- **Popup**: on a registered video it shows *Learning · YouTube*, the title, and the session's Content / Actual. On any other video it shows *Not registered as learning*.

**Playlists are not supported yet (deferred to Phase C).** Here's what the page itself shows (checked on youtube.com on 2026-10-07):
- `&list=` in the URL proves nothing. YouTube shows a playlist's panel, "1 / 10" included, next to *any* video given that `list=`.
- The playlist panel (`ytd-playlist-panel-video-renderer`) does list the playlist's video IDs locally. That was complete for 10- and 47-video playlists, but it's undocumented DOM and wasn't checked for very long playlists, which YouTube may load in pieces.

Proving "this video belongs to playlist X" without the YouTube Data API, an API key or a network request would therefore rest on that DOM alone, so it isn't done.

## Project structure

```
extension/                     ← load this folder in Chrome
  manifest.json
  icons/
  src/
    config/config.js           build flags (DEBUG_TOOLS), presets, limits
    content/                   classic scripts injected on *.udemy.com (dormant except on /course/*/learn/*)
      activityRules.js         pure counting rules: computeCredit(), evaluateConditions()
      udemyDetector.js         lecture-page + course detection (attribute selectors → title → URL slug → fallback)
      videoTracker.js          robust <video> selection (document-level capture of media events, scoring, shadow-DOM fallback)
      activityTracker.js       screen-lock + page-freeze state (visibility/focus only trigger re-measurement)
      main.js                  orchestrator: measurement loop, SPA navigation, MutationObserver, flushing, single-instance handover
    core/                      pure ES modules (unit-tested, no Chrome APIs)
      dateUtils.js             local day keys, DST-safe day math, midnight splitting
      streakEngine.js          current / longest streak
      statisticsEngine.js      today / week / month / all-time, calendar grid, course ranking
      timerEngine.js           applies credit to day records, goal changes, overlap protection
      dataTransfer.js          export / validated import / merge
      schema.js, clock.js, format.js
    storage/
      storageService.js        single gateway, serialized writes, pluggable adapter (cloud sync later)
      migrationService.js      schema versioning + repair
    background/
      serviceWorker.js         the only writer; message router; idle lock; lifecycle; re-injection on update
      badge.js, notifications.js, reminders.js
    popup/                     dashboard.js, calendar.js, celebration.js, popup.js
    options/                   options.js, importExport.js
    shared/                    theme.css (tokens, light/dark), stateClient.js
tests/
  unit/                        node:test suites (66 tests)
  e2e/                         real-Chromium end-to-end test + debug-tools test
scripts/                       check.mjs (static/permission review), build.mjs (zip), icons, screenshots
```

**Data flow.** The content script measures time → sends `tracker:credit {seconds, endMs, course}` → the service worker validates it (rejects it if the screen is locked, clips any overlap) → `timerEngine` splits it across local days → `storageService` writes it. The popup and options page only read storage. Changes go through messages to the worker.

**Stored data** (`chrome.storage.local`):

- your settings
- `dailyHistory[YYYY-MM-DD] = { contentSeconds, actualActiveSeconds, legacySeconds?, goalSeconds, completed, completedAt?, celebrationShown? }` (schema v2)
- per-course `{ title, totalSeconds, lastWatchedAt }`, keyed by URL slug
- `meta.longestStreak`

Nothing else: no URLs, no lecture names, no account data.

### Upgrading from V1 (data migration)

V1 stored one number per day, `watchedSeconds`, which was **real** watch time. Playback speed was never recorded, so it can't be turned into content time honestly. On upgrade, each V1 day becomes:

- `legacySeconds` = the V1 value, unchanged. It still counts toward that day's goal, so **past streaks, calendar colors and completed days stay exactly as they were**.
- `actualActiveSeconds` = the V1 value (it really was actual time).
- `contentSeconds` = 0. Nothing is invented.

Course totals are converted the same way. The calendar tooltip marks those days as "V1 record". If you upgrade mid-day, today's V1 minutes plus the new content both count toward today's goal. V1 export files still import, and they're converted the same way. The migration is idempotent and never deletes history.

### Permissions

| Permission | Why |
|---|---|
| `host_permissions: https://*.udemy.com/*` | run the tracker on Udemy (incl. Udemy Business subdomains) |
| `host_permissions: https://www.youtube.com/*` | V2.1: run the tracker on YouTube watch pages; it counts only videos in your Learning Library |
| `storage` | save your stats locally |
| `alarms` | daily reminder + midnight badge refresh |
| `notifications` | goal-complete / reminder notifications (can be turned off) |
| `idle` | detect a **locked screen** so that time isn't counted |
| `scripting` | re-attach the tracker to already-open Udemy tabs after install/update |

There's no `tabs`, no `<all_urls>`, no web-accessible resources, and no remote code.

---

## Development

Requires Node 18+. No dependencies to install.

```bash
npm test            # unit tests: streaks, dates/DST/midnight, content vs actual time, seek/pause/background tab/lecture, migration, import
npm run check       # syntax, manifest + permission review, privacy checks (no network APIs/URLs), DEBUG_TOOLS off
npm run build       # check + unit tests + dist/udemy-learning-streak-v1.0.0.zip
npm run test:e2e    # real Chromium + mock Udemy page + real video (needs Chrome/Chromium, ffmpeg, openssl; Xvfb on Linux)
npm run test:speed  # V1.1 browser test on a 60-min video: 2× 5 min, 1.5×, 1×, seek, tab, pause, focus, lecture switch (~20 min)
                    #   SPEED_SCALE=0.2 npm run test:speed runs the same scenarios 5× shorter
npm run test:background  # V1.2 browser test: background tab, other app, background pause/end/2×/seek/lecture switch, lock (~12 min)
npm run test:debug  # verifies the simulation panel on a temporary DEBUG copy
npm run test:v1     # the V1 unit tests only
npm run test:v2     # the V2.1 unit tests only (incl. YouTube playback through the real content scripts, tests/unit/contentHarness.mjs)
npm run test:youtube     # V2.1 browser test against a MOCKED www.youtube.com fixture (tests/e2e/mockYouTube.mjs) + mock Udemy
```

The YouTube browser test never touches the real site. Real-site behaviour has to be checked by hand: the extension loaded unpacked, an added video, a different unregistered video, SPA clicks between them, background tab and another app.

The E2E test plays a real video in a real browser and checks:

- play counts, including while the window is blurred or the tab is hidden; pause doesn't
- 2× speed counts real time
- seeking doesn't inflate time
- SPA lecture change and swapped `<video>` elements keep working
- the goal completes, then the one-time celebration shows
- the calendar updates
- export/import work
- data survives a browser crash
- re-injection never double counts

For E2E, set `CHROME_PATH=/path/to/chrome` if Chromium isn't at the default Playwright location.

### Developer simulation tools

Set `DEBUG_TOOLS = true` in `extension/src/config/config.js` and reload the extension. **Settings** then shows a *Developer tools* panel with:

- **+10 / +30 / +60 minutes**
- **Complete today**
- **Move to next day →** (shifts a simulated clock, not your system clock)
- **Reset clock**
- **Seed 90 days**

With the flag `false` (the default) the panel isn't rendered and the background ignores debug messages. Use a separate Chrome profile for simulation if you don't want test data in your real streak.

---

## Future-ready

Cloud sync, multiple devices, weekly/monthly goals, XP and achievements, a yearly graph, AI insights, and YouTube or other learning sites can be added without touching the counting logic:

- **Sync**: add a storage adapter next to `chromeLocalAdapter()` in `storageService.js`.
- **Goals, XP, achievements**: new engines in `core/` that read `dailyHistory`.
- **Other sites**: a new detector next to `udemyDetector.js`. The counting rules in `activityRules.js` are site-agnostic.
- **Schema changes**: go through `migrationService.js`.

## Privacy

Your learning data is stored locally in your browser. This extension doesn't send your Udemy activity to an external server. There's no analytics, tracking or advertising, and it never collects credentials.
