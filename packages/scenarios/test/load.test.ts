// T2.10 — parseScenario and toSimulationConfig (FASE-2 CN-4, CN-1 fields, DET; ADR-014 §1.1, §2).
// One test per CN-4 error case, with the fixture under test/fixtures/; the engine runtime is
// injected from the engine's public entry, as any caller does.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineError, accumulatedImpact, createSimulation, defaultShop, resolveFaults } from '@whodeployed/engine'
import { describe, expect, it } from 'vitest'
import { parseDocument, stringify } from 'yaml'
import { ScenarioError, toSimulationConfig } from '../src/index.js'
import { parseScenario } from '../src/node.js'
import type { EngineRuntime, Scenario } from '../src/index.js'

const engine: EngineRuntime = { resolveFaults, createSimulation, accumulatedImpact, systems: { 'default-shop': defaultShop } }

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8')
const validSource = fixture('valid.yaml')

/** Runs parseScenario and returns the ScenarioError it throws (fails the test if it does not). */
function errorOf(source: string, file = 'scenarios/case.yaml'): ScenarioError {
  try {
    parseScenario(source, file, engine)
  } catch (error) {
    expect(error).toBeInstanceOf(ScenarioError)
    return error as ScenarioError
  }
  throw new Error('expected a ScenarioError')
}

/** valid.yaml as a plain object, edited, then serialized back to YAML. */
function edited(edit: (doc: Record<string, unknown>) => void): string {
  const doc = parseDocument(validSource).toJS() as Record<string, unknown>
  edit(doc)
  return stringify(doc)
}

describe('parseScenario: valid scenario', () => {
  const scenario = parseScenario(validSource, 'fixtures/valid.yaml', engine)

  it('returns the typed fields of SPEC §7 plus impactBudget, review and testIncident (CN-1)', () => {
    expect(Object.keys(scenario)).toEqual([
      'id',
      'title',
      'level',
      'teaches',
      'trap',
      'seed',
      'system',
      'faults',
      'noise',
      'alert',
      'impactBudget',
      'referencePath',
      'rootCause',
      'review',
      'testIncident',
    ])
    expect(scenario).toMatchObject({
      id: '90-loader-fixture',
      level: 'junior',
      seed: 'loader-fixture-01',
      system: 'default-shop',
      alert: { tick: 14, text: '[FIRING] FixtureHighErrorRate gateway: 5xx > 5% for 2m' },
      impactBudget: 60,
      testIncident: false,
    })
  })

  it('resolves faults with the engine (equal to resolveFaults on the same input)', () => {
    const world = createSimulation({ system: defaultShop, seed: scenario.seed }).world
    const expected = resolveFaults([{ kind: 'service_crash_loop', target: 'catalog', startTick: 10, params: { uptimeTicks: 1, restartTicks: 3 } }], world)
    expect(scenario.faults).toStrictEqual(expected)
  })

  it('keeps noise as written', () => {
    expect(scenario.noise).toStrictEqual([{ kind: 'deploy', target: 'auth', tick: 8, note: 'fixture deploy' }])
  })

  it('normalizes referencePath steps to { type: ask, question } / { type: act, action }', () => {
    expect(scenario.referencePath).toStrictEqual([
      { type: 'ask', question: { kind: 'logs', service: 'catalog', window: 30 } },
      { type: 'act', action: { kind: 'restart', target: 'catalog' } },
    ])
  })

  it('parses review patterns, including keySignalAsk', () => {
    expect(scenario.review).toStrictEqual({
      redundant: [{ kind: 'dashboard', service: 'auth' }, { kind: 'whatChanged' }],
      keySignal: 'fixture key signal',
      keySignalAsk: { kind: 'logs', service: 'catalog' },
    })
  })

  it('DET: the same text gives a structurally identical Scenario', () => {
    expect(parseScenario(validSource, 'fixtures/valid.yaml', engine)).toStrictEqual(scenario)
  })

  it('accepts several faults (campaign scenario 8 needs two)', () => {
    const two = parseScenario(fixture('two-faults.yaml'), 'fixtures/two-faults.yaml', engine)
    expect(two.faults.map((f) => [f.kind, f.target])).toEqual([
      ['service_crash_loop', 'catalog'],
      ['slow_dependency', 'postgres'],
    ])
  })

  it('marks test-* ids as test incidents (CN-3)', () => {
    const test = parseScenario(edited((d) => (d['id'] = 'test-loader-fixture')), 'x.yaml', engine)
    expect(test.testIncident).toBe(true)
  })

  it('defaults system to default-shop when omitted (SPEC §7 marks it optional)', () => {
    const scenario = parseScenario(edited((d) => delete d['system']), 'x.yaml', engine)
    expect(scenario.system).toBe('default-shop')
  })

  it('accepts a scenario without noise (optional in SPEC §7)', () => {
    expect(parseScenario(edited((d) => delete d['noise']), 'x.yaml', engine).noise).toEqual([])
  })
})

describe('parseScenario: _TEMPLATE.yaml loads (T2.12 QA follow-up)', () => {
  it('the template parses with the loader, although loadScenarioDir skips it', () => {
    const file = join(here, '..', 'scenarios', '_TEMPLATE.yaml')
    const template = parseScenario(readFileSync(file, 'utf8'), file, engine)
    expect(template.id).toBe('00-template')
    expect(template.review.keySignalAsk).toBeDefined()
    expect(template.referencePath.some((s) => s.type === 'act' && s.action.kind === 'declareMitigated')).toBe(false)
  })
})

describe('parseScenario: CN-4 error cases', () => {
  it('missing required field: names the file and the field', () => {
    const error = errorOf(fixture('missing-title.yaml'), 'fixtures/missing-title.yaml')
    expect(error.file).toBe('fixtures/missing-title.yaml')
    expect(error.field).toBe('title')
    expect(error.engine).toBeUndefined()
    expect(error.message).toBe('fixtures/missing-title.yaml: title: is required')
  })

  it.each([
    ['id'],
    ['title'],
    ['level'],
    ['teaches'],
    ['trap'],
    ['seed'],
    ['faults'],
    ['alert'],
    ['impactBudget'],
    ['referencePath'],
    ['rootCause'],
    ['review'],
  ])('missing %s (required by SPEC §7 / CN-1)', (key) => {
    const error = errorOf(edited((d) => delete d[key]), 'scenarios/case.yaml')
    expect(error.field).toBe(key)
    expect(error.message).toBe(`scenarios/case.yaml: ${key}: is required`)
  })

  it.each([
    ['alert', 'tick', 'alert.tick'],
    ['alert', 'text', 'alert.text'],
    ['review', 'redundant', 'review.redundant'],
    ['review', 'keySignal', 'review.keySignal'],
  ])('missing %s.%s', (parent, key, field) => {
    const error = errorOf(edited((d) => delete (d[parent] as Record<string, unknown>)[key]))
    expect(error.field).toBe(field)
    expect(error.message).toContain(`${field}: is required`)
  })

  it('missing review.keySignalAsk (ADR-014 §2, required in phase 2)', () => {
    const error = errorOf(fixture('missing-key-signal-ask.yaml'), 'fixtures/missing-key-signal-ask.yaml')
    expect(error.field).toBe('review.keySignalAsk')
    expect(error.message).toBe('fixtures/missing-key-signal-ask.yaml: review.keySignalAsk: is required')
  })

  it.each([
    ['bad-fault-kind.yaml', 'unknown_fault_kind', 'faults[0].kind'],
    ['bad-fault-target.yaml', 'unknown_target', 'faults[0].target'],
    ['bad-fault-param.yaml', 'param_out_of_range', 'faults[0].params.uptimeTicks'],
    ['bad-noise-target.yaml', 'invalid_noise', 'noise[0].target'],
  ])('%s: propagates the EngineError intact (F-7)', (name, code, field) => {
    const file = `fixtures/${name}`
    const error = errorOf(fixture(name), file)
    expect(error.engine).toBeInstanceOf(EngineError)
    expect(error.engine?.code).toBe(code)
    expect(error.engine?.field).toBe(field)
    expect(error.field).toBe(field)
    // The engine message names the field already; the loader adds only the file, verbatim otherwise.
    expect(error.engine?.message).toContain(field)
    expect(error.message).toBe(`${file}: ${error.engine?.message}`)
  })

  it('the propagated engine message is exactly what the engine says for the same input', () => {
    const world = createSimulation({ system: defaultShop, seed: 's' }).world
    let direct: unknown
    try {
      resolveFaults([{ kind: 'service_crash_loop', target: 'inventory', startTick: 10, params: { uptimeTicks: 1, restartTicks: 3 } }], world)
    } catch (error) {
      direct = error
    }
    expect(errorOf(fixture('bad-fault-target.yaml')).engine?.message).toBe((direct as EngineError).message)
  })

  it('question pattern with an unknown kind', () => {
    const error = errorOf(fixture('bad-pattern-kind.yaml'), 'fixtures/bad-pattern-kind.yaml')
    expect(error.field).toBe('review.redundant[0]')
    expect(error.message).toMatch(/^fixtures\/bad-pattern-kind\.yaml: review\.redundant\[0\]: unknown question kind 'graph'/)
    expect(error.message).toContain('dashboard, logs, trace, whatChanged, compare, askNpc')
  })

  it('question pattern with an unknown component', () => {
    const error = errorOf(fixture('bad-pattern-component.yaml'), 'fixtures/bad-pattern-component.yaml')
    expect(error.field).toBe('review.keySignalAsk')
    expect(error.message).toMatch(/review\.keySignalAsk: unknown component 'inventory'/)
    expect(error.message).toContain('gateway')
  })

  it('id outside both formats (NN-slug, test-slug)', () => {
    const error = errorOf(fixture('bad-id.yaml'), 'fixtures/bad-id.yaml')
    expect(error.field).toBe('id')
    expect(error.message).toMatch(/^fixtures\/bad-id\.yaml: id: 'loader_fixture' must be "NN-kebab-slug"/)
  })

  it.each([['3-short'], ['03_underscore'], ['03-Upper'], ['test-'], ['tests-x']])('rejects id %s', (id) => {
    expect(errorOf(edited((d) => (d['id'] = id))).field).toBe('id')
  })

  it('unknown system', () => {
    const error = errorOf(fixture('unknown-system.yaml'), 'fixtures/unknown-system.yaml')
    expect(error.field).toBe('system')
    expect(error.message).toBe("fixtures/unknown-system.yaml: system: unknown system 'bank-core' (valid values: default-shop)")
  })
})

describe('parseScenario: other structural errors', () => {
  it.each([
    ['unknown top-level field (typo)', (d: Record<string, unknown>) => (d['refrencePath'] = []), 'refrencePath', /unknown field/],
    ['level outside the enum', (d: Record<string, unknown>) => (d['level'] = 'expert'), 'level', /junior, pleno, senior/],
    ['seed that is not a string', (d: Record<string, unknown>) => (d['seed'] = 42), 'seed', /must be a string/],
    ['empty title', (d: Record<string, unknown>) => (d['title'] = '  '), 'title', /must not be empty/],
    ['impactBudget 0', (d: Record<string, unknown>) => (d['impactBudget'] = 0), 'impactBudget', /integer >= 1/],
    ['negative alert.tick', (d: Record<string, unknown>) => ((d['alert'] as Record<string, unknown>)['tick'] = -1), 'alert.tick', /integer >= 0/],
    ['empty faults', (d: Record<string, unknown>) => (d['faults'] = []), 'faults', /at least 1/],
    ['unknown key in a fault', (d: Record<string, unknown>) => (((d['faults'] as Record<string, unknown>[])[0] ?? {})['startTik'] = 3), 'faults[0].startTik', /unknown field/],
    ['unknown key in noise', (d: Record<string, unknown>) => (((d['noise'] as Record<string, unknown>[])[0] ?? {})['when'] = 3), 'noise[0].when', /unknown field/],
    ['empty referencePath', (d: Record<string, unknown>) => (d['referencePath'] = []), 'referencePath', /at least 1/],
    ['step with ask and act', (d: Record<string, unknown>) => (d['referencePath'] = [{ ask: 'dashboard', act: 'restart' }]), 'referencePath[0]', /exactly one of/],
    ['step with an unknown question', (d: Record<string, unknown>) => (d['referencePath'] = [{ ask: 'graph' }]), 'referencePath[0].ask', /unknown question kind/],
    ['step with an unknown action', (d: Record<string, unknown>) => (d['referencePath'] = [{ act: 'reboot', target: 'catalog' }]), 'referencePath[0].act', /unknown action kind/],
    ['pattern with a component on whatChanged', (d: Record<string, unknown>) => ((d['review'] as Record<string, unknown>)['redundant'] = ['whatChanged catalog']), 'review.redundant[0]', /takes no component/],
  ])('%s', (_name, edit, field, reason) => {
    const error = errorOf(edited(edit))
    expect(error.field).toBe(field)
    expect(error.message).toMatch(reason)
    expect(error.message.startsWith(`scenarios/case.yaml: ${field}: `)).toBe(true)
  })

  it('invalid YAML names the file', () => {
    const error = errorOf('id: [unclosed\n', 'scenarios/broken.yaml')
    expect(error.file).toBe('scenarios/broken.yaml')
    expect(error.message).toMatch(/^scenarios\/broken\.yaml: invalid YAML/)
  })

  it('duplicate keys are invalid YAML', () => {
    expect(errorOf(`${validSource}\nid: 90-again\n`).message).toMatch(/invalid YAML/)
  })

  it('a document that is not a mapping', () => {
    expect(errorOf('- just\n- a list\n').message).toMatch(/must be a mapping/)
  })
})

describe('toSimulationConfig', () => {
  const scenario: Scenario = parseScenario(validSource, 'fixtures/valid.yaml', engine)
  const config = toSimulationConfig(scenario, engine)

  it('has only the engine input keys: system, seed, faults, noise (no scenario text, EN-5)', () => {
    expect(Object.keys(config)).toEqual(['system', 'seed', 'faults', 'noise'])
    expect(config.system).toBe(defaultShop)
    expect(config.seed).toBe(scenario.seed)
    expect(config.faults).toStrictEqual(scenario.faults)
    expect(config.noise).toStrictEqual(scenario.noise)
    const json = JSON.stringify(config)
    for (const text of [scenario.title, scenario.teaches, scenario.trap, scenario.rootCause, scenario.alert.text, scenario.review.keySignal]) {
      expect(json).not.toContain(text)
    }
  })

  it('is accepted by createSimulation and is deterministic', () => {
    const a = createSimulation(config).advance(20)
    const b = createSimulation(toSimulationConfig(scenario, engine)).advance(20)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('throws ScenarioError for a system the runtime does not have', () => {
    expect(() => toSimulationConfig({ ...scenario, system: 'bank-core' }, engine)).toThrow(ScenarioError)
  })
})
