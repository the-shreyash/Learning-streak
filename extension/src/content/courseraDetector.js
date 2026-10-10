/**
 * Coursera page + lecture detection (content script; pure URL parsing, no DOM).
 *
 * Only a course VIDEO item counts:  https://www.coursera.org/learn/<course>/lecture/<itemId>[/<lecture-slug>]
 *
 * Verified on the public site (2026-10-09, signed out): course pages are
 * /learn/<course-slug>; the course page's own data lists every syllabus item with
 * a stable item id, a slug and a type (LECTURE / SUPPLEMENT / ASSIGNMENT…), and a
 * video item lives at /learn/<course>/lecture/<itemId>/<slug>. The item id (e.g.
 * "75EsZ") is Coursera's identifier and is used as is; the slugs only give titles.
 * Everything else — homepage, search, browse, specializations, the course landing
 * page (marketing / enrollment), course home, readings (supplement), quizzes,
 * exams, assignments, labs, discussions — is NOT a learning video and never counts.
 * Nothing is guessed from titles or keywords.
 */
(function (root) {
  'use strict';
  const NS = (root.__UdemyStreak = root.__UdemyStreak || {});

  const HOST = 'www.coursera.org';
  const LECTURE_PATH_RE = /^\/learn\/([a-z0-9][a-z0-9-]{0,127})\/lecture\/([A-Za-z0-9_-]{3,32})(?:\/([a-z0-9][a-z0-9-]{0,199}))?\/?$/i;
  const FALLBACK_COURSE_TITLE = 'Coursera Learning';

  /**
   * @returns {{ courseSlug, itemId, lectureSlug } | null}  null = not a Coursera lecture page
   */
  function parseLecture(loc = root.location) {
    try {
      if (!loc || String(loc.protocol) !== 'https:' || String(loc.hostname).toLowerCase() !== HOST) return null;
      const m = LECTURE_PATH_RE.exec(String(loc.pathname || '')); // raw path: ids and slugs are plain ASCII
      if (!m) return null;
      return { courseSlug: m[1].toLowerCase(), itemId: m[2], lectureSlug: m[3] ? m[3].toLowerCase() : null };
    } catch { return null; }
  }

  const isLecturePage = (loc = root.location) => parseLecture(loc) !== null;

  /** "learning-how-to-learn" → "Learning How To Learn" (display only, never identity). */
  function humanizeSlug(slug) {
    if (!slug) return null;
    const words = String(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!words || /^\d+$/.test(words)) return null;
    return words.replace(/\b([a-z])/g, (c) => c.toUpperCase());
  }

  /** Identity of the lecture being played: "<courseSlug>/<itemId>". */
  const lectureKey = (l) => (l ? `${l.courseSlug}/${l.itemId}` : null);

  NS.courseraDetector = { parseLecture, isLecturePage, humanizeSlug, lectureKey, HOST, FALLBACK_COURSE_TITLE };
})(globalThis);
