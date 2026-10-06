/**
 * Local HTTPS server impersonating www.udemy.com for E2E tests ONLY (Chrome is
 * started with --host-resolver-rules so www.udemy.com resolves here). Serves a
 * fake course lecture page whose player is inserted late and can be swapped,
 * mimicking an SPA video player — without using any real Udemy markup classes.
 */
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, createReadStream, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const PAGE = (title) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Course: ${title} | Udemy</title>
<style>body{font-family:sans-serif;margin:0;background:#1c1d1f;color:#fff} header{padding:12px 16px;border-bottom:1px solid #333}
.player-zone{padding:16px} .thumb{width:100px;height:56px} .p-x9f2 video{width:640px;height:360px;background:#000}</style></head>
<body>
<header><a href="/course/machine-learning-az/"><h1 data-purpose="course-header-title" style="font-size:16px;margin:0">${title}</h1></a></header>
<aside><video class="thumb" src="/lecture.webm" muted loop autoplay playsinline></video></aside>
<main class="player-zone" id="zone"></main>
<script>
  let n = 0;
  function mount(autoplay) {
    const zone = document.getElementById('zone');
    zone.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'p-x9f2 rnd-' + (++n);
    const v = document.createElement('video');
    v.src = '/lecture.webm';
    v.muted = false; // unmuted, like a real lecture (Chrome may pause muted videos in hidden tabs)
    v.volume = 0.05;
    v.playsInline = true;
    if (autoplay) v.autoplay = true;
    wrap.appendChild(v);
    zone.appendChild(wrap);
    return v;
  }
  const vid = () => document.querySelector('.player-zone video');
  window.__test = {
    play: () => vid().play().then(() => true),
    pause: () => { vid().pause(); return true; },
    rate: (r) => { vid().playbackRate = r; return r; },
    seekBy: (s) => { vid().currentTime += s; return vid().currentTime; },
    seekTo: (t) => { vid().currentTime = t; return vid().currentTime; },
    time: () => vid()?.currentTime ?? null,
    state: () => ({ paused: vid()?.paused, t: vid()?.currentTime, rate: vid()?.playbackRate, path: location.pathname }),
    nextLecture: () => { history.pushState({}, '', location.pathname.replace(/\\d+$/, (m) => String(Number(m) + 1))); mount(true); return location.pathname; },
    leaveCourse: () => { vid()?.pause(); document.getElementById('zone').innerHTML = ''; history.pushState({}, '', '/home/my-courses/learning/'); return true; },
  };
  setTimeout(() => mount(false), 1500); // player initializes after page load
</script>
</body></html>`;

export function ensureCert(dir) {
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=www.udemy.com'], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

export function startMockUdemy({ videoPath, certDir, title = 'Machine Learning A-Z: AI, Python & R' }) {
  const creds = ensureCert(certDir);
  const server = https.createServer(creds, (req, res) => {
    const url = new URL(req.url, 'https://www.udemy.com');
    if (url.pathname === '/lecture.webm') {
      const size = statSync(videoPath).size;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { 'Content-Type': 'video/webm', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
        createReadStream(videoPath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': size });
        createReadStream(videoPath).pipe(res);
      }
      return;
    }
    if (url.pathname.startsWith('/course/') || url.pathname.startsWith('/home/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE(title));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
