/**
 * Platform registry — the boundary between platform adapters and the
 * platform-independent Learning Engine. The engine only ever asks this registry
 * about a platform; it never contains platform-specific rules itself.
 *
 * Adding a platform (e.g. Coursera) = add a descriptor here + a content-side
 * adapter. Unknown platforms are rejected by the engine.
 */

import { udemyPlatform } from './udemy.js';
import { youtubePlatform } from './youtube.js';
import { courseraPlatform } from './coursera.js';

const PLATFORMS = Object.freeze({
  [udemyPlatform.id]: udemyPlatform,
  [youtubePlatform.id]: youtubePlatform,
  [courseraPlatform.id]: courseraPlatform,
});

export const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS));

/** Platform that owns history recorded before V2 (V1.x tracked only Udemy). */
export const LEGACY_PLATFORM = udemyPlatform.id;

export const getPlatform = (id) => (Object.hasOwn(PLATFORMS, id) ? PLATFORMS[id] : null);
export const isKnownPlatform = (id) => getPlatform(id) !== null;
export const platformLabel = (id) => getPlatform(id)?.label || String(id);
