// Vite + Vitest config for apps/web (ADR-015 §2, §6, §8).
//
// Build constants (PR-13, ADR-015 §6), resolved here at build time only:
//   __WD_ENGINE_VERSION__  `version` of packages/engine/package.json;
//   __WD_BUILD_SHA__       GITHUB_SHA in CI; otherwise `git rev-parse HEAD`; without git, 'unknown'.
// PR-1: any Rollup warning fails the build (onwarn throws); CI also rejects a build log
// that contains the word "warning".
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const SHA = /^[0-9a-f]{40}$/

function engineVersion(): string {
  const path = fileURLToPath(new URL('../../packages/engine/package.json', import.meta.url))
  const { version } = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof version !== 'string' || version === '') throw new Error(`no "version" in ${path}`)
  return version
}

function buildSha(): string {
  const fromCi = process.env['GITHUB_SHA']
  if (fromCi !== undefined && SHA.test(fromCi)) return fromCi
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return SHA.test(head) ? head : 'unknown'
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  // Relative asset URLs: dist/ opens from any static server and any sub-path (PR-1, PR-21).
  base: './',
  plugins: [react()],
  define: {
    __WD_ENGINE_VERSION__: JSON.stringify(engineVersion()),
    __WD_BUILD_SHA__: JSON.stringify(buildSha()),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      onwarn(warning) {
        throw new Error(`Build warning is an error (PR-1): ${warning.message}`)
      },
    },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
})
