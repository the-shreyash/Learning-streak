import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod } from './helpers.mjs';

const { parseYouTubeVideoUrl: parse } = await mod('platforms/youtube.js');
const { videoIdFromLocation } = globalThis.__UdemyStreak.youtubeDetector;

const ID = 'aircAruvnKk'; // real-shaped 11-char video id
const ok = (url, id = ID) => assert.deepEqual([url, parse(url).ok, parse(url).videoId], [url, true, id]);
const bad = (url, reason) => {
  const r = parse(url);
  assert.equal(r.ok, false, `${url} should be rejected`);
  if (reason) assert.equal(r.reason, reason, url);
};

test('url: youtube.com/watch forms', () => {
  ok(`https://www.youtube.com/watch?v=${ID}`);
  ok(`https://youtube.com/watch?v=${ID}`);
  ok(`http://www.youtube.com/watch?v=${ID}`);
  ok(`https://m.youtube.com/watch?v=${ID}`);
  ok(`www.youtube.com/watch?v=${ID}`); // pasted without scheme
  ok(`  https://www.youtube.com/watch?v=${ID}  `); // surrounding whitespace
  ok(`https://WWW.YouTube.com/watch?v=${ID}`);
});

test('url: watch with extra query parameters; the video id is the identity', () => {
  ok(`https://www.youtube.com/watch?v=${ID}&t=120s`);
  ok(`https://www.youtube.com/watch?feature=share&v=${ID}`);
  ok(`https://www.youtube.com/watch?v=${ID}#t=30`);
  const r = parse(`https://www.youtube.com/watch?v=${ID}&list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi&index=1`);
  assert.equal(r.ok, true);
  assert.equal(r.videoId, ID);
  assert.equal(r.playlistId, 'PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi'); // reported, never registered
});

test('url: youtu.be short links, embed and live', () => {
  ok(`https://youtu.be/${ID}`);
  ok(`https://youtu.be/${ID}?si=abcDEF123&t=42`);
  ok(`youtu.be/${ID}`);
  ok(`https://www.youtube.com/embed/${ID}`);
  ok(`https://www.youtube.com/live/${ID}?feature=share`);
});

test('url: invalid or unreliable links are rejected', () => {
  bad('', 'not-a-url');
  bad('not a url', 'not-a-url');
  bad(null, 'not-a-url');
  bad('ftp://www.youtube.com/watch?v=aircAruvnKk', 'not-a-url');
  bad(`https://user:pw@www.youtube.com/watch?v=${ID}`, 'not-a-url');
  bad(`https://www.youtube.com:8443/watch?v=${ID}`, 'not-a-url');
  bad(`https://notyoutube.com/watch?v=${ID}`, 'not-youtube');
  bad(`https://www.youtube.com.evil.example/watch?v=${ID}`, 'not-youtube');
  bad(`https://evil.example/?u=https://www.youtube.com/watch?v=${ID}`, 'not-youtube');
  bad('https://www.youtube.com/watch?v=ABC123', 'no-video-id'); // not 11 chars
  bad('https://www.youtube.com/watch?v=aircAruvnK!', 'no-video-id');
  bad('https://www.youtube.com/watch', 'no-video-id');
  bad(`https://www.youtube.com/watch?v=${ID}&v=IHZwWFHWa-w`, 'no-video-id'); // ambiguous
  bad('https://www.youtube.com/', 'no-video-id');
  bad('https://www.youtube.com/@3blue1brown', 'no-video-id');
  bad(`https://www.youtube.com/results?search_query=${ID}`, 'no-video-id');
  bad(`https://youtu.be/${ID}/extra`, 'no-video-id');
  bad('https://www.youtube.com/playlist?list=PLZHQObOWTQDNU6R1_67000Dx_ZCJB-3pi', 'playlist');
  bad(`https://www.youtube.com/shorts/${ID}`, 'shorts');
});

test('page location: only watch pages have a video id', () => {
  const loc = (href) => new URL(href);
  assert.equal(videoIdFromLocation(loc(`https://www.youtube.com/watch?v=${ID}&list=PL1`)), ID);
  assert.equal(videoIdFromLocation(loc('https://www.youtube.com/')), null);
  assert.equal(videoIdFromLocation(loc(`https://www.youtube.com/shorts/${ID}`)), null);
  assert.equal(videoIdFromLocation(loc(`https://www.youtube.com/results?search_query=x&v=${ID}`)), null);
  assert.equal(videoIdFromLocation(loc(`https://www.udemy.com/watch?v=${ID}`)), null);
});
