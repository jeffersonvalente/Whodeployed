// @vitest-environment node
/**
 * Artifact check of SPEC §6 "the UI does not know YAML" (FASE-2 PR-19; ADR-014 Emenda 1).
 *
 * The lint and import tests (boundaries.test.ts) see only the direct imports of src/; a library
 * pulled transitively through @whodeployed/scenarios is visible only in the bundle. So this test
 * runs a real production build with this package's vite.config.ts (same plugins, defines and
 * onwarn), into a temporary directory, with one extra entry (test/bundle/probe.ts) that reaches
 * every runtime export of @whodeployed/scenarios "." and the bound `createSession`, and then
 * greps the emitted JavaScript:
 *   - no `tag:yaml.org,2002` (a string every build of the `yaml` library carries);
 *   - no `__vite-browser-external` (Vite's stub for a Node built-in imported in a browser build);
 *   - the probe did reach the session and the scenarios entry (strings of both are present), so
 *     the check is not vacuous.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const webDir = fileURLToPath(new URL('..', import.meta.url))

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? listFiles(path) : [path]
    })
}

let outDir = ''
let javascript = ''

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'whodeployed-web-bundle-'))
  // Vitest sets NODE_ENV=test, which makes the React plugin emit the development JSX runtime;
  // the check must see the production build that `pnpm build` makes.
  const nodeEnv = process.env['NODE_ENV']
  process.env['NODE_ENV'] = 'production'
  try {
    await runBuild()
  } finally {
    if (nodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = nodeEnv
  }
  javascript = listFiles(outDir)
    .filter((path) => path.endsWith('.js'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n')
}, 120_000)

async function runBuild(): Promise<void> {
  await build({
    configFile: join(webDir, 'vite.config.ts'),
    root: webDir,
    mode: 'production',
    logLevel: 'silent',
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        input: { index: join(webDir, 'index.html'), probe: join(webDir, 'test', 'bundle', 'probe.ts') },
      },
    },
  })
}

afterAll(() => {
  if (outDir !== '') rmSync(outDir, { recursive: true, force: true })
})

describe('browser bundle (PR-19, ADR-014 Emenda 1)', () => {
  it('reaches the bound createSession and the scenarios "." entry (not vacuous)', () => {
    // session.ts (playableLevel) and packages/scenarios/src/config.ts (toSimulationConfig).
    expect(javascript.includes('which has no repertoire in this phase'), 'session.ts is in the bundle').toBe(true)
    expect(javascript.includes('unknown system'), '@whodeployed/scenarios "." is in the bundle').toBe(true)
  })

  it('has no YAML library', () => {
    expect(javascript.includes('tag:yaml.org,2002'), 'the `yaml` library is in the browser bundle').toBe(false)
  })

  it('has no Node built-in stub', () => {
    expect(javascript.includes('__vite-browser-external'), 'a Node built-in is in the browser bundle').toBe(false)
  })
})
