// @vitest-environment node
/**
 * Boundary tests of apps/web (T2.21; pattern of ADR-008), complementing the lint rules:
 *   PR-19  src/ imports @whodeployed/* only through the public entries and never a YAML library;
 *          the ESLint config rejects deep paths and YAML (proved with sample files);
 *   PR-2   scripts/check-static.sh rejects stylesheets, style attributes/props, <canvas>, <svg>;
 *   PR-3   ... and fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon; it passes on src/;
 *   PR-2   runtime dependencies are only react, react-dom and workspace packages;
 *   PR-13  build-info.ts exposes the 2 build constants;
 *   DET    the ESLint config rejects Math.random and Date.now in src/.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../src/app'
import { BUILD_SHA, ENGINE_VERSION } from '../src/build-info'
import { fixtureBundle } from './fixtures/scenarios'

const webDir = fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(webDir, 'src')
const checkStatic = join(webDir, 'scripts', 'check-static.sh')

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? listFiles(path) : [path]
    })
}

const sources = listFiles(srcDir)
  .filter((path) => /\.(ts|tsx|js|mjs)$/.test(path))
  .map((path) => ({ path: relative(webDir, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }))

/** Every module specifier: static import/export ... from, side-effect import, import(). */
function specifiers(text: string): string[] {
  const found: string[] = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1] as string)
  }
  return found
}

const PUBLIC_ENTRIES = ['@whodeployed/engine', '@whodeployed/scenarios', '@whodeployed/scenarios/data']
const BROWSER_LIBS = ['react', 'react-dom/client']

describe('imports of src/ (PR-19)', () => {
  it('finds the sources', () => {
    expect(sources.map((s) => s.path)).toEqual(
      expect.arrayContaining(['src/app.tsx', 'src/main.tsx', 'src/data.ts', 'src/build-info.ts', 'src/engine-runtime.ts']),
    )
  })

  it('imports only relative modules, React and the public package entries', () => {
    const offending = sources.flatMap(({ path, text }) =>
      specifiers(text)
        .filter((spec) => !spec.startsWith('./') && !spec.startsWith('../'))
        .filter((spec) => !PUBLIC_ENTRIES.includes(spec) && !BROWSER_LIBS.includes(spec))
        .map((spec) => `${path}: ${spec}`),
    )
    expect(offending).toEqual([])
  })

  it('no source mentions a YAML library', () => {
    const offending = sources.filter(({ text }) => /from\s+['"](yaml|js-yaml)['"]/.test(text)).map((s) => s.path)
    expect(offending).toEqual([])
  })
})

describe('ESLint config (PR-19, PR-3, DET)', () => {
  const eslint = new ESLint({ cwd: webDir })

  async function ruleIds(code: string, filePath: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(webDir, filePath) })
    return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`)
  }

  const rejectedInSrc: [string, string, string][] = [
    ['yaml', "import { parse } from 'yaml'\nexport const x = parse", 'no-restricted-imports'],
    ['js-yaml', "import { load } from 'js-yaml'\nexport const x = load", 'no-restricted-imports'],
    ['engine src', "import type { World } from '@whodeployed/engine/src/types.js'\nexport type X = World", 'no-restricted-imports'],
    ['engine dist', "import { simulate } from '@whodeployed/engine/dist/index.js'\nexport const x = simulate", 'no-restricted-imports'],
    ['scenarios src', "import type { Scenario } from '@whodeployed/scenarios/src/types'\nexport type X = Scenario", 'no-restricted-imports'],
    ['scenarios dist', "import { bundle } from '@whodeployed/scenarios/dist/data.js'\nexport const x = bundle", 'no-restricted-imports'],
    ['scenarios/node in src', "import { loadScenarioDir } from '@whodeployed/scenarios/node'\nexport const x = loadScenarioDir", 'no-restricted-imports'],
    ['other subpath', "import x from '@whodeployed/engine/package.json'\nexport default x", 'no-restricted-imports'],
    ['node built-in', "import { readFileSync } from 'node:fs'\nexport const x = readFileSync", 'no-restricted-imports'],
    ['fetch', "export const x = () => fetch('/x')", 'no-restricted-globals'],
    ['WebSocket', "export const x = () => new WebSocket('ws://x')", 'no-restricted-globals'],
    ['sendBeacon', "export const x = () => navigator.sendBeacon('/x')", 'no-restricted-properties'],
    ['Math.random', 'export const x = Math.random()', 'no-restricted-properties'],
    ['Date.now', 'export const x = Date.now()', 'no-restricted-properties'],
    ['new Date', 'export const x = new Date()', 'no-restricted-syntax'],
  ]

  it.each(rejectedInSrc)('rejects %s in src/', async (_name, code, rule) => {
    expect(await ruleIds(code, 'src/__sample__.ts')).toContain(rule)
  })

  it('accepts the public entries in src/', async () => {
    const code = [
      "import type { World } from '@whodeployed/engine'",
      "import type { Scenario } from '@whodeployed/scenarios'",
      "import { bundle } from '@whodeployed/scenarios/data'",
      'export type X = [World, Scenario]',
      'export const y = bundle',
    ].join('\n')
    expect(await ruleIds(code, 'src/__sample__.ts')).toEqual([])
  })

  it('rejects yaml and deep paths in scripts/ and test/, and allows @whodeployed/scenarios/node there', async () => {
    for (const file of ['scripts/__sample__.ts', 'test/__sample__.test.ts']) {
      expect(await ruleIds("import { parse } from 'yaml'\nexport const x = parse", file)).toContain('no-restricted-imports')
      expect(await ruleIds("import { a } from '@whodeployed/engine/dist/index.js'\nexport const x = a", file)).toContain(
        'no-restricted-imports',
      )
      expect(await ruleIds("import { loadScenarioDir } from '@whodeployed/scenarios/node'\nexport const x = loadScenarioDir", file)).toEqual([])
    }
  })
})

describe('scripts/check-static.sh (PR-2, PR-3)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function run(...paths: string[]) {
    return spawnSync('bash', [checkStatic, ...paths], { encoding: 'utf8' })
  }

  function sampleDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'wd-check-static-'))
    dirs.push(dir)
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    return dir
  }

  it('passes on the repository (src/ and index.html)', () => {
    const result = run()
    expect(result.stdout + result.stderr).toContain('check-static: ok')
    expect(result.status).toBe(0)
  })

  it('passes on a clean sample', () => {
    const dir = sampleDir({ 'clean.tsx': 'export const A = () => <p>plain text</p>\n' })
    expect(run(dir).status).toBe(0)
  })

  // Each forbidden pattern is assembled at runtime so this test file is not itself a hit.
  const j = (...parts: string[]) => parts.join('')
  const hits: [string, string][] = [
    ['.css import', j("import './app", ".css'\n")],
    ['<style>', j('<sty', 'le>p{}</style>\n')],
    ['style attribute', j('<p sty', 'le="color: red">x</p>\n')],
    ['style prop', j('<p ', 'style={{ color: "red" }}>x</p>\n')],
    ['style object', j('const s = { sty', 'le: 1 }\n')],
    ['<canvas>', j('<can', 'vas></canvas>\n')],
    ['<svg>', j('<s', 'vg></svg>\n')],
    ['fetch', j('fet', "ch('/api')\n")],
    ['XMLHttpRequest', j('new XMLHttp', 'Request()\n')],
    ['WebSocket', j('new Web', "Socket('ws://x')\n")],
    ['EventSource', j('new Event', "Source('/x')\n")],
    ['sendBeacon', j('navigator.send', "Beacon('/x')\n")],
  ]

  it.each(hits)('fails on %s', (_name, text) => {
    const dir = sampleDir({ 'nested/sample.tsx': text })
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('nested/sample.tsx:1:')
    expect(result.stdout).toContain('check-static: FAILED')
  })

  it('fails on a stylesheet file even when it is empty', () => {
    const dir = sampleDir({ 'theme.css': '' })
    const result = run(dir)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('theme.css')
  })

  it('exits 2 on a missing path', () => {
    expect(run(join(webDir, 'does-not-exist')).status).toBe(2)
  })
})

describe('package.json (PR-2, ADR-015 §2)', () => {
  const pkg = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf8')) as {
    name: string
    private: boolean
    dependencies: Record<string, string>
  }

  it('is the private @whodeployed/web package', () => {
    expect(pkg.name).toBe('@whodeployed/web')
    expect(pkg.private).toBe(true)
  })

  it('has only react, react-dom and workspace packages as runtime dependencies', () => {
    const offending = Object.entries(pkg.dependencies).filter(
      ([name, range]) => !['react', 'react-dom'].includes(name) && !(name.startsWith('@whodeployed/') && range.startsWith('workspace:')),
    )
    expect(offending).toEqual([])
  })
})

describe('build-info.ts (PR-13, ADR-015 §6)', () => {
  it('exposes the engine version read from packages/engine/package.json', () => {
    const engine = JSON.parse(readFileSync(join(webDir, '..', '..', 'packages', 'engine', 'package.json'), 'utf8')) as {
      version: string
    }
    expect(ENGINE_VERSION).toBe(engine.version)
  })

  it('exposes a 40-hex commit SHA or "unknown"', () => {
    expect(BUILD_SHA).toMatch(/^([0-9a-f]{40}|unknown)$/)
  })
})

describe('app shell (PR-2, PR-3)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders without network calls and without style attributes', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const bundle of [undefined, fixtureBundle]) {
      const html = renderToStaticMarkup(createElement(App, bundle === undefined ? {} : { bundle }))
      expect(html).toContain('<h1>Whodeployed</h1>')
      expect(html).not.toMatch(/style=|<svg|<canvas/)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
