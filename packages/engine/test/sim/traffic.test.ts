/**
 * T1.14 — generateTraffic (ADR-002 §5–6, ADR-003, ADR-005; PRD S-3, P-1/P-2/P-3, H4, DET).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateLogs } from '../../src/sim/logs.js'
import { deriveMetrics } from '../../src/sim/metrics.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { serializeRecord } from '../../src/sim/serialize.js'
import {
  DEFAULT_WAIT_OPERATION,
  FAST_FAIL_MS,
  MAX_Z,
  MESSAGES,
  generateTraffic,
  inverseNormal,
  sampleLatencyMs,
} from '../../src/sim/traffic.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type {
  CallContext,
  FaultHooks,
  InstanceId,
  MetricRecord,
  Rng,
  ServeContext,
  SpanRecord,
  SystemDefinition,
  TrafficInput,
  TrafficResult,
  World,
} from '../../src/types.js'

// --- helpers ------------------------------------------------------------------------------

const shop = buildWorld(defaultShop, 'traffic')

function run(world: World, seed: string, tick = 0, hooks: FaultHooks = {}, down: Iterable<InstanceId> = []): TrafficResult {
  return generateTraffic({ world, tick, rng: createRngFactory(seed), down: new Set(down), hooks })
}

const hashOf = (result: TrafficResult): string =>
  createHash('sha256')
    .update(result.spans.map((s) => serializeRecord(s)).join('\n'))
    .update(JSON.stringify(result.errors))
    .digest('hex')

/** Base for small test worlds; every component has a fixed latency (p50 = p99) unless overridden. */
const base = { replicas: 1, latencyP50Ms: 10, latencyP99Ms: 10, cpuBasePct: 1, cpuPerRequestPct: 0.1, memBaseMb: 64 }

/** W-3 shaped world: 2 services + 1 dependency. */
function minimalSystem(overrides: { timeoutMs?: number; retries?: number; frontRate?: number; backReplicas?: number } = {}): SystemDefinition {
  return {
    name: 'minimal',
    services: [
      {
        ...base,
        name: 'front',
        replicas: 2,
        ingress: { ratePerTick: overrides.frontRate ?? 4, operation: 'http.request' },
        calls: [
          { target: 'back', operation: 'back.do', ratio: 1, timeoutMs: overrides.timeoutMs ?? 200, retries: overrides.retries ?? 2 },
        ],
        dbPoolSize: 5,
      },
      {
        ...base,
        name: 'back',
        replicas: overrides.backReplicas ?? 3,
        calls: [{ target: 'store', operation: 'db.query', ratio: 1, timeoutMs: 100, retries: 0 }],
        dbPoolSize: 5,
      },
    ],
    deps: [{ ...base, name: 'store', kind: 'database', maxConnections: 50 }],
  }
}

/** World with a cache in front of a database. */
function cacheSystem(hitRatio: number, cacheTimeoutMs = 50): SystemDefinition {
  return {
    name: 'cached',
    services: [
      {
        ...base,
        name: 'app',
        replicas: 2,
        ingress: { ratePerTick: 6, operation: 'http.request' },
        calls: [
          {
            target: 'kv',
            operation: 'kv.get',
            ratio: 1,
            timeoutMs: cacheTimeoutMs,
            retries: 0,
            onMiss: { target: 'sql', operation: 'db.query', timeoutMs: 500, retries: 0 },
          },
        ],
        dbPoolSize: 5,
      },
    ],
    deps: [
      { ...base, name: 'kv', kind: 'cache', maxConnections: 100, cacheHitRatio: hitRatio },
      { ...base, name: 'sql', kind: 'database', maxConnections: 100 },
    ],
  }
}

const childrenOf = (spans: readonly SpanRecord[], id: string) => spans.filter((s) => s.parentId === id)
const byTrace = (spans: readonly SpanRecord[]): Map<string, SpanRecord[]> => {
  const out = new Map<string, SpanRecord[]>()
  for (const s of spans) {
    const list = out.get(s.traceId)
    if (list) list.push(s)
    else out.set(s.traceId, [s])
  }
  return out
}

/** S-3 checker, independent from the engine: returns violations (empty = valid). */
function treeViolations(result: TrafficResult, tick: number): string[] {
  const bad: string[] = []
  const ids = new Set<string>()
  for (const s of result.spans) {
    if (ids.has(s.spanId)) bad.push(`duplicate span id ${s.spanId}`)
    ids.add(s.spanId)
  }
  for (const [traceId, spans] of byTrace(result.spans)) {
    const roots = spans.filter((s) => s.parentId === undefined)
    if (roots.length !== 1) bad.push(`${traceId}: ${roots.length} roots`)
    if (roots[0] !== spans[0]) bad.push(`${traceId}: root is not the first span (pre-order)`)
    if (roots[0] && (roots[0].kind !== 'server' || roots[0].startMs !== 0)) bad.push(`${traceId}: root must be a server span at 0`)
    const byId = new Map(spans.map((s) => [s.spanId, s]))
    spans.forEach((s, i) => {
      if (s.tick !== tick) bad.push(`${s.spanId}: tick ${s.tick}`)
      if (!s.spanId.startsWith(`${traceId}s`)) bad.push(`${s.spanId}: id not derived from trace`)
      if (!Number.isInteger(s.durationMs) || s.durationMs < 0) bad.push(`${s.spanId}: duration ${s.durationMs}`)
      if (!Number.isInteger(s.startMs) || s.startMs < 0) bad.push(`${s.spanId}: start ${s.startMs}`)
      if (s.status !== 'ok' && s.status !== 'error') bad.push(`${s.spanId}: status ${String(s.status)}`)
      if ((s.kind === 'client') !== (s.peer !== undefined)) bad.push(`${s.spanId}: peer only on client spans`)
      if (s.parentId === undefined) return
      const parent = byId.get(s.parentId)
      if (!parent) return void bad.push(`${s.spanId}: parent ${s.parentId} missing`)
      if (spans.indexOf(parent) >= i) bad.push(`${s.spanId}: parent after child`)
      if (s.durationMs > parent.durationMs) bad.push(`${s.spanId}: longer than parent`)
      if (s.startMs < parent.startMs) bad.push(`${s.spanId}: starts before parent`)
      if (s.startMs + s.durationMs > parent.startMs + parent.durationMs) bad.push(`${s.spanId}: ends after parent`)
      if (s.kind === 'server' && parent.kind !== 'client') bad.push(`${s.spanId}: server child of non-client`)
      if (s.kind === 'server' && parent.peer !== s.component) bad.push(`${s.spanId}: server on a component other than the client peer`)
      if (s.kind !== 'server' && (parent.kind !== 'server' || parent.component !== s.component || parent.instance !== s.instance)) {
        bad.push(`${s.spanId}: caller-side span not under the caller's server span`)
      }
    })
  }
  return bad
}

function errorDetailViolations(result: TrafficResult): string[] {
  const errorIds = result.spans.filter((s) => s.status === 'error').map((s) => s.spanId)
  const detailIds = result.errors.map((e) => e.spanId)
  return JSON.stringify(errorIds) === JSON.stringify(detailIds) ? [] : [`error spans ${errorIds.length} != details ${detailIds.length}`]
}

// --- latency model ---------------------------------------------------------------------------

describe('latency model', () => {
  it('inverseNormal matches known quantiles', () => {
    expect(inverseNormal(0.5)).toBeCloseTo(0, 9)
    expect(inverseNormal(0.99)).toBeCloseTo(2.3263478740408408, 6)
    expect(inverseNormal(0.01)).toBeCloseTo(-2.3263478740408408, 6)
    expect(inverseNormal(0.975)).toBeCloseTo(1.959963984540054, 6)
    expect(inverseNormal(0)).toBe(-Infinity)
    expect(inverseNormal(1)).toBe(Infinity)
  })

  const fixed = (u: number): Rng => ({ next: () => u, int: () => 0, chance: () => false, pick: (xs) => xs[0] as never })

  it('sampleLatencyMs has median p50 and 99th percentile p99, integer and >= 1', () => {
    expect(sampleLatencyMs(fixed(0.5), 40, 150)).toBe(40)
    expect(sampleLatencyMs(fixed(0.99), 40, 150)).toBe(150)
    expect(sampleLatencyMs(fixed(0.3), 10, 10)).toBe(10)
    expect(sampleLatencyMs(fixed(0), 1, 100)).toBe(Math.max(1, Math.round(Math.exp((Math.log(100) / 2.3263478740408408) * -MAX_Z))))
    expect(sampleLatencyMs(fixed(0.999999999), 5, 20)).toBe(Math.round(5 * Math.exp((Math.log(4) / 2.3263478740408408) * MAX_Z)))
  })

  it('empirical median and p99 of a dependency server span are close to its spec', () => {
    const world = buildWorld(defaultShop, 'lat')
    const durations: number[] = []
    for (let tick = 0; tick < 200; tick++) {
      for (const s of run(world, 'lat', tick).spans) if (s.component === 'redis' && s.kind === 'server') durations.push(s.durationMs)
    }
    durations.sort((a, b) => a - b)
    const at = (p: number) => durations[Math.ceil((p / 100) * durations.length) - 1] as number
    expect(durations.length).toBeGreaterThan(1000)
    expect(at(50)).toBe(1)
    expect(at(99)).toBeGreaterThanOrEqual(3)
    expect(at(99)).toBeLessThanOrEqual(5)
  })
})

// --- structure ------------------------------------------------------------------------------

describe('trace structure (S-3)', () => {
  it('minimal world: one root per trace, children within parents, ids per ADR-003', () => {
    const world = buildWorld(minimalSystem(), 'm')
    const result = run(world, 'm', 7)
    expect(treeViolations(result, 7)).toEqual([])
    const traces = byTrace(result.spans)
    expect([...traces.keys()]).toEqual(['t7r0', 't7r1', 't7r2', 't7r3'])
    for (const spans of traces.values()) {
      // front server -> client -> back server -> client -> store server
      expect(spans.map((s) => `${s.component}:${s.kind}`)).toEqual([
        'front:server',
        'front:client',
        'back:server',
        'back:client',
        'store:server',
      ])
      expect(spans.map((s) => s.spanId)).toEqual([0, 1, 2, 3, 4].map((n) => `${spans[0]?.traceId}s${n}`))
      expect(spans.every((s) => s.status === 'ok')).toBe(true)
    }
    // Only components of this world appear (W-3).
    expect(new Set(result.spans.map((s) => s.component))).toEqual(new Set(['front', 'back', 'store']))
  })

  it('fixed latencies give exact timings: half of own time before the calls, half after', () => {
    const world = buildWorld(minimalSystem(), 'm')
    const [root, client, back, backClient, store] = run(world, 'm').spans as SpanRecord[]
    expect(store).toMatchObject({ startMs: 10, durationMs: 10 })
    expect(backClient).toMatchObject({ startMs: 10, durationMs: 10, peer: 'store' })
    expect(back).toMatchObject({ startMs: 5, durationMs: 20 })
    expect(client).toMatchObject({ startMs: 5, durationMs: 20, peer: 'back' })
    expect(root).toMatchObject({ startMs: 0, durationMs: 30 })
    expect(root?.parentId).toBeUndefined()
  })

  it('round-robin balances over all instances of the target with a per-tick offset', () => {
    const world = buildWorld(minimalSystem({ frontRate: 6 }), 'm')
    for (let tick = 0; tick < 5; tick++) {
      const result = run(world, 'rr', tick)
      const fronts = result.spans.filter((s) => s.component === 'front' && s.kind === 'server').map((s) => s.instance)
      const backs = result.spans.filter((s) => s.component === 'back' && s.kind === 'server').map((s) => s.instance)
      expect(fronts.filter((i) => i === 'front-0')).toHaveLength(3)
      expect(backs.filter((i) => i === 'back-0')).toHaveLength(2)
      for (let k = 1; k < backs.length; k++) {
        const prev = Number(backs[k - 1]?.slice(-1))
        expect(Number(backs[k]?.slice(-1))).toBe((prev + 1) % 3)
      }
    }
    const offsets = new Set<string>()
    for (let tick = 0; tick < 20; tick++) offsets.add(run(world, 'rr', tick).spans.find((s) => s.component === 'back')?.instance ?? '')
    expect(offsets.size).toBeGreaterThan(1)
  })

  it('a world without ingress, or with ratePerTick 0, produces nothing', () => {
    const world = buildWorld(minimalSystem({ frontRate: 0 }), 'm')
    expect(run(world, 'x')).toEqual({ spans: [], errors: [] })
  })

  it('S-3 property over the default-shop: many seeds and ticks, with and without faults', () => {
    const hookSets: FaultHooks[] = [{}, ...randomHookSets()]
    for (let s = 0; s < 12; s++) {
      for (let tick = 0; tick < 4; tick++) {
        for (const [h, hooks] of hookSets.entries()) {
          const down = s % 3 === 0 ? ['catalog-1', 'redis-0'] : s % 3 === 1 ? ['payment-2'] : []
          const result = run(shop, `prop-${s}-${h}`, tick, hooks, down)
          expect(treeViolations(result, tick)).toEqual([])
          expect(errorDetailViolations(result)).toEqual([])
        }
      }
    }
  })
})

// --- ingress -----------------------------------------------------------------------------------

describe('ingress (ADR-002 §6)', () => {
  it('default-shop starts 12 traces/tick at the gateway and 2 at orders-worker', () => {
    for (let tick = 0; tick < 10; tick++) {
      const roots = run(shop, 'ing', tick).spans.filter((s) => s.parentId === undefined)
      expect(roots.filter((s) => s.component === 'gateway' && s.operation === 'http.request')).toHaveLength(12)
      expect(roots.filter((s) => s.component === 'orders-worker' && s.operation === 'queue.consume')).toHaveLength(2)
      expect(roots).toHaveLength(14)
    }
  })

  it('requests routed to a down ingress instance are lost at the edge (no spans)', () => {
    const world = buildWorld(minimalSystem({ frontRate: 4 }), 'm')
    const result = run(world, 'm', 0, {}, ['front-0'])
    const roots = result.spans.filter((s) => s.parentId === undefined)
    expect(roots).toHaveLength(2)
    expect(roots.every((s) => s.instance === 'front-1')).toBe(true)
    expect(result.spans.some((s) => s.instance === 'front-0')).toBe(false)
    // Trace ids keep counting the lost requests.
    expect(new Set(roots.map((s) => s.traceId)).size).toBe(2)
    expect(run(world, 'm', 0, {}, ['front-0', 'front-1']).spans).toEqual([])
  })
})

// --- calls: down, retries, timeouts -------------------------------------------------------------

describe('calls (ADR-002 §5)', () => {
  it('down instance: client fails in FAST_FAIL_MS with connection refused and no server span; retry reaches the next instance', () => {
    const world = buildWorld(minimalSystem(), 'm')
    const result = run(world, 'm', 0, {}, ['back-0'])
    expect(treeViolations(result, 0)).toEqual([])
    expect(result.spans.some((s) => s.instance === 'back-0')).toBe(false)
    const refused = result.spans.filter((s) => s.kind === 'client' && s.status === 'error')
    expect(refused.length).toBeGreaterThan(0)
    for (const span of refused) {
      expect(span.durationMs).toBe(FAST_FAIL_MS)
      expect(childrenOf(result.spans, span.spanId)).toEqual([])
      const detail = result.errors.find((e) => e.spanId === span.spanId)
      expect(detail).toMatchObject({ message: MESSAGES.connectionRefused, attrs: { peerInstance: 'back-0' } })
    }
    // retries: 2, at most one of 3 instances is down: every request succeeds after a retry.
    expect(result.spans.filter((s) => s.parentId === undefined).every((s) => s.status === 'ok')).toBe(true)
  })

  it('retries up to `retries`, then the caller server span is error (propagation)', () => {
    const world = buildWorld(minimalSystem({ retries: 2 }), 'm')
    const attempts: number[] = []
    const hooks: FaultHooks = {
      onServe: (ctx: ServeContext) => (ctx.component === 'back' ? { fail: { message: 'boom', attrs: { code: 7 } } } : undefined),
      onCall: (ctx: CallContext) => {
        if (ctx.caller === 'front') attempts.push(ctx.attempt)
        return undefined
      },
    }
    const result = run(world, 'm', 0, hooks)
    expect(treeViolations(result, 0)).toEqual([])
    for (const spans of byTrace(result.spans).values()) {
      const root = spans[0] as SpanRecord
      const clients = childrenOf(spans, root.spanId)
      expect(clients).toHaveLength(3)
      expect(clients.every((c) => c.kind === 'client' && c.status === 'error')).toBe(true)
      // The failing server spans make no calls and carry the fault's error.
      const backs = spans.filter((s) => s.component === 'back')
      expect(backs).toHaveLength(3)
      for (const back of backs) {
        expect(back.status).toBe('error')
        expect(childrenOf(spans, back.spanId)).toEqual([])
        expect(result.errors.find((e) => e.spanId === back.spanId)).toEqual({ spanId: back.spanId, message: 'boom', attrs: { code: 7 } })
      }
      expect(root.status).toBe('error')
      expect(result.errors.find((e) => e.spanId === root.spanId)).toMatchObject({
        message: MESSAGES.dependencyFailed,
        attrs: { upstream: 'back' },
      })
      expect(result.errors.find((e) => e.spanId === clients[0]?.spanId)?.message).toBe(MESSAGES.upstreamError)
      // Attempts are sequential, without overlap.
      for (let k = 1; k < clients.length; k++) {
        const prev = clients[k - 1] as SpanRecord
        expect(clients[k]?.startMs).toBe(prev.startMs + prev.durationMs)
      }
    }
    expect(attempts.slice(0, 3)).toEqual([0, 1, 2])
    expect(errorDetailViolations(result)).toEqual([])
  })

  it('a retry that succeeds leaves the caller ok', () => {
    const world = buildWorld(minimalSystem({ retries: 1 }), 'm')
    const hooks: FaultHooks = { onCall: (ctx) => (ctx.caller === 'front' && ctx.attempt === 0 ? { fail: { message: 'flaky' } } : undefined) }
    const result = run(world, 'm', 0, hooks)
    for (const spans of byTrace(result.spans).values()) {
      const clients = childrenOf(spans, spans[0]?.spanId as string)
      expect(clients.map((c) => c.status)).toEqual(['error', 'ok'])
      expect(spans[0]?.status).toBe('ok')
      expect(result.errors.find((e) => e.spanId === clients[0]?.spanId)).toEqual({
        spanId: clients[0]?.spanId,
        message: 'flaky',
        attrs: { attempt: 0 },
      })
    }
  })

  it('timeout: client ends at timeoutMs with error; the server and its descendants are cut with status ok', () => {
    const world = buildWorld(minimalSystem({ timeoutMs: 40, retries: 1 }), 'm')
    const hooks: FaultHooks = { onServe: (ctx) => (ctx.component === 'store' ? { addLatencyMs: 500 } : undefined) }
    const result = run(world, 'm', 0, hooks)
    expect(treeViolations(result, 0)).toEqual([])
    for (const spans of byTrace(result.spans).values()) {
      const root = spans[0] as SpanRecord
      const clients = childrenOf(spans, root.spanId)
      expect(clients).toHaveLength(2)
      for (const client of clients) {
        expect(client).toMatchObject({ status: 'error', durationMs: 40 })
        expect(result.errors.find((e) => e.spanId === client.spanId)).toMatchObject({
          message: MESSAGES.upstreamTimeout,
          attrs: { timeoutMs: 40 },
        })
        const [server] = childrenOf(spans, client.spanId)
        expect(server).toMatchObject({ kind: 'server', component: 'back', status: 'ok', startMs: client.startMs, durationMs: 40 })
        // back's own timeout to store (100 ms) is not reached: back's client and store's server are
        // cut by front's deadline, both ok (cancelled, not failed).
        const backClient = childrenOf(spans, server?.spanId as string)[0] as SpanRecord
        const store = childrenOf(spans, backClient.spanId)[0] as SpanRecord
        expect(backClient.status).toBe('ok')
        expect(store.status).toBe('ok')
        expect(backClient.startMs + backClient.durationMs).toBe(client.startMs + 40)
        expect(store.startMs + store.durationMs).toBe(client.startMs + 40)
      }
      expect(root.status).toBe('error')
    }
    // Every error span has exactly one detail; cut spans have none.
    expect(errorDetailViolations(result)).toEqual([])
  })

  it('timeout of a nested call is an error of the nested caller, which propagates', () => {
    const world = buildWorld(minimalSystem({ timeoutMs: 5000, retries: 0 }), 'm')
    const hooks: FaultHooks = { onServe: (ctx) => (ctx.component === 'store' ? { addLatencyMs: 500 } : undefined) }
    const result = run(world, 'm', 0, hooks)
    const spans = result.spans.filter((s) => s.traceId === 't0r0')
    const backClient = spans.find((s) => s.component === 'back' && s.kind === 'client') as SpanRecord
    expect(backClient).toMatchObject({ status: 'error', durationMs: 100 })
    expect(spans.find((s) => s.component === 'store')).toMatchObject({ status: 'ok', durationMs: 100 })
    expect(spans.find((s) => s.component === 'back' && s.kind === 'server')?.status).toBe('error')
    expect(spans[0]?.status).toBe('error')
  })

  it('a server whose own time alone exceeds the deadline is cut before making calls', () => {
    const world = buildWorld(minimalSystem({ timeoutMs: 30, retries: 0 }), 'm')
    const hooks: FaultHooks = { onServe: (ctx) => (ctx.component === 'back' ? { addLatencyMs: 200 } : undefined) }
    const spans = run(world, 'm', 0, hooks).spans.filter((s) => s.traceId === 't0r0')
    expect(spans.map((s) => `${s.component}:${s.kind}:${s.status}:${s.durationMs}`)).toEqual([
      'front:server:error:40',
      'front:client:error:30',
      'back:server:ok:30',
    ])
  })
})

// --- cache ----------------------------------------------------------------------------------

describe('cache and onMiss (ADR-002 §5)', () => {
  const callsTo = (result: TrafficResult, peer: string) => result.spans.filter((s) => s.kind === 'client' && s.peer === peer)

  it('hit ratio 1: never follows onMiss; hit ratio 0: always does', () => {
    const hit = run(buildWorld(cacheSystem(1), 'c'), 'c')
    expect(callsTo(hit, 'kv')).toHaveLength(6)
    expect(callsTo(hit, 'sql')).toHaveLength(0)
    const miss = run(buildWorld(cacheSystem(0), 'c'), 'c')
    expect(callsTo(miss, 'kv')).toHaveLength(6)
    expect(callsTo(miss, 'sql')).toHaveLength(6)
    expect(treeViolations(miss, 0)).toEqual([])
    // The fallback is a sibling of the cache call, after it.
    for (const spans of byTrace(miss.spans).values()) {
      const [kv, sql] = childrenOf(spans, spans[0]?.spanId as string)
      expect(kv?.peer).toBe('kv')
      expect(sql?.peer).toBe('sql')
      expect(sql?.startMs).toBe((kv?.startMs ?? 0) + (kv?.durationMs ?? 0))
    }
  })

  it('partial hit ratio follows onMiss on a fraction of requests', () => {
    const world = buildWorld(cacheSystem(0.5), 'c')
    let sql = 0
    for (let tick = 0; tick < 50; tick++) sql += callsTo(run(world, 'c', tick), 'sql').length
    expect(sql).toBeGreaterThan(100)
    expect(sql).toBeLessThan(200)
  })

  it('forceCacheMiss follows onMiss', () => {
    const world = buildWorld(cacheSystem(1), 'c')
    const result = run(world, 'c', 0, { onCall: (ctx) => (ctx.target === 'kv' ? { forceCacheMiss: true } : undefined) })
    expect(callsTo(result, 'sql')).toHaveLength(6)
    expect(result.errors).toEqual([])
  })

  it('cache down, failing or timing out: onMiss runs and the cache error does not propagate', () => {
    const world = buildWorld(cacheSystem(1, 5), 'c')
    const cases: [string, FaultHooks, InstanceId[]][] = [
      ['down', {}, ['kv-0']],
      ['fail', { onCall: (ctx) => (ctx.target === 'kv' ? { fail: { message: 'kv broken' } } : undefined) }, []],
      ['timeout', { onServe: (ctx) => (ctx.component === 'kv' ? { addLatencyMs: 100 } : undefined) }, []],
    ]
    for (const [name, hooks, down] of cases) {
      const result = run(world, 'c', 0, hooks, down)
      expect(treeViolations(result, 0), name).toEqual([])
      expect(callsTo(result, 'sql'), name).toHaveLength(6)
      expect(callsTo(result, 'kv').every((s) => s.status === 'error'), name).toBe(true)
      expect(result.spans.filter((s) => s.parentId === undefined).every((s) => s.status === 'ok'), name).toBe(true)
      expect(errorDetailViolations(result), name).toEqual([])
    }
  })

  it('onMiss failure propagates to the caller', () => {
    const world = buildWorld(cacheSystem(0), 'c')
    const result = run(world, 'c', 0, {}, ['sql-0'])
    const roots = result.spans.filter((s) => s.parentId === undefined)
    expect(roots.every((s) => s.status === 'error')).toBe(true)
    expect(result.errors.find((e) => e.spanId === roots[0]?.spanId)).toMatchObject({ attrs: { upstream: 'sql' } })
  })
})

// --- hooks ------------------------------------------------------------------------------------

describe('hooks (onServe, onCall)', () => {
  it('receive the documented contexts', () => {
    const world = buildWorld(minimalSystem({ frontRate: 1 }), 'm')
    const serves: ServeContext[] = []
    const calls: CallContext[] = []
    run(world, 'm', 3, {
      onServe: (ctx) => void serves.push(ctx),
      onCall: (ctx) => void calls.push(ctx),
    })
    expect(serves.map((c) => [c.tick, c.component, c.operation, c.traceId])).toEqual([
      [3, 'front', 'http.request', 't3r0'],
      [3, 'back', 'back.do', 't3r0'],
      [3, 'store', 'db.query', 't3r0'],
    ])
    expect(calls.map((c) => [c.tick, c.caller, c.target, c.operation, c.attempt, c.traceId])).toEqual([
      [3, 'front', 'back', 'back.do', 0, 't3r0'],
      [3, 'back', 'store', 'db.query', 0, 't3r0'],
    ])
    expect(calls[1]?.callerInstance).toBe(serves[1]?.instance)
  })

  it('onServe.addLatencyMs lengthens the span and its ancestors', () => {
    const world = buildWorld(minimalSystem(), 'm')
    const plain = run(world, 'm').spans
    const slow = run(world, 'm', 0, { onServe: (ctx) => (ctx.component === 'store' ? { addLatencyMs: 25 } : undefined) }).spans
    expect(slow.map((s) => s.spanId)).toEqual(plain.map((s) => s.spanId))
    // In this chain every span is the store span or one of its ancestors: all grow by exactly 25 ms.
    slow.forEach((s, i) => {
      const p = plain[i] as SpanRecord
      expect(s.durationMs - p.durationMs).toBe(25)
      expect({ ...s, durationMs: 0, startMs: 0 }).toEqual({ ...p, durationMs: 0, startMs: 0 })
    })
  })

  it('onCall.waitMs becomes an internal span before the client span, then the call proceeds', () => {
    const world = buildWorld(minimalSystem(), 'm')
    const result = run(world, 'm', 0, {
      onCall: (ctx) => (ctx.target === 'store' ? { waitMs: 15, waitOperation: 'db.acquire' } : ctx.target === 'back' ? { waitMs: 2 } : undefined),
    })
    expect(treeViolations(result, 0)).toEqual([])
    const spans = result.spans.filter((s) => s.traceId === 't0r0')
    expect(spans.map((s) => `${s.component}:${s.kind}:${s.operation}`)).toEqual([
      'front:server:http.request',
      `front:internal:${DEFAULT_WAIT_OPERATION}`,
      'front:client:back.do',
      'back:server:back.do',
      'back:internal:db.acquire',
      'back:client:db.query',
      'store:server:db.query',
    ])
    const acquire = spans[4] as SpanRecord
    // front: 5 ms own, 2 ms wait, then back starts at 7; back: 5 ms own, acquire 12..27, client at 27.
    expect(spans[3]?.startMs).toBe(7)
    expect(acquire).toMatchObject({ durationMs: 15, status: 'ok', startMs: 12 })
    expect(acquire.parentId).toBe(spans[3]?.spanId)
    expect(spans[5]?.startMs).toBe(27)
    expect(spans[0]?.durationMs).toBe(30 + 15 + 2)
  })

  it('onCall.fail after a wait: client error without server, as a pool timeout would look', () => {
    const world = buildWorld(minimalSystem(), 'm')
    const result = run(world, 'm', 0, {
      onCall: (ctx) =>
        ctx.target === 'store' ? { waitMs: 50, waitOperation: 'db.acquire', fail: { message: 'pool timeout', attrs: { poolSize: 5 } } } : undefined,
    })
    expect(treeViolations(result, 0)).toEqual([])
    const spans = result.spans.filter((s) => s.traceId === 't0r0')
    const client = spans.find((s) => s.component === 'back' && s.kind === 'client') as SpanRecord
    expect(client).toMatchObject({ status: 'error', durationMs: FAST_FAIL_MS })
    expect(childrenOf(spans, client.spanId)).toEqual([])
    expect(result.errors.find((e) => e.spanId === client.spanId)).toEqual({
      spanId: client.spanId,
      message: 'pool timeout',
      attrs: { attempt: 0, poolSize: 5 },
    })
    expect(spans.some((s) => s.component === 'store')).toBe(false)
  })

  it('a wait that reaches the caller deadline cancels the attempt', () => {
    const world = buildWorld(minimalSystem({ timeoutMs: 30, retries: 0 }), 'm')
    const result = run(world, 'm', 0, { onCall: (ctx) => (ctx.target === 'store' ? { waitMs: 1000 } : undefined) })
    expect(treeViolations(result, 0)).toEqual([])
    const spans = result.spans.filter((s) => s.traceId === 't0r0')
    expect(spans.map((s) => `${s.component}:${s.kind}:${s.status}`)).toEqual([
      'front:server:error',
      'front:client:error',
      'back:server:ok',
      'back:internal:ok',
    ])
  })

  it('empty hooks (or hooks returning undefined) do not change anything', () => {
    for (let s = 0; s < 5; s++) {
      const plain = run(shop, `noop-${s}`, s)
      const noop = run(shop, `noop-${s}`, s, {
        onTick: () => undefined,
        onServe: () => undefined,
        onCall: () => ({}),
        onResources: () => undefined,
      })
      expect(hashOf(noop)).toBe(hashOf(plain))
      expect(hashOf(run(shop, `noop-${s}`, s, { onServe: () => ({ addLatencyMs: 0 }), onCall: () => ({ waitMs: 0 }) }))).toBe(hashOf(plain))
    }
  })

  it('fake hooks do not alter traffic streams they do not use: traces that never reach the hooked component are identical', () => {
    for (let s = 0; s < 10; s++) {
      for (const tick of [0, 5]) {
        const plain = run(shop, `iso-${s}`, tick)
        const hooked = run(shop, `iso-${s}`, tick, {
          onCall: (ctx) => (ctx.target === 'payment' ? { fail: { message: 'nope' } } : undefined),
        })
        const touches = (spans: readonly SpanRecord[]) => spans.some((x) => x.component === 'payment' || x.peer === 'payment')
        const a = byTrace(plain.spans)
        const b = byTrace(hooked.spans)
        expect([...b.keys()]).toEqual([...a.keys()])
        let compared = 0
        for (const [traceId, spans] of a) {
          if (touches(spans)) continue
          expect(b.get(traceId)).toEqual(spans)
          compared += 1
        }
        expect(compared).toBeGreaterThan(8)
      }
    }
  })
})

// --- emergent behaviour (H4, SPEC §3.4) -------------------------------------------------------

describe('emergent behaviour of the default-shop', () => {
  it('a slow dependency causes a retry storm and errors in callers, not in the slow dependency', () => {
    const stats = (hooks: FaultHooks) => {
      let pgClients = 0
      const errorsBy = new Map<string, number>()
      for (let tick = 0; tick < 20; tick++) {
        const result = run(shop, 'storm', tick, hooks)
        for (const s of result.spans) {
          if (s.kind === 'client' && s.peer === 'postgres') pgClients += 1
          if (s.kind === 'server' && s.status === 'error') errorsBy.set(s.component, (errorsBy.get(s.component) ?? 0) + 1)
        }
      }
      return { pgClients, errorsBy }
    }
    const baseline = stats({})
    const slow = stats({ onServe: (ctx) => (ctx.component === 'postgres' ? { addLatencyMs: 1500 } : undefined) })
    expect(slow.pgClients).toBeGreaterThanOrEqual(2 * baseline.pgClients)
    expect(slow.errorsBy.get('postgres') ?? 0).toBe(0)
    expect([...slow.errorsBy.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  })

  it('a down instance shows up as errors in the caller (indirect signal)', () => {
    const result = run(shop, 'down', 0, {}, ['catalog-0', 'catalog-1', 'catalog-2'])
    const gatewayErrors = result.spans.filter((s) => s.component === 'gateway' && s.status === 'error')
    expect(gatewayErrors.length).toBeGreaterThan(0)
    expect(result.spans.some((s) => s.component === 'catalog')).toBe(false)
  })
})

// --- determinism ---------------------------------------------------------------------------------

describe('determinism (DET)', () => {
  it('same RngFactory seed ⇒ same spans and errors (hash of two runs)', () => {
    for (const seed of ['a', 'b', 'gate1']) {
      for (const tick of [0, 13]) {
        const hooks = randomHookSets()[0] as FaultHooks
        expect(hashOf(run(shop, seed, tick, hooks, ['auth-1']))).toBe(hashOf(run(shop, seed, tick, hooks, ['auth-1'])))
      }
    }
  })

  it('different seeds or ticks ⇒ different spans', () => {
    const hashes = new Set<string>()
    for (let s = 0; s < 10; s++) hashes.add(hashOf(run(shop, `seed-${s}`, 0)))
    for (let t = 1; t < 5; t++) hashes.add(hashOf(run(shop, 'seed-0', t)))
    expect(hashes.size).toBe(14)
  })

  it('does not mutate its input', () => {
    const world = buildWorld(defaultShop, 'frozen')
    const snapshot = JSON.stringify(world)
    const down = new Set<InstanceId>(['auth-0'])
    const input: TrafficInput = { world, tick: 2, rng: createRngFactory('frozen'), down, hooks: {} }
    generateTraffic(input)
    expect(JSON.stringify(world)).toBe(snapshot)
    expect([...down]).toEqual(['auth-0'])
  })
})

// --- integration: traffic → deriveMetrics → generateLogs (P-1, P-2, P-3, S-3) -------------------

/** Independent nearest-rank (P-1): sorted[ceil(p/100 × n) − 1], 0 when empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] as number
}

function expectRequestMetrics(record: MetricRecord, servers: SpanRecord[], label: string): void {
  const n = servers.length
  const durations = servers.map((s) => s.durationMs)
  const errors = servers.filter((s) => s.status === 'error').length
  expect(record.rps, label).toBeCloseTo(n / 10, 9)
  expect(record.errorPct, label).toBeCloseTo(n === 0 ? 0 : (errors / n) * 100, 9)
  expect(record.p50, label).toBe(percentile(durations, 50))
  expect(record.p95, label).toBe(percentile(durations, 95))
  expect(record.p99, label).toBe(percentile(durations, 99))
}

/** Deterministic test-only fault hooks covering latency, waits, caller-side and server failures. */
function randomHookSets(): FaultHooks[] {
  const hashed = (text: string): number => {
    let h = 2166136261
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
    return (h >>> 0) / 4294967296
  }
  return [
    // slow database: timeouts and retries everywhere
    { onServe: (ctx) => (ctx.component === 'postgres' ? { addLatencyMs: 1500 } : undefined) },
    // bad instance of a service
    { onServe: (ctx) => (ctx.instance === 'catalog-1' && hashed(ctx.traceId + ctx.instance) < 0.6 ? { fail: { message: 'unhandled exception' } } : undefined) },
    // pool-like waits and timeouts on one caller
    {
      onCall: (ctx) =>
        ctx.caller === 'payment' && ctx.target === 'postgres'
          ? hashed(ctx.traceId + ctx.attempt) < 0.5
            ? { waitMs: 2000, waitOperation: 'db.acquire', fail: { message: 'connection pool timeout' } }
            : { waitMs: 300, waitOperation: 'db.acquire' }
          : undefined,
    },
    // cold cache plus a failing database fraction
    {
      onCall: (ctx) => (ctx.target === 'redis' ? { forceCacheMiss: true } : undefined),
      onServe: (ctx) => (ctx.component === 'postgres' && hashed(ctx.traceId) < 0.4 ? { fail: { message: 'no space left on device' } } : undefined),
    },
  ]
}

describe('integration with deriveMetrics and generateLogs (P-1, P-2, P-3, S-3)', () => {
  it('metrics and logs derived from the traffic of N seeds are coherent with its spans', () => {
    const hookSets: FaultHooks[] = [{}, ...randomHookSets()]
    const downSets: InstanceId[][] = [[], ['catalog-0'], ['redis-0'], ['gateway-2', 'payment-1']]
    let errorSpans = 0
    for (let s = 0; s < 20; s++) {
      const seed = `coherence-${s}`
      const world = buildWorld(defaultShop, seed)
      const rng = createRngFactory(seed)
      for (let tick = 0; tick < 3; tick++) {
        const hooks = hookSets[(s + tick) % hookSets.length] as FaultHooks
        const down = new Set(downSets[s % downSets.length])
        const traffic = generateTraffic({ world, tick, rng, down, hooks })
        expect(treeViolations(traffic, tick)).toEqual([])

        const metrics = deriveMetrics({ world, tick, spans: traffic.spans, down, resourceEffects: new Map(), rng })
        const components = [...world.services, ...world.deps]
        expect(metrics).toHaveLength(components.reduce((n, c) => n + c.instances.length + 1, 0))
        for (const c of components) {
          const servers = traffic.spans.filter((x) => x.kind === 'server' && x.component === c.name)
          for (const instance of c.instances) {
            const record = metrics.find((m) => m.component === c.name && m.instance === instance) as MetricRecord
            expectRequestMetrics(record, servers.filter((x) => x.instance === instance), `${seed}/${tick}/${instance}`)
          }
          const aggregate = metrics.find((m) => m.component === c.name && m.instance === undefined) as MetricRecord
          expectRequestMetrics(aggregate, servers, `${seed}/${tick}/${c.name}`)
        }

        const logs = generateLogs({ world, tick, spans: traffic.spans, errors: traffic.errors, faultLogs: [], rng })
        for (const span of traffic.spans.filter((x) => x.status === 'error')) {
          errorSpans += 1
          const matching = logs.filter(
            (l) => l.level === 'error' && l.component === span.component && l.instance === span.instance && l.tick === tick && l.traceId === span.traceId,
          )
          expect(matching.length, span.spanId).toBeGreaterThanOrEqual(1)
        }
        expect(logs.filter((l) => l.level === 'error')).toHaveLength(traffic.errors.length)
      }
    }
    // The run exercised error paths, not only the happy path.
    expect(errorSpans).toBeGreaterThan(100)
  })
})
