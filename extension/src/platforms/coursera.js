/**
 * Coursera platform descriptor (background side).
 *
 * Coursera is a course platform like Udemy: lecture VIDEO pages of a course
 * (/learn/<course>/lecture/<itemId>/…) are recognised AUTOMATICALLY by the
 * content script (content/courseraDetector.js); nothing else on coursera.org
 * counts. The content script reports
 *   { platform: 'coursera', contentType: 'course', contentId: <course slug>,
 *     courseId: <course slug>, lessonId: <item id>, courseTitle, lessonTitle }
 * so sessions are per lecture (lessonId) and course totals are per course.
 */

export const courseraPlatform = Object.freeze({
  id: 'coursera',
  label: 'Coursera',
  /** 'automatic': supported pages count without registration. */
  detection: 'automatic',
  contentTypes: Object.freeze(['course']),
  /** Namespaced so a Coursera course can never share a total with a Udemy course of the same slug. */
  courseKey: (source) => `coursera:course:${source.courseId}`,
  defaultCourseTitle: 'Coursera Learning',
});
