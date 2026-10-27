// T2.18 — scripts/build-data.mjs: the "./data" bundle for the UI (ADR-014 §4).
// FASE-2 PR-19 ("the UI does not know YAML": dist/data.js is parsed data, no `yaml`, no loader),
// input of PR-4 (campaign vs test incidents, ordered by id) and DET (two builds, same bytes).
//
// The script runs as a child process exactly as `pnpm build` runs it; it needs dist/node.js, so
// `build` runs before `test` (CI order, ADR-014 §4). Fixtures are written to a temporary directory
// from test/fixtures/valid.yaml, so the tests do not depend on which real YAML files exist yet.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { accumulatedImpact, createSimulation, defaultShop, resolveFaults } from '@whodeployed/engine'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseDocument, stringify } from 'yaml'
import { ScenarioError } from '../src/index.js'
import type { EngineRuntime, ScenarioBundle } from '../src/index.js'
import { loadScenarioDir, loadScenarioFile } from '../src/node.js'

const engine: EngineRuntime = { resolveFaults, createSimulation, accumulatedImpact, systems: { 'default-shop': defaultShop } }

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(packageDir, 'scripts', 'build-data.mjs')
const validSource = readFileSync(join(packageDir, 'test', 'fixtures', 'valid.yaml'), 'utf8')

let work: string

beforeAll(() => {
  if (!existsSync(join(packageDir, 'dist', 'node.js'))) {
    throw new Error('dist/node.js is missing: run `pnpm --filter @whodeployed/scenarios build` before the tests')
  }
  work = mkdtempSync(join(tmpdir(), 'whodeployed-build-data-'))
})

afterAll(() => {
  rmSync(work, { recursive: true, force: true })
})

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function runBuild(scenariosDir: string, outDir: string): Run {
  const result = spawnSync(process.execPath, [script, '--scenarios', scenariosDir, '--out', outDir], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** valid.yaml with `id` (and a seed of its own) replaced. */
function scenarioYaml(id: string): string {
  const doc = parseDocument(validSource).toJS() as Record<string, unknown>
  doc.id = id
  doc.seed = `build-data-${id}`
  return stringify(doc)
}

/** A fresh directory holding `files` (name -> YAML source). */
function scenarioDir(name: string, files: Record<string, string>): string {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, source] of Object.entries(files)) writeFileSync(join(dir, file), source)
  return dir
}

/** Imports a built data.js in a fresh Node process and returns its `bundle`. */
function importBundle(dataJs: string): ScenarioBundle {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(dataJs).href)}); process.stdout.write(JSON.stringify(m.bundle))`],
    { encoding: 'utf8' },
  )
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as ScenarioBundle
}

/**
 * Imports `dataJs` (copied alone into an empty directory, far from any node_modules) in a Node
 * process whose module resolve hook refuses every specifier except the file itself. Exit 0 proves
 * that loading data.js resolves no module at all: neither `yaml` nor the loader nor the engine.
 */
function importIsolated(dataJs: string, name: string): Run {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  const entry = join(dir, 'data.js')
  copyFileSync(dataJs, entry)
  const entryUrl = pathToFileURL(entry).href
  const hooks = join(dir, 'hooks.mjs')
  writeFileSync(
    hooks,
    `export async function resolve(specifier, context, next) {\n` +
      `  if (specifier !== ${JSON.stringify(entryUrl)}) throw new Error('data.js imports ' + specifier)\n` +
      `  return next(specifier, context)\n}\n`,
  )
  const register = join(dir, 'register.mjs')
  writeFileSync(register, `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hooks).href)})\n`)
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(register).href, '--input-type=module', '-e', `const m = await import(${JSON.stringify(entryUrl)}); process.stdout.write(JSON.stringify(m.bundle))`],
    { encoding: 'utf8', cwd: dir },
  )
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('build-data: the package scenarios/ directory', () => {
  it('builds a valid bundle (campaign NN-*, testIncidents test-*, each ordered by id), _TEMPLATE.yaml ignored', () => {
    const out = join(work, 'real-out')
    const run = runBuild(join(packageDir, 'scenarios'), out)
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const bundle = importBundle(join(out, 'data.js'))
    const campaignIds = bundle.campaign.map((s) => s.id)
    const testIds = bundle.testIncidents.map((s) => s.id)
    for (const id of campaignIds) expect(id).toMatch(/^[0-9]{2}-[a-z0-9-]+$/)
    for (const id of testIds) expect(id).toMatch(/^test-[a-z0-9-]+$/)
    expect(campaignIds).toEqual([...campaignIds].sort())
    expect(testIds).toEqual([...testIds].sort())
    // Same content as the loader reading the same directory (empty today: only _TEMPLATE.yaml).
    const loaded = loadScenarioDir(join(packageDir, 'scenarios'), engine)
    expect(campaignIds.length + testIds.length).toBe(loaded.length)
  })
})

describe('build-data: fixtures', () => {
  // File names deliberately sort differently from the ids inside them.
  const files = {
    'a.yaml': scenarioYaml('05-retry-storm'),
    'b.yaml': scenarioYaml('test-zeta'),
    'c.yml': scenarioYaml('01-crash-loop'),
    'd.yaml': scenarioYaml('test-alpha'),
    'e.yaml': scenarioYaml('03-pool'),
    '_TEMPLATE.yaml': 'not: [valid, scenario\n',
  }
  let dir: string
  let out: string
  let run: Run

  beforeAll(() => {
    dir = scenarioDir('fixtures-ok', files)
    out = join(work, 'fixtures-out')
    run = runBuild(dir, out)
  })

  it('exits 0 and writes dist/data.js and dist/data.d.ts', () => {
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('3 campaign scenario(s), 2 test incident(s)')
    expect(existsSync(join(out, 'data.js'))).toBe(true)
    expect(existsSync(join(out, 'data.d.ts'))).toBe(true)
  })

  it('campaign holds only NN-* ordered by id; testIncidents only test-* ordered by id (input of PR-4)', () => {
    const bundle = importBundle(join(out, 'data.js'))
    expect(bundle.campaign.map((s) => s.id)).toEqual(['01-crash-loop', '03-pool', '05-retry-storm'])
    expect(bundle.campaign.every((s) => !s.testIncident)).toBe(true)
    expect(bundle.testIncidents.map((s) => s.id)).toEqual(['test-alpha', 'test-zeta'])
    expect(bundle.testIncidents.every((s) => s.testIncident)).toBe(true)
  })

  it('holds exactly what the loader returns for each file (already parsed: faults resolved, referencePath normalized)', () => {
    const bundle = importBundle(join(out, 'data.js'))
    const all = [...bundle.campaign, ...bundle.testIncidents]
    for (const [file, source] of Object.entries(files)) {
      if (file.startsWith('_')) continue
      const id = (parseDocument(source).toJS() as { id: string }).id
      expect(all.find((s) => s.id === id)).toEqual(loadScenarioFile(join(dir, file), engine))
    }
  })

  it('data.d.ts types `bundle` as ScenarioBundle from the package entry', () => {
    const dts = readFileSync(join(out, 'data.d.ts'), 'utf8')
    expect(dts).toContain("import type { ScenarioBundle } from './index.js';")
    expect(dts).toContain('export declare const bundle: ScenarioBundle;')
  })

  it('PR-19: data.js imports nothing at runtime: no `yaml`, no loader, no engine', () => {
    const js = readFileSync(join(out, 'data.js'), 'utf8')
    expect(js.match(/from 'yaml'/g)).toBeNull()
    // Only the data literal: nothing but comment lines before `export const bundle =`.
    const code = js.split('\n').filter((line) => !line.startsWith('//'))
    expect(code[0]).toBe('export const bundle = {')
    const run = importIsolated(join(out, 'data.js'), 'isolated-ok')
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect((JSON.parse(run.stdout) as ScenarioBundle).campaign).toHaveLength(3)
  })

  it('PR-19 control: the same isolation harness rejects a module that imports `yaml`', () => {
    const bad = join(work, 'bad-data.js')
    writeFileSync(bad, "import { parse } from 'yaml'\nexport const bundle = parse('{}')\n")
    const run = importIsolated(bad, 'isolated-bad')
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('data.js imports yaml')
  })

  it('DET: two builds of the same YAML give byte-identical data.js and data.d.ts', () => {
    const again = join(work, 'fixtures-out-again')
    expect(runBuild(dir, again).status).toBe(0)
    for (const name of ['data.js', 'data.d.ts']) {
      expect(readFileSync(join(again, name)).equals(readFileSync(join(out, name)))).toBe(true)
    }
  })
})

describe('build-data: invalid YAML fails the build', () => {
  it('exits != 0 with the loader message (file, field, reason) and writes no bundle', () => {
    const source = scenarioYaml('03-pool').replace(/^title: .*$/m, '')
    const dir = scenarioDir('fixtures-bad', { 'ok.yaml': scenarioYaml('01-crash-loop'), 'bad.yaml': source })
    const out = join(work, 'bad-out')
    const run = runBuild(dir, out)
    expect(run.status).not.toBe(0)
    let expected: ScenarioError | undefined
    try {
      loadScenarioFile(join(dir, 'bad.yaml'), engine)
    } catch (error) {
      expected = error as ScenarioError
    }
    expect(expected).toBeInstanceOf(ScenarioError)
    expect(expected?.field).toBe('title')
    expect(run.stderr).toContain(String(expected?.message))
    expect(existsSync(join(out, 'data.js'))).toBe(false)
  })

  it('exits != 0 when the scenarios directory does not exist', () => {
    const run = runBuild(join(work, 'no-such-dir'), join(work, 'none-out'))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('build-data:')
  })
})
