/**
 * Udemy platform descriptor (background side).
 *
 * Udemy course pages are recognised AUTOMATICALLY by the content script
 * (content/udemyDetector.js); this module only maps what that script reports
 * into the platform-independent LearningSession source.
 *
 * V1.2.1 credit messages carry `course: { key, title }` and no `source`. That
 * shape is still what the Udemy content script sends (and what an already-open
 * tab running the old script sends after an upgrade), so it is translated here.
 */

export const udemyPlatform = Object.freeze({
  id: 'udemy',
  label: 'Udemy',
  /** 'automatic': supported pages count without registration. */
  detection: 'automatic',
  contentTypes: Object.freeze(['course']),
  /** Udemy course totals keep their V1 key (the bare course slug). */
  courseKey: (source) => source.courseId,
  defaultCourseTitle: 'Udemy Learning',
});

/** V1 credit `course` ({ key, title } | null) → normalized source fields. */
export function sourceFromLegacyCourse(course) {
  const key = course && typeof course === 'object' ? String(course.key || '').trim() : '';
  const title = course && typeof course === 'object' ? course.title : null;
  return {
    platform: 'udemy',
    contentType: 'course',
    contentId: key || null,
    courseId: key || null,
    courseTitle: title || null,
  };
}
