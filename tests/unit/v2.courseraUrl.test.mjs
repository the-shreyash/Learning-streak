/**
 * V2.2 — Coursera page eligibility + lecture identity (content/courseraDetector.js).
 * URL shapes as verified on the public site (2026-10-09): course pages are
 * /learn/<slug>; a video item is /learn/<slug>/lecture/<itemId>/<lecture-slug>
 * (e.g. learning-how-to-learn / 75EsZ / introduction-to-the-focused-and-diffuse-modes).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod } from './helpers.mjs';

await mod('content/courseraDetector.js'); // classic script → globalThis.__UdemyStreak.courseraDetector
const det = globalThis.__UdemyStreak.courseraDetector;
const at = (u) => new URL(u);
const C = 'https://www.coursera.org';

test('coursera: a lecture item page is eligible, with course slug + item id identity', () => {
  const l = det.parseLecture(at(`${C}/learn/learning-how-to-learn/lecture/75EsZ/introduction-to-the-focused-and-diffuse-modes`));
  assert.deepEqual(l, { courseSlug: 'learning-how-to-learn', itemId: '75EsZ', lectureSlug: 'introduction-to-the-focused-and-diffuse-modes' });
  assert.equal(det.lectureKey(l), 'learning-how-to-learn/75EsZ');
});

test('coursera: lecture without slug, trailing slash, query and hash are the same lecture', () => {
  for (const u of [
    `${C}/learn/learning-how-to-learn/lecture/75EsZ`,
    `${C}/learn/learning-how-to-learn/lecture/75EsZ/`,
    `${C}/learn/learning-how-to-learn/lecture/75EsZ/introduction-to-the-focused-and-diffuse-modes?trk=x#t=30`,
  ]) assert.equal(det.lectureKey(det.parseLecture(at(u))), 'learning-how-to-learn/75EsZ', u);
});

test('coursera: item ids are case-sensitive (never lower-cased), course slugs are not', () => {
  const a = det.parseLecture(at(`${C}/learn/Machine-Learning/lecture/AbCdE`));
  const b = det.parseLecture(at(`${C}/learn/machine-learning/lecture/abcde`));
  assert.equal(a.courseSlug, 'machine-learning');
  assert.equal(a.itemId, 'AbCdE');
  assert.notEqual(det.lectureKey(a), det.lectureKey(b));
});

test('coursera: homepage, search, browse, catalog and marketing pages are rejected', () => {
  for (const u of [
    `${C}/`,
    `${C}/search?query=python`,
    `${C}/browse/data-science`,
    `${C}/courses?query=ml`,
    `${C}/specializations/machine-learning-introduction`,
    `${C}/professional-certificates/google-data-analytics`,
    `${C}/degrees`,
    `${C}/articles/what-is-python-used-for`,
    `${C}/learn/machine-learning`,                 // course landing page (enrollment / marketing)
    `${C}/learn/machine-learning/reviews`,
    `${C}/learn/machine-learning#authMode=login`,
  ]) assert.equal(det.parseLecture(at(u)), null, u);
});

test('coursera: course home, readings, quizzes, exams, assignments and labs are rejected', () => {
  for (const u of [
    `${C}/learn/machine-learning/home/welcome`,
    `${C}/learn/machine-learning/home/module/1`,
    `${C}/learn/machine-learning/supplement/AbCdE/reading`,
    `${C}/learn/machine-learning/quiz/AbCdE/practice-quiz`,
    `${C}/learn/machine-learning/exam/AbCdE/final`,
    `${C}/learn/machine-learning/assignment-submission/AbCdE/x`,
    `${C}/learn/machine-learning/programming/AbCdE/lab`,
    `${C}/learn/machine-learning/ungradedLab/AbCdE/lab`,
    `${C}/learn/machine-learning/peer/AbCdE/review`,
    `${C}/learn/machine-learning/discussions`,
    `${C}/learn/machine-learning/lecture/AbCdE/slug/discussions`, // deeper than a lecture item
  ]) assert.equal(det.parseLecture(at(u)), null, u);
});

test('coursera: unknown / ambiguous / foreign URLs are rejected', () => {
  for (const u of [
    'https://coursera.org/learn/machine-learning/lecture/AbCdE',       // bare domain redirects to www (not served there)
    'http://www.coursera.org/learn/machine-learning/lecture/AbCdE',    // not https
    'https://www.coursera.org.evil.example/learn/x/lecture/AbCdE',
    'https://evil-coursera.org/learn/x/lecture/AbCdE',
    'https://blog.coursera.org/learn/x/lecture/AbCdE',
    'https://www.youtube.com/learn/x/lecture/AbCdE',
    `${C}/learn//lecture/AbCdE`,
    `${C}/learn/x/lecture/`,
    `${C}/learn/x/lecture/ab`,                                        // too short to be an item id
    `${C}/learn/x/lecture/Ab%2FCd`,
    `${C}/lecture/machine-learning/welcome-iYR2y`,                    // legacy public shape (redirects to the landing page)
  ]) assert.equal(det.parseLecture(at(u)), null, u);
  assert.equal(det.parseLecture(null), null);
  assert.equal(det.parseLecture({}), null);
});

test('coursera: titles are humanized from slugs (display only)', () => {
  assert.equal(det.humanizeSlug('learning-how-to-learn'), 'Learning How To Learn');
  assert.equal(det.humanizeSlug(null), null);
  assert.equal(det.humanizeSlug('123'), null);
});

test('coursera: the platform is registered as automatic with a namespaced course key', async () => {
  const { getPlatform, isKnownPlatform, platformLabel } = await mod('platforms/registry.js');
  assert.ok(isKnownPlatform('coursera'));
  const p = getPlatform('coursera');
  assert.equal(p.detection, 'automatic');
  assert.deepEqual([...p.contentTypes], ['course']);
  assert.equal(p.courseKey({ courseId: 'machine-learning' }), 'coursera:course:machine-learning');
  assert.equal(platformLabel('coursera'), 'Coursera');
});

test('coursera: manifest grants only www.coursera.org and injects the Coursera adapter there', async () => {
  const { readFileSync } = await import('node:fs');
  const { SRC } = await import('./helpers.mjs');
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', SRC), 'utf8'));
  const hosts = manifest.host_permissions.filter((h) => /coursera/.test(h));
  assert.deepEqual(hosts, ['https://www.coursera.org/*']);
  const cs = manifest.content_scripts.filter((c) => c.matches.some((m) => /coursera/.test(m)));
  assert.equal(cs.length, 1);
  assert.deepEqual(cs[0].matches, ['https://www.coursera.org/*']);
  assert.equal(cs[0].all_frames, false);
  assert.ok(cs[0].js.includes('src/content/courseraDetector.js'));
  assert.ok(!cs[0].js.some((f) => /youtube|udemy/i.test(f)), 'no other platform adapter on Coursera');
  for (const other of manifest.content_scripts.filter((c) => c !== cs[0])) assert.ok(!other.js.includes('src/content/courseraDetector.js'));
});
