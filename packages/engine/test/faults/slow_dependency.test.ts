/**
 * T1.21 / T1.35 — fault `slow_dependency` (ADR-004 and its Emenda 2; PRD F-1, F-2, F-3 row 5,
 * F-4; SPEC §3.3, §3.4; DET).
 *
 * The module only adds latency to the target. The retry storm and the errors in the callers must
 * emerge from the call policy of the traffic generator (timeouts + retries, ADR-002 §5); these
 * tests measure them, they are not produced by the fault.
 *
 * Signature assertions follow the seed aggregation rule R1–R5 and the F-4 eligibility rules E1–E4
 * (PRD Emenda 2) through test/support/signature.ts: window means (ticks startTick+6..startTick+11)
 * over the seeds of `signatureSeeds` (replaceable with ENGINE_QA_SEEDS), never trace-by-trace
 * equality against the baseline while the fault is active (ADR-003 §8).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { faultCatalog } from '../../src/faults/catalog.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { slowDependency } from '../../src/faults/slow_dependency.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { toNdjson } from '../../src/sim/serialize.js'
import { simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import { assertEligibleF4, assertPass, effect, signatureSeeds, signatureWindow, windowMean } from '../support/signature.js'
import type { Fault, FaultInput, MetricName, Rng, RngFactory, TelemetryRecord } from '../../src/types.js'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')

const TICKS = 30
/** R1: fixed list `slow-dep-0..11`, replaced by ENGINE_QA_SEEDS when set. */
const SEEDS = signatureSeeds('slow-dep')
const world = buildWorld(defaultShop, 'resolve')
const resolve = (input: Omit<FaultInput, 'kind'> = {}): Fault[] => resolveFaults([{ kind: 'slow_dependency', ...input }], world)

const [DEFAULT] = resolve()
const START = DEFAULT!.startTick
const TARGET = DEFAULT!.target
const WINDOW = signatureWindow(START)
const inWindow = (tick: number) => WINDOW.includes(tick)
/** Fixed F-4 pair (tasks T1.35, recommended): the edge caller, two hops away from the slow dependency. */
const F4_PAIR = { component: 'gateway', metric: 'p95' } as const

const run = (seed: string, faults: readonly Fault[] = []) => simulate({ system: defaultShop, seed, faults }, TICKS)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const components = [...world.services, ...world.deps].map((c) => c.name)

/** Client spans of callers towards the target in the window, per tick (one run). */
const clientSpansToTarget = (records: readonly TelemetryRecord[], target: string) =>
  records.filter((r) => r.type === 'span' && r.kind === 'client' && r.peer === target && inWindow(r.tick)).length / WINDOW.length

const runs = SEEDS.map((seed) => ({ seed, base: run(seed), fault: run(seed, [DEFAULT!]) }))

/** Per-seed window means of one aggregate metric, in seed order (R2/R3 input). */
const series = (component: string, metric: MetricName) => ({
  fault: runs.map((r) => windowMean(r.fault, component, metric, WINDOW)),
  base: runs.map((r) => windowMean(r.base, component, metric, WINDOW)),
})

describe('slow_dependency — defaults (ADR-004)', () => {
  it('adds 1500 ms to postgres from tick 10', () => {
    expect(DEFAULT).toEqual({ kind: 'slow_dependency', target: 'postgres', startTick: 10, params: { addedLatencyMs: 1500 } })
    expect(faultCatalog.slow_dependency.defaultTarget).toBe('postgres')
  })

  it('R1: the seed list has >= 10 distinct seeds', () => {
    expect(new Set(SEEDS).size).toBe(SEEDS.length)
    expect(SEEDS.length).toBeGreaterThanOrEqual(10)
  })
})

describe('F-3 row 5 — retry storm after a slow dependency (R1–R5)', () => {
  it('R2/R3: p95 of the target >= 3x baseline on the mean and >= 2.5x in every seed', () => {
    const { fault, base } = series(TARGET, 'p95')
    assertPass(effect(fault, base, { ratioAtLeast: 3 }, SEEDS), `p95 of ${TARGET}`)
  })

  it('R2/R3: client spans of callers towards the target >= 2x baseline on the mean and >= 1.75x in every seed (retries)', () => {
    const fault = runs.map((r) => clientSpansToTarget(r.fault, TARGET))
    const base = runs.map((r) => clientSpansToTarget(r.base, TARGET))
    assertPass(effect(fault, base, { ratioAtLeast: 2 }, SEEDS), `client spans towards ${TARGET}`)
  })

  it('R5: the component with the largest absolute error % increase (on the mean over seeds) is not the target ("the culprit is not who screams")', () => {
    const increase = (c: string) => {
      const { fault, base } = series(c, 'errorPct')
      return mean(fault) - mean(base)
    }
    const ranked = components.map((c) => ({ c, d: increase(c) })).sort((a, b) => b.d - a.d)
    expect(ranked[0]!.c, JSON.stringify(ranked)).not.toBe(TARGET)
    expect(ranked[0]!.d).toBeGreaterThan(0)
    expect(increase(TARGET)).toBe(0)
  })

  it('the target itself never logs an error: its cut spans are cancellations, not failures', () => {
    for (const { fault } of runs.slice(0, 4)) {
      expect(fault.some((r) => r.type === 'log' && r.level === 'error' && r.component === TARGET)).toBe(false)
      expect(fault.some((r) => r.type === 'span' && r.component === TARGET && r.status === 'error')).toBe(false)
    }
  })

  it('the callers time out and retry: attempt > 0 timeouts appear in their error logs', () => {
    const logs = runs[0]!.fault.filter((r) => r.type === 'log' && r.message === 'upstream timeout' && r.tick >= START)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.some((l) => l.type === 'log' && l.attrs?.['attempt'] === 1)).toBe(true)
    expect(runs[0]!.base.some((r) => r.type === 'log' && r.message === 'upstream timeout')).toBe(false)
  })
})

describe('F-4 — the fault shows outside the target (E1–E4, fixed pair)', () => {
  it(`(${F4_PAIR.component}, ${F4_PAIR.metric}) is an eligible indirect signal in every seed`, () => {
    const result = assertEligibleF4(
      F4_PAIR,
      runs.map((r) => r.base),
      runs.map((r) => r.fault),
      TARGET,
      { window: WINDOW, seeds: SEEDS },
    )
    expect(result.direction).toBe('rise')
    expect(result.result.pass).toBe(true)
  })
})

describe('F-2 — invisible before startTick', () => {
  it.each(SEEDS.slice(0, 4))('records with tick < startTick are byte-identical to the baseline (seed %s)', (seed) => {
    const { base, fault } = runs.find((r) => r.seed === seed)!
    const before = (records: readonly TelemetryRecord[]) => toNdjson(records.filter((r) => r.tick < START))
    expect(before(fault)).toBe(before(base))
    expect(toNdjson(fault)).not.toBe(toNdjson(base))
  })
})

describe('parameters and targets', () => {
  it('a smaller addedLatencyMs (below every timeout) slows callers without a retry storm', () => {
    const faults = resolve({ params: { addedLatencyMs: 50 } })
    const base = mean(SEEDS.slice(0, 4).map((s) => clientSpansToTarget(run(s), TARGET)))
    const fault = mean(SEEDS.slice(0, 4).map((s) => clientSpansToTarget(run(s, faults), TARGET)))
    expect(fault / base).toBeLessThan(1.1)
    const p95 = mean(SEEDS.slice(0, 4).map((s) => windowMean(run(s, faults), TARGET, 'p95', WINDOW)))
    expect(p95).toBeGreaterThan(50)
  })

  it('a service target (catalog) makes gateway time out and retry it', () => {
    const faults = resolve({ target: 'catalog', params: { addedLatencyMs: 2000 } })
    const base = mean(SEEDS.slice(0, 4).map((s) => clientSpansToTarget(run(s), 'catalog')))
    const fault = mean(SEEDS.slice(0, 4).map((s) => clientSpansToTarget(run(s, faults), 'catalog')))
    expect(fault / base).toBeGreaterThanOrEqual(1.9)
  })
})

describe('module', () => {
  /** A factory whose streams throw: the fault must not consume randomness. */
  const noRng: RngFactory = () => {
    const fail = (): never => {
      throw new Error('slow_dependency must not draw')
    }
    return { next: fail, int: fail, chance: fail, pick: fail } as Rng
  }

  it('onServe adds latency only to the target and never fails; no other hook', () => {
    const hooks = slowDependency.activate(DEFAULT!, world, noRng)
    expect(Object.keys(hooks)).toEqual(['onServe'])
    const ctx = { tick: START, instance: 'x', operation: 'op', traceId: 't' }
    expect(hooks.onServe!({ ...ctx, component: TARGET })).toEqual({ addLatencyMs: 1500 })
    expect(hooks.onServe!({ ...ctx, component: 'auth' })).toBeUndefined()
  })

  it('is a pure function of the fault (same input => same effects)', () => {
    const a = slowDependency.activate(DEFAULT!, world, createRngFactory('a'))
    const b = slowDependency.activate(DEFAULT!, world, createRngFactory('b'))
    const ctx = { tick: START, component: TARGET, instance: 'postgres-0', operation: 'db.query', traceId: 't' }
    expect(a.onServe!(ctx)).toEqual(b.onServe!(ctx))
  })
})

describe('coherence and determinism with the fault active', () => {
  it('verify-coherence.mjs accepts the NDJSON (P-1/P-2/P-3/S-3)', () => {
    for (const seed of ['coh-0', 'coh-1']) {
      const r = spawnSync(process.execPath, [verifier], {
        input: toNdjson(simulate({ system: defaultShop, seed, faults: [DEFAULT!] }, 60)),
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      })
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    }
  })

  it('DET: two runs with the same seed give the same NDJSON hash; different seeds differ', () => {
    const a = sha(toNdjson(run('det', [DEFAULT!])))
    expect(sha(toNdjson(run('det', [DEFAULT!])))).toBe(a)
    expect(sha(toNdjson(run('det-2', [DEFAULT!])))).not.toBe(a)
  })
})
