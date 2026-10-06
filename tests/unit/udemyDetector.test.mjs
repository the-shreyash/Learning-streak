import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod } from './helpers.mjs';

await mod('content/udemyDetector.js');
const D = globalThis.__UdemyStreak.udemyDetector;
const loc = (href) => new URL(href);
const fakeDoc = (title, selectors = {}) => ({ title, querySelector: (sel) => (selectors[sel] ? { textContent: selectors[sel] } : null) });

test('only course lecture pages are tracked', () => {
  assert.ok(D.isLearnPage(loc('https://www.udemy.com/course/machinelearning/learn/lecture/6087180#overview')));
  assert.ok(D.isLearnPage(loc('https://acme.udemy.com/course/react-the-complete-guide/learn/')));
  assert.ok(D.isLearnPage(loc('https://www.udemy.com/course/x/learn')));
  assert.ok(!D.isLearnPage(loc('https://www.udemy.com/course/machinelearning/')));
  assert.ok(!D.isLearnPage(loc('https://www.udemy.com/home/my-courses/learning/')));
  assert.ok(!D.isLearnPage(loc('https://www.udemy.com/')));
  assert.ok(!D.isLearnPage(loc('https://evil-udemy.com.example.org/course/x/learn/')));
});

test('course detection: DOM attribute → document title → slug → fallback', () => {
  const l = loc('https://www.udemy.com/course/machine-learning-az/learn/lecture/1');
  assert.deepEqual(D.detectCourse(fakeDoc('Udemy', { '[data-purpose="course-header-title"]': '  Machine Learning A-Z  ' }), l),
    { key: 'machine-learning-az', title: 'Machine Learning A-Z', confident: true });
  assert.equal(D.detectCourse(fakeDoc('Course: Python - The Complete Guide | Udemy'), l).title, 'Python - The Complete Guide');
  assert.equal(D.detectCourse(fakeDoc('Udemy'), l).title, 'Machine Learning Az');
  assert.equal(D.detectCourse(fakeDoc('Udemy'), loc('https://www.udemy.com/course/12345/learn/')).title, 'Udemy Learning');
  assert.equal(D.detectCourse(fakeDoc('x'), loc('https://www.udemy.com/home/')), null);
});

test('compact duration for small tiles', async () => {
  const F = await mod('core/format.js');
  assert.equal(F.formatDurationCompact(77 * 3600 + 34 * 60), '77h 34m');
  assert.equal(F.formatDurationCompact(123 * 3600 + 5 * 60), '123h');
});
