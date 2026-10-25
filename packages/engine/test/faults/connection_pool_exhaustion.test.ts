/**
 * T1.19 — fault `connection_pool_exhaustion` (ADR-004; PRD F-1, F-2, F-3 row 3, F-4; DET).
 *
 * Signature assertions compare window means over >= 10 seeds (signature window = ticks
 * startTick+6 .. startTick+11), never per-trace or per-instance equality against the baseline
 * while the fault is active (ADR-003 §8). The trace clause of F-3 row 3 is checked through the
 * real `trace` question handler, i.e. on the trace a player would get for `trace payment p95`.
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
import type { CallContext, FaultInput, LogRecord, MetricName, MetricRecord, SpanRecord, TelemetryRecord } from '../../src/types.js'

const KIND = 'connection_pool_exhaustion'
const START = faultCatalog[KIND].defaultStartTick
const TARGET = faultCatalog[KIND].defaultTarget
const POOL = faultCatalog[KIND].params['poolSize']!.default
const TIMEOUT = faultCatalog[KIND].params['acquireTimeoutMs']!.default
const WINDOW = Array.from({ length: 6 }, (_, i) => START + 6 + i)
const TICKS = START + 12
const SEEDS = Array.from({ length: 12 }, (_, i) => `pool-${i}`)

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

/** Mean of an aggregate metric over the signature window and over all seeds. */
function windowMean(runs: readonly (readonly TelemetryRecord[])[], component: string, metric: MetricName): number {
  let total = 0
  for (const records of runs) for (const tick of WINDOW) total += metricOf(records, component, tick)[metric]
  return total / (runs.length * WINDOW.length)
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

describe(`F-3 row 3 — signature in the window, ${SEEDS.length} seeds, defaults`, () => {
  const faulted = SEEDS.map((seed) => run(seed))
  const base = SEEDS.map((seed) => baseline(seed))

  it('target: the connections metric reaches poolSize in >= 1 tick of the window (every seed)', () => {
    const instances = defaultShop.services.find((s) => s.name === TARGET)!.replicas
    for (const records of faulted) {
      const reached = WINDOW.filter((tick) =>
        Array.from({ length: instances }, (_, i) => `${TARGET}-${i}`).some((instance) => metricOf(records, TARGET, tick, instance).connections === POOL),
      )
      expect(reached.length).toBeGreaterThanOrEqual(1)
      // Never above the pool (connectionsCap).
      for (const r of records) if (r.type === 'metric' && r.component === TARGET && r.instance !== undefined) expect(r.connections).toBeLessThanOrEqual(POOL)
    }
  })

  it('target: p95 >= 3x the baseline', () => {
    expect(windowMean(faulted, TARGET, 'p95')).toBeGreaterThanOrEqual(3 * windowMean(base, TARGET, 'p95'))
  })

  it('target: in the p95 trace of the target, once the pool is exhausted, one db.acquire span is >= 50% of the root', () => {
    let checked = 0
    for (const seed of SEEDS) {
      const sim = createSimulation({ system: defaultShop, seed, faults: faultsOf(seed) })
      sim.advance(WINDOW[0]! - 1)
      let exhausted = 0
      for (const tick of WINDOW) {
        sim.advance(1)
        // Exhausted = every instance of the target reports connections at poolSize (read from the
        // telemetry, as a player would). Before that the pool still has a free connection and the
        // target's traces have no wait at all.
        const instances = sim.telemetry().metricsOf(TARGET, tick, tick).filter((m) => m.instance !== undefined)
        if (!instances.every((m) => m.connections === POOL)) continue
        exhausted += 1
        const signal = trace({ kind: 'trace', service: TARGET, percentile: 95 }, { view: sim.telemetry(), lastWeek: () => sim.telemetry() })
        if (signal.focusSpanId === null) continue
        const focus = signal.spans.find((s) => s.spanId === signal.focusSpanId) as SpanRecord
        const root = signal.spans.find((s) => s.parentId === undefined) as SpanRecord
        const waits = signal.spans.filter((s) => s.parentId === focus.spanId && s.operation === ACQUIRE_OPERATION && s.kind === 'internal')
        const longest = Math.max(0, ...waits.map((s) => s.durationMs))
        // "Root" read both ways: the target's own server span (the root of its part of the trace,
        // as in P-1) and the root of the whole trace (the gateway request).
        expect(longest).toBeGreaterThanOrEqual(0.5 * focus.durationMs)
        expect(longest).toBeGreaterThanOrEqual(0.5 * root.durationMs)
        checked += 1
      }
      expect(exhausted).toBeGreaterThanOrEqual(1)
    }
    expect(checked).toBeGreaterThanOrEqual(SEEDS.length)
  })

  it('indirect: gateway p95 rises >= 25% while gateway p50 stays <= 1.5x the baseline', () => {
    const p95 = { base: windowMean(base, 'gateway', 'p95'), fault: windowMean(faulted, 'gateway', 'p95') }
    const p50 = { base: windowMean(base, 'gateway', 'p50'), fault: windowMean(faulted, 'gateway', 'p50') }
    expect(p95.fault).toBeGreaterThanOrEqual(1.25 * p95.base)
    expect(p50.fault).toBeLessThanOrEqual(1.5 * p50.base)
  })

  it('F-4: a metric of a component other than the target deviates >= 25% from the baseline', () => {
    // The database sees the leaked connections its client holds (the DBA's view).
    const conn = { base: windowMean(base, 'postgres', 'connections'), fault: windowMean(faulted, 'postgres', 'connections') }
    expect(conn.base).toBeGreaterThan(0)
    expect((conn.fault - conn.base) / conn.base).toBeGreaterThanOrEqual(0.25)
  })

  it('timed-out acquisitions leave `connection pool timeout` error logs on the target', () => {
    const logs = faulted.flatMap((records) => records.filter((r): r is LogRecord => r.type === 'log' && r.message === POOL_TIMEOUT))
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.every((l) => l.component === TARGET && l.level === 'error' && l.attrs?.['poolSize'] === POOL)).toBe(true)
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
