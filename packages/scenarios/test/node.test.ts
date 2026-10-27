// T2.10 — Node helpers ("./node"): loadScenarioFile and loadScenarioDir (ADR-014 §1, §4).
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accumulatedImpact, createSimulation, defaultShop, resolveFaults } from '@whodeployed/engine'
import { afterEach, describe, expect, it } from 'vitest'
import { ScenarioError } from '../src/index.js'
import type { EngineRuntime } from '../src/index.js'
import { loadScenarioDir, loadScenarioFile } from '../src/node.js'

const engine: EngineRuntime = { resolveFaults, createSimulation, accumulatedImpact, systems: { 'default-shop': defaultShop } }

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures')
const scenariosDir = join(here, '..', 'scenarios')

const temps: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whodeployed-scenarios-'))
  temps.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('loadScenarioFile', () => {
  it('reads and parses a file; same result as parseScenario', () => {
    const file = join(fixtures, 'valid.yaml')
    const scenario = loadScenarioFile(file, engine)
    expect(scenario.id).toBe('90-loader-fixture')
    expect(loadScenarioFile(file, engine)).toStrictEqual(scenario)
  })

  it('uses the path it was given as the error file', () => {
    const file = join(fixtures, 'missing-title.yaml')
    expect(() => loadScenarioFile(file, engine)).toThrow(`${file}: title: is required`)
  })

  it('a missing file is a ScenarioError naming it', () => {
    const file = join(fixtures, 'does-not-exist.yaml')
    let error: unknown
    try {
      loadScenarioFile(file, engine)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ScenarioError)
    expect((error as ScenarioError).file).toBe(file)
    expect((error as ScenarioError).message).toMatch(/cannot read file/)
  })
})

describe('loadScenarioDir', () => {
  it('loads *.yaml and *.yml in name order and skips names starting with "_" and other files', () => {
    const dir = tempDir()
    copyFileSync(join(fixtures, 'two-faults.yaml'), join(dir, 'b.yml'))
    copyFileSync(join(fixtures, 'valid.yaml'), join(dir, 'a.yaml'))
    copyFileSync(join(fixtures, 'missing-title.yaml'), join(dir, '_draft.yaml'))
    writeFileSync(join(dir, 'notes.txt'), 'not a scenario')
    expect(loadScenarioDir(dir, engine).map((s) => s.id)).toEqual(['90-loader-fixture', '91-two-faults'])
  })

  it('two files with the same id are a ScenarioError on the second one', () => {
    const dir = tempDir()
    copyFileSync(join(fixtures, 'valid.yaml'), join(dir, 'a.yaml'))
    copyFileSync(join(fixtures, 'valid.yaml'), join(dir, 'b.yaml'))
    expect(() => loadScenarioDir(dir, engine)).toThrow(/b\.yaml: id: duplicate id '90-loader-fixture'/)
  })

  it('stops at the first invalid file with its ScenarioError', () => {
    const dir = tempDir()
    copyFileSync(join(fixtures, 'bad-id.yaml'), join(dir, 'a.yaml'))
    expect(() => loadScenarioDir(dir, engine)).toThrow(ScenarioError)
  })

  it('the package scenarios/ directory loads, and _TEMPLATE.yaml is skipped', () => {
    const scenarios = loadScenarioDir(scenariosDir, engine)
    expect(scenarios.map((s) => s.id)).not.toContain('00-template')
  })
})
