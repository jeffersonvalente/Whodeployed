/**
 * T1.21 — fault `slow_dependency` (ADR-004; PRD F-1, F-2, F-3 row 5, F-4; SPEC §3.3, §3.4).
 *
 * The module only adds latency to the target. The retry storm and the errors in the callers must
 * emerge from the call policy of the traffic generator (timeouts + retries, ADR-002 §5); these
 * tests measure them, they are not produced by the fault.
 *
 * Signature assertions compare window means (ticks startTick+6..startTick+11) over >= 10 seeds
 * against the baseline, never trace-by-trace equality during the fault (ADR-003 §8).
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
import type { Fault, FaultInput, MetricName, MetricRecord, Rng, RngFactory, TelemetryRecord } from '../../src/types.js'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')

const TICKS = 30
const SEEDS = Array.from({ length: 12 }, (_, i) => `slow-dep-${i}`)
const world = buildWorld(defaultShop, 'resolve')
const resolve = (input: Omit<FaultInput, 'kind'> = {}): Fault[] => resolveFaults([{ kind: 'slow_dependency', ...input }], world)

const [DEFAULT] = resolve()
const START = DEFAULT!.startTick
const TARGET = DEFAULT!.target
const WINDOW_TICKS = 6
const inWindow = (tick: number) => tick >= START + 6 && tick <= START + 11

const run = (seed: string, faults: readonly Fault[] = []) => simulate({ system: defaultShop, seed, faults }, TICKS)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const components = [...world.services, ...world.deps].map((c) => c.name)

/** Window mean of one aggregate metric of a component. */
function windowMean(records: readonly TelemetryRecord[], component: string, metric: MetricName): number {
  const values = records
    .filter((r): r is MetricRecord => r.type === 'metric' && r.component === component && r.instance === undefined && inWindow(r.tick))
    .map((r) => r[metric])
  expect(values).toHaveLength(WINDOW_TICKS)
  return mean(values)
}

/** Client spans of callers towards the target in the window, per tick. */
const clientSpansToTarget = (records: readonly TelemetryRecord[], target: string) =>
  records.filter((r) => r.type === 'span' && r.kind === 'client' && r.peer === target && inWindow(r.tick)).length / WINDOW_TICKS

const runs = SEEDS.map((seed) => ({ seed, base: run(seed), fault: run(seed, [DEFAULT!]) }))

describe('slow_dependency — defaults (ADR-004)', () => {
  it('adds 1500 ms to postgres from tick 10', () => {
    expect(DEFAULT).toEqual({ kind: 'slow_dependency', target: 'postgres', startTick: 10, params: { addedLatencyMs: 1500 } })
    expect(faultCatalog.slow_dependency.defaultTarget).toBe('postgres')
  })
})

describe('F-3 row 5 — retry storm after a slow dependency', () => {
  it('p95 of the target >= 3x baseline (every seed and mean)', () => {
    const ratios = runs.map(({ base, fault }) => windowMean(fault, TARGET, 'p95') / windowMean(base, TARGET, 'p95'))
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(3)
    expect(mean(ratios)).toBeGreaterThanOrEqual(3)
  })

  it('client spans of callers towards the target >= 2x baseline (retries)', () => {
    const base = mean(runs.map((r) => clientSpansToTarget(r.base, TARGET)))
    const fault = mean(runs.map((r) => clientSpansToTarget(r.fault, TARGET)))
    expect(fault / base).toBeGreaterThanOrEqual(2)
    for (const r of runs) expect(clientSpansToTarget(r.fault, TARGET), r.seed).toBeGreaterThan(clientSpansToTarget(r.base, TARGET))
  })

  it('the component with the largest absolute error % increase is not the target ("the culprit is not who screams")', () => {
    const increase = (c: string) => mean(runs.map(({ base, fault }) => windowMean(fault, c, 'errorPct') - windowMean(base, c, 'errorPct')))
    const ranked = components.map((c) => ({ c, d: increase(c) })).sort((a, b) => b.d - a.d)
    expect(ranked[0]!.c).not.toBe(TARGET)
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

describe('F-4 — the fault shows outside the target', () => {
  it.each(['gateway', 'payment', 'orders-worker'])('p95 of %s deviates >= 25% vs baseline (window mean over the seeds)', (component) => {
    const base = mean(runs.map((r) => windowMean(r.base, component, 'p95')))
    const fault = mean(runs.map((r) => windowMean(r.fault, component, 'p95')))
    expect(Math.abs(fault - base) / base).toBeGreaterThanOrEqual(0.25)
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
    const p95 = mean(SEEDS.slice(0, 4).map((s) => windowMean(run(s, faults), TARGET, 'p95')))
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
