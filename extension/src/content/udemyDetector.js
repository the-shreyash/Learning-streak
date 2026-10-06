/**
 * Udemy page + course detection. Deliberately layered: if one strategy breaks
 * after a Udemy redesign, the next one takes over, ending in a safe fallback.
 * Nothing here is required for time tracking to work.
 */
(function (root) {
  'use strict';
  const NS = (root.__UdemyStreak = root.__UdemyStreak || {});

  const LEARN_PATH_RE = /^\/course\/([^/?#]+)\/learn(?:\/|$)/i;
  const FALLBACK_TITLE = 'Udemy Learning';

  function isLearnPage(loc = root.location) {
    try {
      return /(^|\.)udemy\.com$/i.test(loc.hostname) && LEARN_PATH_RE.test(loc.pathname);
    } catch { return false; }
  }

  function getCourseSlug(loc = root.location) {
    const m = LEARN_PATH_RE.exec(loc.pathname || '');
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function humanizeSlug(slug) {
    if (!slug) return null;
    const words = slug.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!words || /^\d+$/.test(words)) return null;
    return words.replace(/\b([a-z])/g, (c) => c.toUpperCase());
  }

  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

  function isPlausibleTitle(t) {
    if (!t || t.length < 3 || t.length > 200) return false;
    return !/^(udemy|udemy business|online courses?.*|course content|overview)$/i.test(t);
  }

  // Ordered from most to least specific. Attribute selectors survive CSS-class
  // renames far better than generated class names.
  const TITLE_SELECTORS = [
    '[data-purpose="course-header-title"]',
    'header [data-purpose*="course-title"]',
    '[data-purpose="course-title-url"]',
    'header a[href*="/course/"][href$="/"]',
    'header h1',
  ];

  function titleFromDom(doc) {
    for (const sel of TITLE_SELECTORS) {
      let el = null;
      try { el = doc.querySelector(sel); } catch { el = null; }
      const t = clean(el?.textContent);
      if (isPlausibleTitle(t)) return t;
    }
    return null;
  }

  function titleFromDocumentTitle(doc) {
    // Typical form: "Course: Course Title | Udemy". Only split on " | " because
    // course titles themselves often contain dashes.
    const parts = clean(doc.title).split(/\s+\|\s+/).map(clean).filter(Boolean)
      .filter((p) => !/^udemy( business)?$/i.test(p));
    if (!parts.length) return null;
    const candidate = parts[0].replace(/^course:\s*/i, '');
    return isPlausibleTitle(candidate) ? candidate : null;
  }

  /** Returns { key, title, confident } or null when not on a course page. */
  function detectCourse(doc = root.document, loc = root.location) {
    const slug = getCourseSlug(loc);
    if (!slug) return null;
    const dom = titleFromDom(doc);
    if (dom) return { key: slug, title: dom, confident: true };
    const fromTitle = titleFromDocumentTitle(doc);
    if (fromTitle) return { key: slug, title: fromTitle, confident: false };
    return { key: slug, title: humanizeSlug(slug) || FALLBACK_TITLE, confident: false };
  }

  NS.udemyDetector = { isLearnPage, getCourseSlug, detectCourse, humanizeSlug, FALLBACK_TITLE };
})(globalThis);
