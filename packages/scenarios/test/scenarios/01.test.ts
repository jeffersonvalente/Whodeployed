// T2.14 — scenario 01 (service_crash_loop, junior): FASE-2 CN-1, CN-2, CN-6, CN-7, DET.
// Every assertion reads the telemetry through the same calls the player makes (Simulation.ask at
// alert.tick), with the scenario's own seed. The effective-mitigation replay of the referencePath
// (CN-5, EN-6b) is T2.20's suite, with checkMitigations (ADR-014 §3.1: one implementation).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accumulatedImpact, createSimulation, defaultShop, resolveFaults, toNdjson } from '@whodeployed/engine'
import type { DashboardSignal, LogsSignal, Simulation } from '@whodeployed/engine'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { inRepertoire, toSimulationConfig } from '../../src/index.js'
import type { EngineRuntime, Scenario } from '../../src/index.js'
import { loadScenarioFile } from '../../src/node.js'

const engine: EngineRuntime = { resolveFaults, createSimulation, accumulatedImpact, systems: { 'default-shop': defaultShop } }

const here = dirname(fileURLToPath(import.meta.url))
const FILE = join(here, '..', '..', 'scenarios', '01-cart-crash-loop.yaml')
const scenario: Scenario = loadScenarioFile(FILE, engine)

/** The SPEC §7 "Ensina" column, row 1, in the game's language (CN-1). */
const SPEC_ROW_1_TEACHES = 'Read the alert and the right log first'

/** The condition of alert.text: gateway 5xx ratio > 5% for 2m (12 ticks of 10 s, ADR-006). */
const ALERT_THRESHOLD_PCT = 5
const ALERT_FOR_TICKS = 12

/** A fresh simulation of the scenario at alert.tick, as the session starts it (PR-5, ADR-015). */
function atAlert(): Simulation {
  const sim = createSimulation(toSimulationConfig(scenario, engine))
  sim.advance(scenario.alert.tick)
  return sim
}

function dashboard(sim: Simulation, service: string): DashboardSignal {
  const { data } = sim.ask({ kind: 'dashboard', service })
  if (data.kind !== 'dashboard') throw new Error('expected a dashboard signal')
  return data
}

function logs(sim: Simulation, service: string): LogsSignal {
  const { data } = sim.ask({ kind: 'logs', service, window: 30 })
  if (data.kind !== 'logs') throw new Error('expected a logs signal')
  return data
}

const fault = scenario.faults[0]
if (fault === undefined) throw new Error('scenario 01 has no fault')

describe('scenario 01: fields (CN-1, CN-2)', () => {
  it('is campaign scenario 01, junior, service_crash_loop, with the SPEC §7 row-1 lesson (CN-1)', () => {
    expect(scenario.id).toMatch(/^01-[a-z0-9-]+$/)
    expect(scenario.testIncident).toBe(false)
    expect(scenario.level).toBe('junior')
    expect(scenario.system).toBe('default-shop')
    expect(fault.kind).toBe('service_crash_loop')
    expect(scenario.teaches).toBe(SPEC_ROW_1_TEACHES)
    for (const text of [scenario.title, scenario.trap, scenario.seed, scenario.rootCause, scenario.alert.text, scenario.review.keySignal]) {
      expect(text.trim().length).toBeGreaterThan(0)
    }
    expect(Number.isInteger(scenario.impactBudget) && scenario.impactBudget >= 1).toBe(true)
    expect(scenario.referencePath.length).toBeGreaterThan(0)
    expect(scenario.review.keySignalAsk).toEqual({ kind: 'logs', service: fault.target })
  })

  it('declares exactly one fault with target, startTick and params written out, no catalog default (CN-2)', () => {
    const raw = parse(readFileSync(FILE, 'utf8')) as { faults: Record<string, unknown>[] }
    expect(raw.faults).toHaveLength(1)
    const [rawFault] = raw.faults
    expect(rawFault).toBeDefined()
    expect(Object.keys(rawFault ?? {}).sort()).toEqual(['kind', 'params', 'startTick', 'target'])
    expect(Object.keys((rawFault?.['params'] ?? {}) as object).sort()).toEqual(['restartTicks', 'uptimeTicks'])
    expect(scenario.faults).toHaveLength(1)
  })

  it('has a referencePath made only of junior questions and actions (SPEC §5 golden rule)', () => {
    for (const step of scenario.referencePath) expect(inRepertoire('junior', step)).toBe(true)
    // The lesson: logs before anything else, and the mitigation acts on the crashing service.
    expect(scenario.referencePath[0]).toEqual({ type: 'ask', question: { kind: 'logs', service: 'gateway', window: 30 } })
    expect(scenario.referencePath.at(-1)).toEqual({ type: 'act', action: { kind: 'restart', target: fault.target } })
  })
})

describe('scenario 01: the alert does not fire before the symptom (CN-6)', () => {
  it('fires at or after the fault starts', () => {
    expect(scenario.alert.tick).toBeGreaterThanOrEqual(fault.startTick)
    expect(scenario.alert.tick - fault.startTick).toBeGreaterThanOrEqual(ALERT_FOR_TICKS)
  })

  it('at alert.tick, the gateway 5xx ratio has been > 5% in each of the last 2 minutes of ticks', () => {
    const sim = atAlert()
    const board = dashboard(sim, 'gateway')
    expect(board.to).toBe(scenario.alert.tick)
    const window = board.records.filter((r) => r.tick > scenario.alert.tick - ALERT_FOR_TICKS)
    expect(window).toHaveLength(ALERT_FOR_TICKS)
    for (const record of window) expect(record.errorPct).toBeGreaterThan(ALERT_THRESHOLD_PCT)
  })
})

describe('scenario 01: the trap holds (CN-7, SPEC §3.4)', () => {
  it('at alert.tick, the cart dashboard shows 0% errors on every tick while the gateway, its caller, returns 5xx', () => {
    const sim = atAlert()
    const cart = dashboard(sim, fault.target)
    expect(cart.to).toBe(scenario.alert.tick)
    expect(cart.records.length).toBeGreaterThan(0)
    for (const record of cart.records) expect(record.errorPct).toBe(0)
    const gateway = dashboard(sim, 'gateway').records.at(-1)
    expect(gateway?.errorPct).toBeGreaterThan(ALERT_THRESHOLD_PCT)
  })

  it('the right logs carry the answer: gateway errors name only cart, and cart logs show every instance exiting', () => {
    const sim = atAlert()
    // The gateway log points at the upstream that refuses connections, and only at it.
    const gatewayErrors = logs(sim, 'gateway').entries.filter((e) => e.level === 'error')
    expect(gatewayErrors.length).toBeGreaterThan(0)
    const named = new Set(gatewayErrors.map((e) => String(e.attrs?.['upstream'] ?? e.attrs?.['peer'])))
    expect([...named]).toEqual([fault.target])

    // review.keySignal: every cart instance logs 'process exited', one exit code, restartCount climbing.
    const exits = logs(sim, fault.target).entries.filter((e) => e.message === 'process exited')
    const instances = sim.world.services.find((s) => s.name === fault.target)?.instances ?? []
    expect(instances.length).toBeGreaterThan(1)
    expect(new Set(exits.map((e) => e.instance))).toEqual(new Set(instances))
    expect(new Set(exits.map((e) => e.attrs?.['exitCode'])).size).toBe(1)
    for (const instance of instances) {
      const counts = exits.filter((e) => e.instance === instance).map((e) => Number(e.attrs?.['restartCount']))
      expect(counts.at(-1)).toBeGreaterThan(counts[0] ?? Infinity)
    }
  })
})

describe('scenario 01: determinism (DET, SPEC §3.3)', () => {
  it('the same YAML gives the same Scenario and byte-identical telemetry twice', () => {
    expect(loadScenarioFile(FILE, engine)).toStrictEqual(scenario)
    const run = (): string => {
      const sim = createSimulation(toSimulationConfig(scenario, engine))
      sim.advance(scenario.alert.tick + 2 * scenario.impactBudget)
      return toNdjson(sim.telemetry().all())
    }
    expect(run()).toBe(run())
  })
})
