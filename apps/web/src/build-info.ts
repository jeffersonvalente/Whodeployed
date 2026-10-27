/**
 * Build constants (PR-13, ADR-015 §6). Replaced by vite.config.ts `define` at build time;
 * nothing is computed at runtime.
 */
declare const __WD_ENGINE_VERSION__: string
declare const __WD_BUILD_SHA__: string

/** `version` of packages/engine/package.json when the prototype was built. */
export const ENGINE_VERSION: string = __WD_ENGINE_VERSION__

/** Git commit SHA of the build (40 hex chars), or 'unknown' in a local build without git. */
export const BUILD_SHA: string = __WD_BUILD_SHA__
