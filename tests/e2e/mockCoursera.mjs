/**
 * Local HTTPS server impersonating www.coursera.org for E2E tests ONLY — a
 * MOCKED FIXTURE, not the real site (Chrome is started with
 * --host-resolver-rules so www.coursera.org resolves here).
 *
 * What is real: the URL shapes verified on the public site (2026-10-09) —
 * /learn/<course>, /learn/<course>/lecture/<itemId>/<slug>, /learn/<course>/quiz/…,
 * and real item ids of a public course.
 * What is ASSUMED (the signed-in player could not be inspected): an SPA whose
 * lecture player is a same-document HTML5 <video>, and which on "Next" changes
 * the route first (history.pushState) and then mounts a new <video> — or, with
 * `stale`, keeps the old lecture playing for a while before swapping. No real
 * Coursera markup or class names are used.
 */
import https from 'node:https';
import { statSync, createReadStream } from 'node:fs';
import { ensureCert } from './mockUdemy.mjs';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Coursera</title>
<style>body{font-family:sans-serif;margin:0;background:#fff;color:#111} #zone video{width:854px;height:480px;background:#000} .promo{width:640px;height:360px}</style></head>
<body>
<main id="zone"></main>
<script>
  const LECTURE_RE = /^\\/learn\\/[^/]+\\/lecture\\/([^/]+)/;
  let n = 0;
  const zone = document.getElementById('zone');
  const vid = () => zone.querySelector('video');
  function mount(item, autoplay) {
    zone.innerHTML = '';
    if (!item) return null;
    const v = document.createElement('video');
    v.src = '/media.webm?item=' + item + '&n=' + (++n);
    v.muted = false; v.volume = 0.05; v.playsInline = true; // unmuted, like a real lecture
    if (autoplay) v.autoplay = true;
    zone.appendChild(v);
    return v;
  }
  function route(autoplay) {
    const m = LECTURE_RE.exec(location.pathname);
    if (m) return mount(m[1], autoplay);
    zone.innerHTML = '';
    if (/^\\/learn\\/[^/]+\\/?$/.test(location.pathname) || /\\/quiz\\//.test(location.pathname)) {
      // landing page promo / a video inside a quiz: playing, but not a lecture
      const p = document.createElement('video');
      p.className = 'promo'; p.src = '/media.webm?promo=' + (++n); p.muted = true; p.loop = true; p.autoplay = true; p.playsInline = true;
      zone.appendChild(p);
    }
    return null;
  }
  window.__test = {
    play: () => vid().play().then(() => true),
    pause: () => { vid()?.pause(); return true; },
    rate: (r) => { vid().playbackRate = r; return r; },
    seekBy: (s) => { vid().currentTime += s; return vid().currentTime; },
    state: () => ({ paused: vid()?.paused, t: vid()?.currentTime, path: location.pathname, vis: document.visibilityState }),
    /** SPA route change; the player follows after delayMs (the old one keeps playing meanwhile when stale). */
    go: (path, { delayMs = 0, stale = false } = {}) => {
      const wasPlaying = vid() && !vid().paused;
      history.pushState({}, '', path);
      if (!stale && vid()) vid().remove();
      setTimeout(() => route(wasPlaying), delayMs);
      return location.pathname;
    },
  };
  route(false);
</script>
</body></html>`;

export function startMockCoursera({ videoPath, certDir }) {
  const creds = ensureCert(certDir);
  const server = https.createServer(creds, (req, res) => {
    const url = new URL(req.url, 'https://www.coursera.org');
    if (url.pathname === '/media.webm') {
      const size = statSync(videoPath).size;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const start = range && range[1] ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) });
      createReadStream(videoPath, { start, end }).pipe(res);
      return;
    }
    if (url.pathname === '/' || url.pathname.startsWith('/learn/') || url.pathname.startsWith('/search')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
