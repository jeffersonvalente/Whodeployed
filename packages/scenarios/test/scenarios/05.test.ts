// T2.16 — scenario 05 (slow_dependency, pleno): CN-1 and CN-2 on the YAML, CN-6 (the alert does
// not arrive before the symptom), CN-7 (the trap exists in the seed's telemetry) and DET.
// The engine runtime is injected from the engine's public entry (ADR-014 §1.1).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accumulatedImpact, createSimulation, defaultShop, resolveFaults, toNdjson } from '@whodeployed/engine'
import type { MetricRecord, TelemetryView } from '@whodeployed/engine'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { inRepertoire, parseScenario, toSimulationConfig } from '../../src/index.js'
import type { EngineRuntime, Scenario } from '../../src/index.js'

const engine: EngineRuntime = { resolveFaults, createSimulation, accumulatedImpact, systems: { 'default-shop': defaultShop } }

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', '..', 'scenarios', '05-orders-failing-slow-db.yaml')
const source = readFileSync(file, 'utf8')
const raw = parse(source) as Record<string, unknown>
const scenario: Scenario = parseScenario(source, file, engine)

// SPEC §7, campaign row 5, column "Ensina" ("Cascata; o culpado não é quem grita"), in English.
const TEACHES_ROW_5 = 'In a cascade, the culprit is not the component that screams'

/** Telemetry of the scenario's seed, simulated up to `upTo` with no player action. */
function telemetryUpTo(upTo: number): TelemetryView {
  const sim = createSimulation(toSimulationConfig(scenario, engine))
  sim.advance(upTo)
  return sim.telemetry()
}

/** Component aggregate metric record (no `instance`) of `component` at `tick`. */
function aggregate(view: TelemetryView, component: string, tick: number): MetricRecord {
  const record = view.metricsOf(component, tick, tick).find((m) => m.instance === undefined)
  if (record === undefined) throw new Error(`no aggregate metric for ${component} at tick ${tick}`)
  return record
}

const fault = scenario.faults[0]
if (fault === undefined) throw new Error('scenario 05 has no fault')
const alertTick = scenario.alert.tick
const components = [...defaultShop.services, ...defaultShop.deps].map((c) => c.name)

describe('scenario 05: fields (CN-1, CN-2)', () => {
  it('is the pleno slow_dependency scenario of campaign row 5 with every phase-2 field', () => {
    expect(scenario.id).toMatch(/^05-/)
    expect(scenario.level).toBe('pleno')
    expect(scenario.teaches).toBe(TEACHES_ROW_5)
    expect(scenario.teaches).not.toMatch(/\band\b/)
    expect(scenario.testIncident).toBe(false)
    for (const key of ['id', 'title', 'level', 'teaches', 'trap', 'seed', 'faults', 'alert', 'referencePath', 'rootCause']) {
      expect(raw[key], key).toBeDefined()
    }
    expect(Number.isInteger(scenario.impactBudget) && scenario.impactBudget >= 1).toBe(true)
    const review = raw['review'] as Record<string, unknown>
    expect(Object.keys(review).sort()).toEqual(['keySignal', 'keySignalAsk', 'redundant'])
  })

  it('declares exactly 1 fault with explicit target, startTick and params in the raw YAML (CN-2)', () => {
    const faults = raw['faults'] as Record<string, unknown>[]
    expect(faults).toHaveLength(1)
    const [only] = faults
    expect(only).toMatchObject({ kind: 'slow_dependency', target: 'postgres', startTick: 10 })
    expect(only?.['params']).toEqual({ addedLatencyMs: 1500 })
  })

  it('has at least 1 noise event (content design rule from scenario #3 on)', () => {
    expect(scenario.noise.length).toBeGreaterThanOrEqual(1)
  })

  it('uses only the pleno repertoire in referencePath (SPEC §5 golden rule; replay is T2.20)', () => {
    for (const step of scenario.referencePath) expect(inRepertoire('pleno', step), JSON.stringify(step)).toBe(true)
  })
})

describe('scenario 05: the alert does not arrive before the symptom (CN-6)', () => {
  it('alert.tick >= the fault startTick', () => {
    expect(alertTick).toBeGreaterThanOrEqual(fault.startTick)
  })

  it('"orders-worker: failed jobs > 20% for 1m" holds in the seed telemetry at alert.tick', () => {
    // 1m = 6 ticks (1 tick = 10 s): the condition holds in each tick of [alert.tick - 5, alert.tick].
    expect(scenario.alert.text).toContain('orders-worker: failed jobs > 20% for 1m')
    const view = telemetryUpTo(alertTick)
    for (let tick = alertTick - 5; tick <= alertTick; tick++) {
      expect(aggregate(view, 'orders-worker', tick).errorPct, `tick ${tick}`).toBeGreaterThan(20)
    }
  })
})

describe('scenario 05: the trap exists in the seed telemetry at alert.tick (CN-7)', () => {
  it('the component with the largest error % increase is not the target, and the target reports 0% errors', () => {
    const view = telemetryUpTo(alertTick)
    const baselineTicks = Array.from({ length: fault.startTick }, (_, tick) => tick)
    const increase = (component: string): number => {
      const baseline =
        baselineTicks.reduce((sum, tick) => sum + aggregate(view, component, tick).errorPct, 0) / baselineTicks.length
      return aggregate(view, component, alertTick).errorPct - baseline
    }
    const ranked = [...components].sort((a, b) => increase(b) - increase(a))
    expect(ranked[0]).not.toBe(fault.target)
    expect(ranked[0]).toBe('orders-worker')
    expect(aggregate(view, 'orders-worker', alertTick).errorPct).toBe(100)
    expect(aggregate(view, fault.target, alertTick).errorPct).toBe(0)
  })

  it('the only change in the whatChanged window is a deploy of the screaming component, not of the target', () => {
    const view = telemetryUpTo(alertTick)
    const events = view.eventsIn(Math.max(0, alertTick - 30), alertTick)
    expect(events.map((e) => [e.kind, e.target])).toEqual([['deploy', 'orders-worker']])
  })
})

describe('scenario 05: determinism (DET)', () => {
  it('the same YAML gives the same Scenario and byte-identical telemetry twice', () => {
    expect(parseScenario(source, file, engine)).toStrictEqual(scenario)
    const horizon = alertTick + 2 * scenario.impactBudget
    expect(toNdjson(telemetryUpTo(horizon).all())).toBe(toNdjson(telemetryUpTo(horizon).all()))
  })
})
