/**
 * T1.19 / T1.37 — fault `connection_pool_exhaustion` (ADR-004 and its Emenda 2; PRD F-1, F-2,
 * F-3 row 3, F-4, F-6 with `service_crash_loop`; DET).
 *
 * Signature assertions follow the seed aggregation rule R1–R5 and the F-4 eligibility rules
 * E1–E4 (PRD Emenda 2) through test/support/signature.ts: window means over the seeds of
 * `signatureSeeds` (replaceable with ENGINE_QA_SEEDS), never per-trace or per-instance equality
 * against the baseline while the fault is active (ADR-003 §8). The trace clause of F-3 row 3 is
 * checked through the real `trace` question handler, i.e. on the trace a player would get for
 * `trace payment p95`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { faultCatalog } from '../../src/faults/catalog.js'
import {
  ACQUIRE_OPERATION,
  POOL_TIMEOUT,
  RECLAIM_MAX,
  RECLAIM_MIN,
  connectionPoolExhaustion,
  leakedAt,
} from '../../src/faults/connection_pool_exhaustion.js'
import { faultRegistry } from '../../src/faults/registry.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { trace } from '../../src/questions/trace.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { serializeRecord, toNdjson } from '../../src/sim/serialize.js'
import { createSimulation, simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import { assertEligibleF4, assertPass, ceiling, effect, everySeed, signatureSeeds, signatureWindow, windowMean } from '../support/signature.js'
import type { CallContext, FaultInput, LogRecord, MetricName, MetricRecord, SpanRecord, TelemetryRecord } from '../../src/types.js'

const KIND = 'connection_pool_exhaustion'
const START = faultCatalog[KIND].defaultStartTick
const TARGET = faultCatalog[KIND].defaultTarget
const POOL = faultCatalog[KIND].params['poolSize']!.default
const TIMEOUT = faultCatalog[KIND].params['acquireTimeoutMs']!.default
const LEAK = faultCatalog[KIND].params['leakPerTick']!.default
const WINDOW = signatureWindow(START)
const TICKS = START + 12
const SEEDS = signatureSeeds('pool')

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const faultsOf = (seed: string, inputs: readonly FaultInput[] = [{ kind: KIND }]) => resolveFaults(inputs, buildWorld(defaultShop, seed))
const run = (seed: string, inputs: readonly FaultInput[] = [{ kind: KIND }], ticks = TICKS) =>
  simulate({ system: defaultShop, seed, faults: faultsOf(seed, inputs) }, ticks)
const baseline = (seed: string, ticks = TICKS) => simulate({ system: defaultShop, seed }, ticks)

const metricOf = (records: readonly TelemetryRecord[], component: string, tick: number, instance?: string): MetricRecord => {
  const m = records.find((r): r is MetricRecord => r.type === 'metric' && r.component === component && r.instance === instance && r.tick === tick)
  if (m === undefined) throw new Error(`no metric for ${component}/${instance ?? '*'} at ${tick}`)
  return m
}

const call = (over: Partial<CallContext> = {}): CallContext => ({
  tick: START + 10,
  caller: TARGET,
  callerInstance: `${TARGET}-0`,
  target: 'postgres',
  operation: 'db.insert',
  attempt: 0,
  traceId: `t${START + 10}r0`,
  ...over,
})

describe('module semantics (ADR-004)', () => {
  const world = buildWorld(defaultShop, 'sem')
  const [fault] = faultsOf('sem')
  const leak = fault!.params['leakPerTick'] as number

  it('is the registered module of its kind', () => {
    expect(faultRegistry[KIND]).toBe(connectionPoolExhaustion)
    expect(connectionPoolExhaustion.kind).toBe(KIND)
  })

  it('leaked connections grow by leakPerTick per tick and stop at poolSize', () => {
    expect([0, 1, 2, 5, 6, 7, 30].map((s) => leakedAt(s, 3, 20))).toEqual([3, 6, 9, 18, 20, 20, 20])
    expect(leakedAt(10, 0, 20)).toBe(0)
  })

  it('onResources: leaked connections, capped at poolSize, on every target instance and nowhere else', () => {
    const hooks = connectionPoolExhaustion.activate(fault!, world, createRngFactory('res'))
    for (let s = 0; s < 10; s++) {
      for (const instance of ['payment-0', 'payment-1', 'payment-2']) {
        expect(hooks.onResources?.({ tick: START + s, component: TARGET, instance })).toEqual({
          connectionsAdd: leakedAt(s, leak, POOL),
          connectionsCap: POOL,
        })
      }
      expect(hooks.onResources?.({ tick: START + s, component: 'postgres', instance: 'postgres-0' })).toBeUndefined()
      expect(hooks.onResources?.({ tick: START + s, component: 'cart', instance: 'cart-0' })).toBeUndefined()
    }
  })

  it('onCall: no effect while a connection is free, nor on other callers or non-database targets', () => {
    const hooks = connectionPoolExhaustion.activate(fault!, world, createRngFactory('call'))
    const firstFull = Math.ceil(POOL / leak) - 1
    for (let s = 0; s < firstFull; s++) expect(hooks.onCall?.(call({ tick: START + s, traceId: `t${START + s}r0` }))).toBeUndefined()
    expect(hooks.onCall?.(call({ caller: 'cart', callerInstance: 'cart-0' }))).toBeUndefined()
    expect(hooks.onCall?.(call({ target: 'queue', operation: 'queue.publish' }))).toBeUndefined()
    expect(hooks.onCall?.(call({ tick: START + firstFull, traceId: `t${START + firstFull}r0` }))).toMatchObject({ waitOperation: ACQUIRE_OPERATION })
  })

  it('exhausted pool: every acquisition waits on db.acquire, within the reclaim range, or times out and fails', () => {
    const hooks = connectionPoolExhaustion.activate(fault!, world, createRngFactory('wait'))
    let timeouts = 0
    let total = 0
    for (let r = 0; r < 400; r++) {
      const effect = hooks.onCall?.(call({ traceId: `t${START + 10}r${r}` }))
      total += 1
      expect(effect?.waitOperation).toBe(ACQUIRE_OPERATION)
      const wait = effect?.waitMs as number
      expect(wait).toBeGreaterThanOrEqual(RECLAIM_MIN * TIMEOUT)
      expect(wait).toBeLessThanOrEqual(TIMEOUT)
      if (effect?.fail !== undefined) {
        expect(wait).toBe(TIMEOUT)
        expect(effect.fail).toEqual({ message: POOL_TIMEOUT, attrs: { poolSize: POOL } })
        timeouts += 1
      } else {
        expect(wait).toBeLessThan(TIMEOUT)
      }
    }
    const expected = (RECLAIM_MAX - 1) / (RECLAIM_MAX - RECLAIM_MIN)
    expect(timeouts / total).toBeGreaterThan(expected - 0.07)
    expect(timeouts / total).toBeLessThan(expected + 0.07)
  })

  it('the retry after a timeout waits only the rest of the time until the same reclaim', () => {
    const hooks = connectionPoolExhaustion.activate(fault!, world, createRngFactory('retry'))
    let checked = 0
    for (let r = 0; r < 200 && checked < 10; r++) {
      const traceId = `t${START + 10}r${r}`
      const first = hooks.onCall?.(call({ traceId }))
      if (first?.fail === undefined) continue
      const retry = hooks.onCall?.(call({ traceId, attempt: 1 }))
      expect(retry?.fail).toBeUndefined()
      expect(retry?.waitMs).toBeLessThan((RECLAIM_MAX - 1) * TIMEOUT + 1)
      // A later, unrelated acquisition of the same trace draws again.
      const next = hooks.onCall?.(call({ traceId, attempt: 0 }))
      expect(next?.waitMs).toBeGreaterThanOrEqual(RECLAIM_MIN * TIMEOUT)
      checked += 1
    }
    expect(checked).toBe(10)
  })

  it('whatever acquireTimeoutMs, the retry after a timeout gets the reclaimed connection', () => {
    const [slow] = faultsOf('sem', [{ kind: KIND, params: { acquireTimeoutMs: 100 } }])
    const hooks = connectionPoolExhaustion.activate(slow!, world, createRngFactory('carry'))
    // The reclaim is at most RECLAIM_MAX x timeout, so what is left after one timeout is shorter
    // than a timeout (RECLAIM_MAX < 2): the retry never times out.
    for (let r = 0; r < 100; r++) {
      const traceId = `t${START + 10}r${r}`
      if (hooks.onCall?.(call({ traceId }))?.fail === undefined) continue
      expect(hooks.onCall?.(call({ traceId, attempt: 1 }))?.fail).toBeUndefined()
    }
  })

  it('the draws of a trace do not depend on other traces (per-trace stream)', () => {
    const alone = connectionPoolExhaustion.activate(fault!, world, createRngFactory('iso'))
    const busy = connectionPoolExhaustion.activate(fault!, world, createRngFactory('iso'))
    for (let r = 0; r < 30; r++) busy.onCall?.(call({ traceId: `t${START + 10}r${r + 100}` }))
    for (let r = 0; r < 30; r++) expect(busy.onCall?.(call({ traceId: `t${START + 10}r${r}` }))).toEqual(alone.onCall?.(call({ traceId: `t${START + 10}r${r}` })))
  })

  it('a target that is not a service of the world gets no hooks', () => {
    expect(connectionPoolExhaustion.activate({ ...fault!, target: 'postgres' }, world, createRngFactory('x'))).toEqual({})
  })
})

describe('F-2 — before startTick the fault is invisible', () => {
  it.each(SEEDS.slice(0, 4))('ticks < startTick are byte-identical to the baseline (seed %s)', (seed) => {
    const before = (records: readonly TelemetryRecord[]) => records.filter((r) => r.tick < START).map(serializeRecord).join('\n')
    const faulted = run(seed)
    const base = baseline(seed)
    expect(before(faulted)).toBe(before(base))
    expect(faulted.filter((r) => r.tick >= START).map(serializeRecord)).not.toEqual(base.filter((r) => r.tick >= START).map(serializeRecord))
  })
})

describe('ADR-004 Emenda 2 — invariant: with the defaults the pool is exhausted at the first tick of the window', () => {
  it('leakedAt(6, leakPerTick, poolSize) >= poolSize (catalog defaults)', () => {
    expect(LEAK).toBe(4)
    expect(POOL).toBe(20)
    // s = 6 is startTick + 6, the first tick of the signature window.
    expect(WINDOW[0]! - START).toBe(6)
    expect(leakedAt(6, LEAK, POOL)).toBeGreaterThanOrEqual(POOL)
    // ... and therefore at every tick of the window (the leak never shrinks).
    for (const tick of WINDOW) expect(leakedAt(tick - START, LEAK, POOL)).toBe(POOL)
  })
})

/** Combined F-6 case of T1.37: the pool on payment plus a crash loop on catalog, both with defaults. */
const WITH_CRASH_LOOP: readonly FaultInput[] = [{ kind: KIND }, { kind: 'service_crash_loop', target: 'catalog' }]

/**
 * F-3 row 3 read with R1–R5 (PRD Emenda 2) and F-4 with E1–E4, for the faults `inputs`.
 * The same block runs for the pool alone and for the combined F-6 case.
 */
function rowThree(label: string, inputs: readonly FaultInput[]): void {
  describe(`F-3 row 3 / F-4 — ${label}, ${SEEDS.length} seeds, defaults (R1–R5, E1–E4)`, () => {
    const faulted = SEEDS.map((seed) => run(seed, inputs))
    const base = SEEDS.map((seed) => baseline(seed))
    const series = (runs: readonly (readonly TelemetryRecord[])[], component: string, metric: MetricName) =>
      runs.map((records) => windowMean(records, component, metric, WINDOW))

    it('R4: the connections metric of the target reaches poolSize in >= 1 tick of the window, in every seed', () => {
      const instances = defaultShop.services.find((s) => s.name === TARGET)!.replicas
      const ids = Array.from({ length: instances }, (_, i) => `${TARGET}-${i}`)
      assertPass(
        everySeed(SEEDS, (_seed, i) => {
          const records = faulted[i]!
          const reached = WINDOW.some((tick) => ids.some((instance) => metricOf(records, TARGET, tick, instance).connections === POOL))
          return reached || 'connections never reach poolSize in the window'
        }),
        'connections at poolSize',
      )
      // Never above the pool (connectionsCap).
      for (const records of faulted) {
        for (const r of records) if (r.type === 'metric' && r.component === TARGET && r.instance !== undefined) expect(r.connections).toBeLessThanOrEqual(POOL)
      }
    })

    it('R3: p95 of the target >= 3x the baseline (>= 2.5x in every seed)', () => {
      assertPass(effect(series(faulted, TARGET, 'p95'), series(base, TARGET, 'p95'), { ratioAtLeast: 3 }, SEEDS), 'target p95')
    })

    it('R4: in the p95 trace of the target of every window tick with >= 1 target request, a db.acquire span is >= 50% of the root, in every seed', () => {
      let checked = 0
      assertPass(
        everySeed(SEEDS, (seed) => {
          const sim = createSimulation({ system: defaultShop, seed, faults: faultsOf(seed, inputs) })
          sim.advance(WINDOW[0]! - 1)
          for (const tick of WINDOW) {
            sim.advance(1)
            const aggregate = sim.telemetry().metricsOf(TARGET, tick, tick).find((m) => m.instance === undefined)!
            if (aggregate.rps === 0) continue
            const signal = trace({ kind: 'trace', service: TARGET, percentile: 95 }, { view: sim.telemetry(), lastWeek: () => sim.telemetry() })
            if (signal.focusSpanId === null) return `tick ${tick}: target has requests but no p95 trace`
            const focus = signal.spans.find((s) => s.spanId === signal.focusSpanId) as SpanRecord
            const root = signal.spans.find((s) => s.parentId === undefined) as SpanRecord
            const waits = signal.spans.filter((s) => s.parentId === focus.spanId && s.operation === ACQUIRE_OPERATION && s.kind === 'internal')
            const longest = Math.max(0, ...waits.map((s) => s.durationMs))
            // "Root" read both ways: the target's own server span (the root of its part of the
            // trace, as in P-1) and the root of the whole trace (the gateway request).
            if (longest < 0.5 * focus.durationMs) return `tick ${tick}: db.acquire ${longest} ms < 50% of the target span ${focus.durationMs} ms`
            if (longest < 0.5 * root.durationMs) return `tick ${tick}: db.acquire ${longest} ms < 50% of the root ${root.durationMs} ms`
            checked += 1
          }
          return true
        }),
        'db.acquire share of the p95 trace',
      )
      expect(checked).toBeGreaterThanOrEqual(SEEDS.length)
    })

    it('R3: gateway p95 rises >= 25% (>= 18.75% in every seed)', () => {
      assertPass(effect(series(faulted, 'gateway', 'p95'), series(base, 'gateway', 'p95'), { riseAtLeast: 0.25 }, SEEDS), 'gateway p95')
    })

    it('R5: gateway p50 stays <= 1.5x the baseline (mean over seeds)', () => {
      assertPass(ceiling(series(faulted, 'gateway', 'p50'), series(base, 'gateway', 'p50'), { ratioAtMost: 1.5 }, SEEDS), 'gateway p50')
    })

    it('F-4: fixed eligible pair (gateway, p95), in every seed (E1–E4)', () => {
      const r = assertEligibleF4({ component: 'gateway', metric: 'p95' }, base, faulted, TARGET, { window: WINDOW, seeds: SEEDS })
      expect(r.direction).toBe('rise')
    })

    it('timed-out acquisitions leave `connection pool timeout` error logs on the target', () => {
      const logs = faulted.flatMap((records) => records.filter((r): r is LogRecord => r.type === 'log' && r.message === POOL_TIMEOUT))
      expect(logs.length).toBeGreaterThan(0)
      expect(logs.every((l) => l.component === TARGET && l.level === 'error' && l.attrs?.['poolSize'] === POOL)).toBe(true)
    })
  })
}

rowThree('connection_pool_exhaustion alone', [{ kind: KIND }])
rowThree('F-6: + service_crash_loop on catalog', WITH_CRASH_LOOP)

describe('F-6 combined case — determinism', () => {
  it('pool + crash loop: two runs give the same hash', () => {
    const a = sha(toNdjson(run('det-f6', WITH_CRASH_LOOP, 40)))
    expect(sha(toNdjson(run('det-f6', WITH_CRASH_LOOP, 40)))).toBe(a)
  })
})

describe('other parameters', () => {
  it('leakPerTick = 0 never exhausts the pool: only the cap applies, latency is untouched', () => {
    const seed = 'noleak'
    const records = run(seed, [{ kind: KIND, params: { leakPerTick: 0 } }])
    expect(records.some((r) => r.type === 'span' && r.operation === ACQUIRE_OPERATION)).toBe(false)
    const spans = (rs: readonly TelemetryRecord[]) => rs.filter((r) => r.type === 'span').map(serializeRecord)
    expect(spans(records)).toEqual(spans(baseline(seed)))
  })

  it('a small pool (poolSize 1) is exhausted from startTick, not before', () => {
    const records = run('small', [{ kind: KIND, params: { poolSize: 1, leakPerTick: 1 } }], START + 3)
    const waits = records.filter((r) => r.type === 'span' && r.operation === ACQUIRE_OPERATION)
    expect(waits.length).toBeGreaterThan(0)
    expect(waits.every((w) => w.tick >= START)).toBe(true)
  })
})

describe('P-1/P-2/P-3/S-3 — verify-coherence.mjs over the faulted NDJSON', () => {
  it.each(['qa', 'pool-coh'])('seed %s, 60 ticks', (seed) => {
    const text = toNdjson(run(seed, [{ kind: KIND }], 60))
    const r = spawnSync(process.execPath, [verifier], { input: text, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})

describe('DET — same seed and fault => byte-identical NDJSON', () => {
  it('two runs give the same hash; different seeds give different hashes', () => {
    const a = sha(toNdjson(run('det', [{ kind: KIND }], 40)))
    expect(sha(toNdjson(run('det', [{ kind: KIND }], 40)))).toBe(a)
    expect(sha(toNdjson(run('det-2', [{ kind: KIND }], 40)))).not.toBe(a)
  })
})
