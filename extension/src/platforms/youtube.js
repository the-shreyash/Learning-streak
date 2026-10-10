/**
 * YouTube platform descriptor (background side).
 *
 * YouTube is NEVER detected automatically: only content the user registered in
 * the Learning Library may produce learning time (core/learningLibrary.js).
 * Phase B registers single videos; Phase C adds playlists. A playlist never
 * counts by its `list=` alone: a video counts through a playlist only while the
 * watch page proves it is a member (content/youtubePlaylist.js).
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
  registrableTypes: Object.freeze(['video', 'playlist']),
  courseKey: (source) => `youtube:${source.contentType}:${source.courseId}`,
  defaultCourseTitle: 'YouTube Learning',
});

/** @returns {{ok:true, videoId, playlistId}|{ok:false, reason}} */
export const parseYouTubeVideoUrl = (input) => detector.parseVideoUrl(input);
export const isYouTubeVideoId = (id) => detector.validVideoId(id) !== null;
/** @returns {{ok:true, playlistId}|{ok:false, reason}} */
export const parseYouTubePlaylistUrl = (input) => detector.parsePlaylistUrl(input);
/** A playlist ID the Learning Library accepts (PL / UU / OLAK5uy_ — never mixes or personal lists). */
export const isYouTubePlaylistId = (id) => detector.validPlaylistId(id) !== null;
