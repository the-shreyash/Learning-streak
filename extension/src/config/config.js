/**
 * Build-time configuration.
 *
 * DEBUG_TOOLS: when true, the Options page shows a "Developer tools" panel that can
 * simulate learning time and move the clock to the next day. Keep this `false`
 * for everyday use — the panel and its background handlers are inert when false.
 */
export const DEBUG_TOOLS = false;

export const APP_ID = 'udemy-learning-streak';
export const SCHEMA_VERSION = 2; // 2 = V1.1 (content + actual time per day)

export const GOAL_PRESETS_MINUTES = [15, 30, 45, 60, 90, 120];
export const DEFAULT_GOAL_MINUTES = 60;
export const MIN_GOAL_MINUTES = 1;
export const MAX_GOAL_MINUTES = 720;

/** Upper bound for a single credit message from a content script (real seconds). */
export const MAX_CREDIT_PER_MESSAGE_SECONDS = 120;
/** Upper bound for lecture content in one credit message (video seconds). */
export const MAX_CONTENT_PER_MESSAGE_SECONDS = 600;
/** Fastest playback we accept as plausible when validating content vs real time. */
export const MAX_PLAUSIBLE_PLAYBACK_RATE = 16;
