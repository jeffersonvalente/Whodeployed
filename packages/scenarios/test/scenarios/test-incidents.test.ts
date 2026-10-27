// T2.17 — test incidents TA and TB (FASE-2 CN-1, CN-2, CN-3 fields, CN-6, CN-7, CN-9 (a)–(e) and (g), DET).
//
// Every value about an incident (ids, targets, ticks, noise, texts) is read from the YAML files: no
// scenario string is written here (SPEC §3.7). The per-incident numbers below are the conditions the
// alert text and the trap claim, checked against the telemetry of the YAML's own seed.
//
// Not here (T2.20, replay): CN-5 (repertoire + effective mitigation < budget), CN-3 "effective
// mitigation before 50% of impactBudget", CN-9 (f) and EN-6 (b). They need `rollback` (T2.4) and
// `checkMitigations` (T2.13).
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accumulatedImpact, createSimulation, defaultShop, resolveFaults, toNdjson } from '@whodeployed/engine'
import type { ComponentName, EventRecord, MetricRecord, Simulation } from '@whodeployed/engine'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { parseScenario, toSimulationConfig } from '../../src/index.js'
import type { EngineRuntime, ReferenceStep, Scenario } from '../../src/index.js'
import { loadScenarioDir, loadScenarioFile } from '../../src/node.js'

const engine: EngineRuntime = { resolveFaults, createSimulation, accumulatedImpact, systems: { 'default-shop': defaultShop } }

const here = dirname(fileURLToPath(import.meta.url))
const scenariosDir = join(here, '..', '..', 'scenarios')

const TA_FILE = 'test-a-edge-5xx.yaml'
const TB_FILE = 'test-b-intermittent-5xx.yaml'

/** Kinds played in the campaign of this phase (01, 03, 05): a test incident never uses them (CN-3). */
const CAMPAIGN_KINDS = ['service_crash_loop', 'connection_pool_exhaustion', 'slow_dependency']

/** The whatChanged window of the Pleno repertoire, in ticks (ADR-014 §3; QA note on PR #81). */
const WHAT_CHANGED_WINDOW = 30

const COMPONENTS: readonly ComponentName[] = [...defaultShop.services, ...defaultShop.deps].map((c) => c.name)

/**
 * The condition each alert text states, checked on the aggregate errorPct of the alerting component
 * in the ticks [alert.tick - 5, alert.tick] (1m = 6 ticks, ADR-006).
 *  - every: each of the 6 ticks is above the threshold ("> X% for 1m").
 *  - mean:  the mean of the 6 ticks is above the threshold ("above X% over the last 1m").
 */
const alertConditions: Record<string, { mode: 'every' | 'mean'; thresholdPct: number }> = {
  [TA_FILE]: { mode: 'every', thresholdPct: 10 },
  [TB_FILE]: { mode: 'mean', thresholdPct: 5 },
}

const files = [TA_FILE, TB_FILE] as const

const raw = (file: string): Record<string, unknown> =>
  parse(readFileSync(join(scenariosDir, file), 'utf8')) as Record<string, unknown>

const load = (file: string): Scenario => loadScenarioFile(join(scenariosDir, file), engine)

const ta = load(TA_FILE)
const tb = load(TB_FILE)
const incidents: Record<string, Scenario> = { [TA_FILE]: ta, [TB_FILE]: tb }

/** A fresh simulation of the scenario, advanced to `tick`. */
function simulateTo(scenario: Scenario, tick: number): Simulation {
  const sim = engine.createSimulation(toSimulationConfig(scenario, engine))
  sim.advance(tick)
  return sim
}

const fault = (s: Scenario) => {
  expect(s.faults).toHaveLength(1)
  return s.faults[0]!
}

/** Components named as whole words in a text (e.g. "service=gateway"). */
const componentsIn = (text: string): ComponentName[] =>
  COMPONENTS.filter((c) => new RegExp(`(^|[^a-z0-9-])${c}([^a-z0-9-]|$)`, 'i').test(text))

/** The one component the alert text names (CN-9 e). */
function alertComponent(s: Scenario): ComponentName {
  const named = componentsIn(s.alert.text)
  expect(named).toHaveLength(1)
  return named[0]!
}

const isSignalQuestion = (step: ReferenceStep): boolean =>
  step.type === 'ask' && step.question.kind !== 'whatChanged'

/** Shape of a reference path (CN-9 c): steps by type and the mitigation action kind. */
function pathShape(s: Scenario) {
  const asks = s.referencePath.filter((step) => step.type === 'ask')
  const acts = s.referencePath.filter((step) => step.type === 'act')
  return {
    steps: s.referencePath.length,
    whatChanged: asks.filter((step) => step.type === 'ask' && step.question.kind === 'whatChanged').length,
    signal: asks.filter(isSignalQuestion).length,
    actions: acts.length,
    actionKinds: acts.map((step) => (step.type === 'act' ? step.action.kind : '')),
  }
}

/** Set S of R-2: {fault target} ∪ {component of the first signal question of referencePath} (CN-9 g). */
function setS(s: Scenario): Set<string> {
  const first = s.referencePath.find(isSignalQuestion)
  expect(first).toBeDefined()
  const service = first!.type === 'ask' && 'service' in first!.question ? first!.question.service : undefined
  expect(service).toBeDefined()
  return new Set([fault(s).target, service!])
}

const noiseKeys = (s: Scenario): string => JSON.stringify(s.noise.map((n) => ({ kind: n.kind, target: n.target, tick: n.tick })))

/** The newest event of the whatChanged window at the alert (the decoy of the trap). */
function newestChange(s: Scenario): { events: EventRecord[]; newest: EventRecord } {
  const sim = simulateTo(s, s.alert.tick)
  const answer = sim.ask({ kind: 'whatChanged', window: WHAT_CHANGED_WINDOW })
  if (answer.data.kind !== 'whatChanged') throw new Error('unexpected signal')
  const events = answer.data.events
  const newest = events.reduce((a, b) => (b.tick >= a.tick ? b : a))
  return { events, newest }
}

const aggregate = (records: readonly Readonly<MetricRecord>[]): Readonly<MetricRecord>[] =>
  records.filter((r) => r.instance === undefined)

describe('TA and TB load as test incidents (CN-1, CN-2, CN-3 id and level)', () => {
  it.each(files)('%s: loads with every SPEC §7 field plus impactBudget and review (CN-1)', (file) => {
    const s = incidents[file]!
    for (const text of [s.id, s.title, s.teaches, s.trap, s.seed, s.rootCause, s.alert.text, s.review.keySignal]) {
      expect(text.trim().length).toBeGreaterThan(0)
    }
    expect(Number.isInteger(s.impactBudget) && s.impactBudget >= 1).toBe(true)
    expect(s.referencePath.length).toBeGreaterThan(0)
    expect(s.review.redundant.length).toBeGreaterThan(0)
    expect(s.system).toBe('default-shop')
  })

  it.each(files)('%s: id test-*, testIncident, level pleno, file name = id (CN-3)', (file) => {
    const s = incidents[file]!
    expect(s.id).toMatch(/^test-[a-z0-9-]+$/)
    expect(s.id).not.toMatch(/^0[1-8]-/)
    expect(s.testIncident).toBe(true)
    expect(s.level).toBe('pleno')
    expect(`${s.id}.yaml`).toBe(file)
  })

  it.each(files)('%s: raw YAML has exactly 1 fault with explicit target, startTick and params (CN-2)', (file) => {
    const faults = raw(file)['faults'] as Record<string, unknown>[]
    expect(faults).toHaveLength(1)
    expect(Object.keys(faults[0]!).sort()).toEqual(['kind', 'params', 'startTick', 'target'])
    expect(typeof faults[0]!['target']).toBe('string')
    expect(Number.isInteger(faults[0]!['startTick'])).toBe(true)
    const params = faults[0]!['params'] as Record<string, unknown>
    // Every parameter of the kind is written out: nothing comes from the catalog default (ADR-004).
    const resolved = fault(incidents[file]!)
    expect(Object.keys(params).sort()).toEqual(Object.keys(resolved.params).sort())
  })

  it.each(files)('%s: teaches is one sentence without "and" (one lesson per scenario)', (file) => {
    const s = incidents[file]!
    expect(s.teaches).not.toMatch(/\band\b/i)
    expect(s.teaches.replace(/\.$/, '')).not.toMatch(/[.!?;]/)
  })
})

describe('CN-3: unseen and distinct from the campaign and from each other', () => {
  const campaign = loadScenarioDir(scenariosDir, engine).filter((s) => !s.testIncident)

  it('the directory has exactly these two test incidents', () => {
    const tests = loadScenarioDir(scenariosDir, engine).filter((s) => s.testIncident)
    expect(tests.map((s) => s.id)).toEqual([ta.id, tb.id])
  })

  it.each(files)('%s: fault kind is not one played in the campaign (01, 03, 05)', (file) => {
    const kind = fault(incidents[file]!).kind
    expect(CAMPAIGN_KINDS).not.toContain(kind)
    for (const c of campaign) for (const f of c.faults) expect(f.kind).not.toBe(kind)
  })

  it('TA and TB differ in kind or target', () => {
    const [a, b] = [fault(ta), fault(tb)]
    expect(a.kind !== b.kind || a.target !== b.target).toBe(true)
  })

  it('seed, title and alert.text differ between TA and TB and from every campaign scenario', () => {
    for (const key of ['seed', 'title'] as const) expect(ta[key]).not.toBe(tb[key])
    expect(ta.alert.text).not.toBe(tb.alert.text)
    for (const c of campaign) {
      for (const t of [ta, tb]) {
        expect(t.seed).not.toBe(c.seed)
        expect(t.title).not.toBe(c.title)
        expect(t.alert.text).not.toBe(c.alert.text)
        expect(t.teaches).not.toBe(c.teaches)
        expect(fault(t).target).not.toBe(c.faults[0]?.target)
      }
    }
  })

  it('noise has >= 1 event and the {kind, target, tick} lists differ between all scenarios', () => {
    expect(ta.noise.length).toBeGreaterThanOrEqual(1)
    expect(tb.noise.length).toBeGreaterThanOrEqual(1)
    expect(noiseKeys(ta)).not.toBe(noiseKeys(tb))
    for (const c of campaign) {
      expect(noiseKeys(ta)).not.toBe(noiseKeys(c))
      expect(noiseKeys(tb)).not.toBe(noiseKeys(c))
    }
  })

  it.each(files)(
    '%s: whatChanged at alert.tick (window 30) has >= 1 deploy/config event in [alert.tick - 30, alert.tick]',
    (file) => {
      const s = incidents[file]!
      const { events } = newestChange(s)
      const inWindow = events.filter((e) => e.tick >= s.alert.tick - WHAT_CHANGED_WINDOW && e.tick <= s.alert.tick)
      expect(inWindow.length).toBeGreaterThanOrEqual(1)
      // The fault's own deploy is inside the window, so "what changed?" can find the cause.
      const f = fault(s)
      expect(f.startTick).toBeGreaterThanOrEqual(s.alert.tick - WHAT_CHANGED_WINDOW)
      expect(inWindow.some((e) => e.kind === 'deploy' && e.target === f.target && e.tick === f.startTick)).toBe(true)
    },
  )

  it.each(files)('%s: no noise deploy on the target after the fault, so the first rollback reverts the fault (ADR-012 §4)', (file) => {
    const s = incidents[file]!
    const f = fault(s)
    expect(s.noise.filter((n) => n.kind === 'deploy' && n.target === f.target && n.tick >= f.startTick)).toEqual([])
  })
})

describe('noise notes and player-facing texts do not give the answer', () => {
  it.each(files)('%s: title, alert.text and noise notes never name the fault target', (file) => {
    const s = incidents[file]!
    const target = fault(s).target
    for (const text of [s.title, s.alert.text, ...s.noise.map((n) => n.note ?? '')]) {
      expect(componentsIn(text)).not.toContain(target)
    }
  })

  it.each(files)('%s: noise notes carry no verdict (they are printed verbatim by whatChanged)', (file) => {
    for (const n of incidents[file]!.noise) {
      expect(n.note).toBeDefined()
      expect(n.note).not.toMatch(/harmless|safe|unrelated|no[- ]?op|culprit|broken|bug|cause|root|ignore|fine/i)
    }
  })
})

describe('CN-9: TA and TB are equivalent in difficulty — fields (a)–(e) and (g)', () => {
  it('(a) same level (pleno) and exactly one fault each', () => {
    expect(ta.level).toBe('pleno')
    expect(tb.level).toBe(ta.level)
    expect(ta.faults).toHaveLength(1)
    expect(tb.faults).toHaveLength(1)
  })

  it('(b) same impactBudget', () => {
    expect(tb.impactBudget).toBe(ta.impactBudget)
  })

  it('(c) referencePath with the same number of steps, count per type and mitigation action kind', () => {
    expect(pathShape(tb)).toEqual(pathShape(ta))
    expect(pathShape(ta).actions).toBeGreaterThanOrEqual(1)
  })

  it('(c) whatChanged comes first and the mitigation acts on the fault target (SPEC §2 outcome 1)', () => {
    for (const s of [ta, tb]) {
      const first = s.referencePath[0]!
      expect(first.type === 'ask' && first.question.kind === 'whatChanged').toBe(true)
      const acts = s.referencePath.filter((step) => step.type === 'act')
      expect(acts.map((step) => (step.type === 'act' ? step.action.target : undefined))).toEqual([fault(s).target])
    }
  })

  it('(d) same number of noise events', () => {
    expect(tb.noise.length).toBe(ta.noise.length)
  })

  it('(e) the component named in alert.text is the target in both or in neither', () => {
    const roleA = alertComponent(ta) === fault(ta).target
    const roleB = alertComponent(tb) === fault(tb).target
    expect(roleB).toBe(roleA)
  })

  it('(g) the set S of R-2 has the same size in both', () => {
    expect(setS(tb).size).toBe(setS(ta).size)
  })
})

describe('CN-6: the alert does not fire before the symptom', () => {
  it.each(files)('%s: alert.tick >= startTick and the alert condition holds at alert.tick', (file) => {
    const s = incidents[file]!
    expect(s.alert.tick).toBeGreaterThanOrEqual(fault(s).startTick)
    const { mode, thresholdPct } = alertConditions[file]!
    // The number checked below is the one the alert text states.
    expect(s.alert.text).toMatch(new RegExp(`(^|[^0-9.])${thresholdPct}%`))
    const view = simulateTo(s, s.alert.tick).telemetry()
    const series = aggregate(view.metricsOf(alertComponent(s), s.alert.tick - 5, s.alert.tick)).map((r) => r.errorPct)
    expect(series).toHaveLength(6)
    if (mode === 'every') {
      for (const value of series) expect(value).toBeGreaterThan(thresholdPct)
    } else {
      expect(series.reduce((a, b) => a + b, 0) / series.length).toBeGreaterThan(thresholdPct)
    }
    // Before the fault the condition does not hold: the alert is about this incident.
    const before = aggregate(view.metricsOf(alertComponent(s), 0, fault(s).startTick - 1)).map((r) => r.errorPct)
    expect(Math.max(...before)).toBeLessThanOrEqual(thresholdPct)
  })
})

describe('CN-7: the trap exists in the telemetry of the seed (SPEC §3.4)', () => {
  it.each(files)(
    '%s: the newest change at the alert is a noise event on another component, while the errors started earlier, at the fault deploy',
    (file) => {
      const s = incidents[file]!
      const f = fault(s)
      const { newest } = newestChange(s)
      // The decoy: newest change in the window, not on the target, and it is one of the YAML's noise events.
      expect(newest.target).not.toBe(f.target)
      expect(newest.tick).toBeGreaterThan(f.startTick)
      expect(s.noise.some((n) => n.kind === newest.kind && n.target === newest.target && n.tick === newest.tick)).toBe(true)
      // The errors seen at the alerting component predate the decoy: they start at the fault deploy.
      const view = simulateTo(s, s.alert.tick).telemetry()
      const alerting = alertComponent(s)
      const between = aggregate(view.metricsOf(alerting, f.startTick, newest.tick - 1))
      expect(between.length).toBeGreaterThanOrEqual(1)
      for (const r of between) expect(r.errorPct).toBeGreaterThan(0)
      // Split by instance, the target shows the partial release: the deployed instances fail, the others do not.
      const deployed = new Set(
        view.eventsIn(f.startTick, f.startTick).filter((e) => e.kind === 'deploy' && e.target === f.target).map((e) => e.instance),
      )
      expect(deployed.size).toBe(f.params['affectedInstances'])
      const perInstance = view.metricsOf(f.target, f.startTick, s.alert.tick).filter((r) => r.instance !== undefined)
      const mean = (instance: string) => {
        const values = perInstance.filter((r) => r.instance === instance).map((r) => r.errorPct)
        return values.reduce((a, b) => a + b, 0) / values.length
      }
      const instances = [...new Set(perInstance.map((r) => r.instance!))]
      for (const instance of instances) {
        if (deployed.has(instance)) expect(mean(instance)).toBeGreaterThan(50)
        else expect(mean(instance)).toBe(0)
      }
    },
  )
})

describe('DET: same input, same output', () => {
  it.each(files)('%s: parsing twice gives toStrictEqual scenarios', (file) => {
    const source = readFileSync(join(scenariosDir, file), 'utf8')
    expect(parseScenario(source, file, engine)).toStrictEqual(parseScenario(source, file, engine))
  })

  it.each(files)('%s: the seed gives byte-identical telemetry twice', (file) => {
    const s = incidents[file]!
    const run = () => toNdjson(simulateTo(s, s.alert.tick + 30).telemetry().all())
    expect(run()).toBe(run())
  })
})

// Kept next to the files they check so a reader sees the whole list of test incidents at once.
describe('test incidents in the directory', () => {
  it('every test-*.yaml in scenarios/ is covered by this file', () => {
    const names = readdirSync(scenariosDir).filter((n) => n.startsWith('test-')).sort()
    expect(names).toEqual([...files].sort())
  })
})
