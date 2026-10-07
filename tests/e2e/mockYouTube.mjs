/**
 * Local HTTPS server impersonating www.youtube.com for E2E tests ONLY — a
 * MOCKED FIXTURE, not the real site (Chrome is started with
 * --host-resolver-rules so www.youtube.com resolves here).
 *
 * It reproduces the player behaviour the extension relies on, as observed on
 * youtube.com (2026-10-07), with real YouTube URLs and 11-character video IDs:
 *  - watch pages at /watch?v=<id>; the player is #movie_player.html5-video-player
 *    with ONE <video class="html5-main-video"> that is reused for every video;
 *  - SPA navigation: history.pushState first, then the video's source is
 *    swapped (emptied → loadstart), yt-navigate-start / yt-navigate-finish fire;
 *    ytd-watch-flexy[video-id] and the title update ~3.5 s later;
 *  - an ad sets the class `ad-showing` on #movie_player.
 */
import https from 'node:https';
import { statSync, createReadStream } from 'node:fs';
import { ensureCert } from './mockUdemy.mjs';

const PAGE = (id, titles) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${titles[id] || 'Video'} - YouTube</title>
<style>body{font-family:sans-serif;margin:0;background:#0f0f0f;color:#fff} #movie_player{width:854px;height:480px;background:#000} #movie_player video{width:100%;height:100%}
.thumb{width:168px;height:94px}</style></head>
<body>
<ytd-app>
  <ytd-watch-flexy video-id="${id}">
    <div id="movie_player" class="html5-video-player">
      <video class="html5-main-video" src="/media.webm?v=${id}&n=0" playsinline></video>
    </div>
    <ytd-watch-metadata><h1>${titles[id] || 'Video'}</h1></ytd-watch-metadata>
    <div id="related"><video class="thumb" src="/media.webm?preview=1" muted loop autoplay playsinline></video></div>
  </ytd-watch-flexy>
</ytd-app>
<script>
  const TITLES = ${JSON.stringify(titles)};
  const v = () => document.querySelector('#movie_player video.html5-main-video');
  const flexy = document.querySelector('ytd-watch-flexy');
  v().muted = false; v().volume = 0.05; // unmuted, like a real video (Chrome may pause muted media in hidden tabs)
  let n = 0;
  window.__test = {
    play: () => v().play().then(() => true),
    pause: () => { v().pause(); return true; },
    rate: (r) => { v().playbackRate = r; return r; },
    seekBy: (s) => { v().currentTime += s; return v().currentTime; },
    seekTo: (t) => { v().currentTime = t; return v().currentTime; },
    time: () => v().currentTime,
    state: () => ({ paused: v().paused, t: v().currentTime, id: new URLSearchParams(location.search).get('v'), vis: document.visibilityState, focus: document.hasFocus() }),
    ad: (on) => { document.getElementById('movie_player').classList.toggle('ad-showing', !!on); return on; },
    /** SPA navigation to another video, YouTube-style. */
    navigate: (id) => {
      const wasPlaying = !v().paused;
      document.dispatchEvent(new CustomEvent('yt-navigate-start', { bubbles: true }));
      history.pushState({}, '', '/watch?v=' + id);
      v().src = '/media.webm?v=' + id + '&n=' + (++n); // same element, new source
      if (wasPlaying) v().play();
      document.dispatchEvent(new CustomEvent('yt-navigate-finish', { bubbles: true }));
      setTimeout(() => {
        flexy.setAttribute('video-id', id);
        document.querySelector('ytd-watch-metadata h1').textContent = TITLES[id] || 'Video';
        document.title = (TITLES[id] || 'Video') + ' - YouTube';
        document.dispatchEvent(new CustomEvent('yt-page-data-updated', { bubbles: true }));
      }, 3500);
      return location.href;
    },
    home: () => { history.pushState({}, '', '/'); document.dispatchEvent(new CustomEvent('yt-navigate-finish', { bubbles: true })); return true; },
  };
</script>
</body></html>`;

export function startMockYouTube({ videoPath, certDir, titles = {} }) {
  const creds = ensureCert(certDir);
  const server = https.createServer(creds, (req, res) => {
    const url = new URL(req.url, 'https://www.youtube.com');
    if (url.pathname === '/media.webm') {
      const size = statSync(videoPath).size;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const start = range && range[1] ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      createReadStream(videoPath, { start, end }).pipe(res);
      return;
    }
    if (url.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') || '')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE(url.searchParams.get('v'), titles));
      return;
    }
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>YouTube</title><p>home</p>'); return; }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
