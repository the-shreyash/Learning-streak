/**
 * YouTube platform descriptor (background side).
 *
 * YouTube is NEVER detected automatically: only content the user registered in
 * the Learning Library may produce learning time (core/learningLibrary.js).
 * V2.1 Phase B registers single videos. Playlists are not registrable yet: the
 * page cannot reliably prove "this video belongs to playlist X" (see README).
 */

import '../content/youtubeDetector.js'; // shared URL parser (classic script, sets globalThis.__UdemyStreak.youtubeDetector)

const detector = globalThis.__UdemyStreak.youtubeDetector;

export const youtubePlatform = Object.freeze({
  id: 'youtube',
  label: 'YouTube',
  /** 'registered': only explicitly registered content counts. */
  detection: 'registered',
  contentTypes: Object.freeze(['video', 'playlist']),
  /** Content types the Learning Library accepts today. */
  registrableTypes: Object.freeze(['video']),
  courseKey: (source) => `youtube:${source.contentType}:${source.courseId}`,
  defaultCourseTitle: 'YouTube Learning',
});

/** @returns {{ok:true, videoId, playlistId}|{ok:false, reason}} */
export const parseYouTubeVideoUrl = (input) => detector.parseVideoUrl(input);
export const isYouTubeVideoId = (id) => detector.validVideoId(id) !== null;
