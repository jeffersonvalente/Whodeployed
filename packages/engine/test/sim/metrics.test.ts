/**
 * T1.6 — deriveMetrics (ADR-005 "Métricas"; PRD S-1, P-1, P-2, W-4).
 *
 * P-1/P-2 are proven by construction: synthetic spans go in, and an independent recomputation
 * written here (straight from the PRD formulas) must match every record, for hundreds of seeds.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CPU_JITTER_PCT,
  MEM_JITTER_RATIO,
  deriveMetrics,
  distribute,
  nearestRank,
  nearestRankIndex,
  requestMetrics,
} from '../../src/sim/metrics.js'
import type {
  DeriveMetricsInput,
  Dependency,
  InstanceId,
  MetricRecord,
  ResourceEffect,
  Rng,
  RngFactory,
  Service,
  SpanRecord,
  World,
} from '../../src/types.js'

// --- test-local seeded PRNG (src/sim/rng.ts is another task; tests must not depend on it) ---

function hash32(text: string): number {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

function rngFrom(seed: number): Rng {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)] as never,
  }
}

const factory =
  (seed: string): RngFactory =>
  (...k) =>
    rngFrom(hash32([seed, ...k].join('\u001f')))

// --- fixtures ---------------------------------------------------------------------------

function service(name: string, replicas: number, calls: Service['calls'] = []): Service {
  return {
    name,
    replicas,
    latencyP50Ms: 10,
    latencyP99Ms: 40,
    cpuBasePct: 5,
    cpuPerRequestPct: 1,
    memBaseMb: 256,
    calls,
    dbPoolSize: 20,
    instances: Array.from({ length: replicas }, (_, i) => `${name}-${i}`),
  }
}

function dependency(name: string, kind: Dependency['kind'], replicas = 1): Dependency {
  return {
    name,
    kind,
    replicas,
    latencyP50Ms: 2,
    latencyP99Ms: 8,
    cpuBasePct: 10,
    cpuPerRequestPct: 0.5,
    memBaseMb: 1024,
    maxConnections: 200,
    ...(kind === 'cache' ? { cacheHitRatio: 0.9 } : {}),
    instances: Array.from({ length: replicas }, (_, i) => `${name}-${i}`),
  }
}

const call = (target: string, operation: string) => ({ target, operation, ratio: 1, timeoutMs: 500, retries: 1 })

/** api -> (cache, onMiss db), api -> worker; worker -> db. Arbitrary world (W-3), not default-shop. */
function makeWorld(): World {
  return {
    seed: 'w',
    tick: 0,
    services: [
      service('api', 3, [
        { ...call('cache', 'cache.get'), onMiss: { target: 'db', operation: 'db.query', timeoutMs: 500, retries: 1 } },
        call('worker', 'worker.run'),
      ]),
      service('worker', 2, [call('db', 'db.update')]),
    ],
    deps: [dependency('db', 'database'), dependency('cache', 'cache')],
  }
}

let seq = 0
function span(partial: Partial<SpanRecord> & Pick<SpanRecord, 'component' | 'instance'>): SpanRecord {
  seq += 1
  return {
    type: 'span',
    tick: 7,
    traceId: `t7r${seq}`,
    spanId: `t7r${seq}s0`,
    operation: 'op',
    kind: 'server',
    startMs: 0,
    durationMs: 10,
    status: 'ok',
    ...partial,
  }
}

function input(world: World, spans: SpanRecord[], over: Partial<DeriveMetricsInput> = {}): DeriveMetricsInput {
  return {
    world,
    tick: 7,
    spans,
    down: new Set(),
    resourceEffects: new Map(),
    rng: factory('metrics-test'),
    ...over,
  }
}

const find = (records: MetricRecord[], component: string, instance?: string) => {
  const r = records.find((x) => x.component === component && x.instance === instance)
  if (!r) throw new Error(`no record for ${component}/${instance ?? 'aggregate'}`)
  return r
}

// --- independent reference (PRD P-1 literal) -----------------------------------------------

function reference(spans: readonly SpanRecord[]) {
  const d = spans.map((s) => s.durationMs).sort((a, b) => a - b)
  const n = d.length
  const pct = (p: number) => (n === 0 ? 0 : (d[Math.ceil((p / 100) * n) - 1] as number))
  return {
    rps: n / 10,
    errorPct: n === 0 ? 0 : (spans.filter((s) => s.status === 'error').length / n) * 100,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
  }
}

/** Random tick of spans over the world: server spans everywhere, plus client/internal noise. */
function randomSpans(world: World, rng: Rng): SpanRecord[] {
  const out: SpanRecord[] = []
  const comps = [...world.services, ...world.deps]
  const count = rng.int(0, 60)
  for (let i = 0; i < count; i++) {
    const c = rng.pick(comps)
    const instance = rng.pick(c.instances)
    const kind = rng.pick(['server', 'server', 'server', 'client', 'internal'] as const)
    out.push(
      span({
        component: c.name,
        instance,
        kind,
        ...(kind === 'client' ? { peer: rng.pick(comps).name } : {}),
        durationMs: rng.chance(0.2) ? rng.int(0, 5) : rng.int(0, 3000),
        status: rng.chance(0.15) ? 'error' : 'ok',
      }),
    )
  }
  return out
}

// --- tests -------------------------------------------------------------------------------

describe('nearestRank', () => {
  it('is 0 on an empty set', () => {
    expect(nearestRank([], 50)).toBe(0)
    expect(nearestRank([], 99)).toBe(0)
  })

  it('returns the only sample for every percentile', () => {
    for (const p of [50, 95, 99]) expect(nearestRank([42], p)).toBe(42)
  })

  it('follows sorted[ceil(p/100 × n) − 1]', () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(nearestRank(v, 50)).toBe(10)
    expect(nearestRank(v, 95)).toBe(19)
    expect(nearestRank(v, 99)).toBe(20)
    expect(nearestRank([1, 2, 3], 50)).toBe(2)
    expect(nearestRank([1, 2, 3], 95)).toBe(3)
  })

  it('handles ties', () => {
    expect(nearestRank([5, 5, 5, 9], 50)).toBe(5)
    expect(nearestRank([5, 5, 5, 9], 99)).toBe(9)
  })

  it('matches the PRD formula for every n up to 1000', () => {
    for (let n = 1; n <= 1000; n++) {
      const v = Array.from({ length: n }, (_, i) => i)
      for (const p of [50, 95, 99]) expect(nearestRank(v, p)).toBe(Math.ceil((p / 100) * n) - 1)
    }
  })
})

describe('nearestRankIndex (ADR-006 Emenda 1)', () => {
  it('is -1 when n = 0', () => {
    for (const p of [50, 95, 99]) expect(nearestRankIndex(0, p)).toBe(-1)
  })

  it('is 0 for a single sample', () => {
    for (const p of [50, 95, 99]) expect(nearestRankIndex(1, p)).toBe(0)
  })

  it('follows min(n, max(1, ceil(p × n / 100))) − 1', () => {
    expect(nearestRankIndex(4, 50)).toBe(1)
    expect(nearestRankIndex(4, 95)).toBe(3)
    expect(nearestRankIndex(20, 50)).toBe(9)
    expect(nearestRankIndex(20, 95)).toBe(18)
    expect(nearestRankIndex(20, 99)).toBe(19)
    expect(nearestRankIndex(100, 95)).toBe(94)
    expect(nearestRankIndex(100, 99)).toBe(98)
    expect(nearestRankIndex(101, 99)).toBe(99)
  })

  it('clamps to [0, n - 1] at the extremes', () => {
    expect(nearestRankIndex(10, 0)).toBe(0)
    expect(nearestRankIndex(10, 100)).toBe(9)
  })

  it('is the index nearestRank reads, for every n up to 1000', () => {
    for (let n = 1; n <= 1000; n++) {
      const v = Array.from({ length: n }, (_, i) => i * 3)
      for (const p of [50, 95, 99]) {
        const index = nearestRankIndex(n, p)
        expect(index).toBe(Math.ceil((p / 100) * n) - 1)
        expect(nearestRank(v, p)).toBe(v[index])
      }
    }
  })
})

describe('requestMetrics', () => {
  it('is all zeros when n = 0', () => {
    expect(requestMetrics([])).toEqual({ rps: 0, p50: 0, p95: 0, p99: 0, errorPct: 0 })
  })

  it('uses 10 s ticks and exact error ratio (W-4, P-1)', () => {
    const spans = [
      span({ component: 'a', instance: 'a-0', durationMs: 30, status: 'error' }),
      span({ component: 'a', instance: 'a-0', durationMs: 10 }),
      span({ component: 'a', instance: 'a-0', durationMs: 20 }),
    ]
    expect(requestMetrics(spans)).toEqual({ rps: 0.3, p50: 20, p95: 30, p99: 30, errorPct: (1 / 3) * 100 })
  })
})

describe('deriveMetrics — shape (S-1, ADR-005 order)', () => {
  it('emits instances then aggregate, per component in world order (services, then deps)', () => {
    const world = makeWorld()
    const records = deriveMetrics(input(world, []))
    expect(records.map((r) => `${r.component}/${r.instance ?? '*'}`)).toEqual([
      'api/api-0',
      'api/api-1',
      'api/api-2',
      'api/*',
      'worker/worker-0',
      'worker/worker-1',
      'worker/*',
      'db/db-0',
      'db/*',
      'cache/cache-0',
      'cache/*',
    ])
  })

  it('has exactly the 8 metrics of S-1 plus the record header, with an integer tick', () => {
    const world = makeWorld()
    const metricNames = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']
    for (const r of deriveMetrics(input(world, randomSpans(world, rngFrom(1))))) {
      const keys = Object.keys(r)
      expect(keys).toEqual(['type', 'tick', 'component', ...(r.instance === undefined ? [] : ['instance']), ...metricNames])
      expect(r.type).toBe('metric')
      expect(Number.isInteger(r.tick)).toBe(true)
      expect(r.tick).toBe(7)
      for (const m of metricNames) expect(Number.isFinite(r[m as keyof MetricRecord])).toBe(true)
    }
  })

  it('only counts server spans in request metrics', () => {
    const world = makeWorld()
    const spans = [
      span({ component: 'api', instance: 'api-0', durationMs: 100 }),
      span({ component: 'api', instance: 'api-0', kind: 'client', peer: 'worker', durationMs: 5000, status: 'error' }),
      span({ component: 'api', instance: 'api-0', kind: 'internal', durationMs: 7000, status: 'error' }),
    ]
    const r = find(deriveMetrics(input(world, spans)), 'api', 'api-0')
    expect([r.rps, r.p50, r.p99, r.errorPct]).toEqual([0.1, 100, 100, 0])
  })
})

describe('deriveMetrics — coherence by construction (P-1, P-2)', () => {
  it('per-instance and aggregate request metrics equal the recomputation from spans, over 300 seeds', () => {
    const world = makeWorld()
    const comps = [...world.services, ...world.deps]
    for (let s = 0; s < 300; s++) {
      const spans = randomSpans(world, rngFrom(hash32(`p1-${s}`)))
      const records = deriveMetrics(input(world, spans, { rng: factory(`seed-${s}`) }))
      expect(records).toHaveLength(comps.reduce((n, c) => n + c.instances.length + 1, 0))
      for (const c of comps) {
        const server = spans.filter((x) => x.kind === 'server' && x.component === c.name)
        for (const instance of [...c.instances, undefined]) {
          const own = instance === undefined ? server : server.filter((x) => x.instance === instance)
          const want = reference(own)
          const got = find(records, c.name, instance)
          for (const m of ['rps', 'errorPct', 'p50', 'p95', 'p99'] as const) {
            expect(Math.abs(got[m] - want[m]), `${s} ${c.name}/${instance} ${m}`).toBeLessThanOrEqual(1e-9)
          }
        }
      }
    }
  })

  it('aggregate percentile is over the union of spans, not the mean of instance percentiles (P-2)', () => {
    const world = makeWorld()
    const spans = [
      span({ component: 'worker', instance: 'worker-0', durationMs: 10 }),
      span({ component: 'worker', instance: 'worker-0', durationMs: 10 }),
      span({ component: 'worker', instance: 'worker-0', durationMs: 10 }),
      span({ component: 'worker', instance: 'worker-1', durationMs: 1000 }),
    ]
    const records = deriveMetrics(input(world, spans))
    expect(find(records, 'worker', 'worker-0').p50).toBe(10)
    expect(find(records, 'worker', 'worker-1').p50).toBe(1000)
    const agg = find(records, 'worker')
    expect(agg.p50).toBe(10) // mean of instance p50 would be 505
    expect(agg.p99).toBe(1000)
    expect(agg.rps).toBe(0.4)
  })
})

describe('deriveMetrics — resource model (ADR-005)', () => {
  it('cpu = base + perRequest × n + jitter (bounded), mem = base + jitter, both with 1 decimal', () => {
    const world = makeWorld()
    const spans = Array.from({ length: 10 }, () => span({ component: 'api', instance: 'api-1' }))
    for (let s = 0; s < 50; s++) {
      const records = deriveMetrics(input(world, spans, { rng: factory(`res-${s}`) }))
      const busy = find(records, 'api', 'api-1')
      const idle = find(records, 'api', 'api-0')
      expect(Math.abs(busy.cpu - (5 + 1 * 10))).toBeLessThanOrEqual(CPU_JITTER_PCT + 0.05)
      expect(Math.abs(idle.cpu - 5)).toBeLessThanOrEqual(CPU_JITTER_PCT + 0.05)
      expect(Math.abs(idle.mem - 256)).toBeLessThanOrEqual(MEM_JITTER_RATIO * 256 + 0.05)
      for (const v of [busy.cpu, busy.mem, idle.cpu, idle.mem]) expect(Math.round(v * 10) / 10).toBe(v)
    }
  })

  it('aggregate cpu is the mean of instances, mem and connections are sums', () => {
    const world = makeWorld()
    const records = deriveMetrics(input(world, randomSpans(world, rngFrom(9))))
    const inst = records.filter((r) => r.component === 'api' && r.instance !== undefined)
    const agg = find(records, 'api')
    expect(agg.cpu).toBe(Math.round((inst.reduce((s, r) => s + r.cpu, 0) / 3) * 10) / 10)
    expect(agg.mem).toBe(Math.round(inst.reduce((s, r) => s + r.mem, 0) * 10) / 10)
    expect(agg.connections).toBe(inst.reduce((s, r) => s + r.connections, 0))
  })

  it('applies cpuPctAdd, memMbAdd and clamps cpu to 100', () => {
    const world = makeWorld()
    const effects = new Map<InstanceId, ResourceEffect>([
      ['api-0', { cpuPctAdd: 30, memMbAdd: 500 }],
      ['api-1', { cpuPctAdd: 1000 }],
      ['api-2', { cpuPctAdd: -1000 }],
    ])
    const base = deriveMetrics(input(world, []))
    const fx = deriveMetrics(input(world, [], { resourceEffects: effects }))
    expect(find(fx, 'api', 'api-0').cpu).toBeCloseTo(find(base, 'api', 'api-0').cpu + 30, 5)
    expect(find(fx, 'api', 'api-0').mem).toBeCloseTo(find(base, 'api', 'api-0').mem + 500, 5)
    expect(find(fx, 'api', 'api-1').cpu).toBe(100)
    expect(find(fx, 'api', 'api-2').cpu).toBe(0)
  })

  it('connections = ceil(Σ client ms to databases / 10000) + connectionsAdd, capped by connectionsCap', () => {
    const world = makeWorld()
    const spans = [
      span({ component: 'worker', instance: 'worker-0', kind: 'client', peer: 'db', durationMs: 12_000 }),
      span({ component: 'worker', instance: 'worker-0', kind: 'client', peer: 'db', durationMs: 13_000 }),
      span({ component: 'worker', instance: 'worker-1', kind: 'client', peer: 'db', durationMs: 1 }),
      // calls to a non-database peer do not count for the service metric
      span({ component: 'worker', instance: 'worker-1', kind: 'client', peer: 'api', durationMs: 50_000 }),
    ]
    const plain = deriveMetrics(input(world, spans))
    expect(find(plain, 'worker', 'worker-0').connections).toBe(3)
    expect(find(plain, 'worker', 'worker-1').connections).toBe(1)
    expect(find(plain, 'worker').connections).toBe(4)
    expect(find(plain, 'db', 'db-0').connections).toBe(4)
    expect(find(plain, 'db').connections).toBe(4)

    const leak = deriveMetrics(
      input(world, spans, {
        resourceEffects: new Map([
          ['worker-0', { connectionsAdd: 18 }],
          ['worker-1', { connectionsAdd: 50, connectionsCap: 20 }],
        ]),
      }),
    )
    expect(find(leak, 'worker', 'worker-0').connections).toBe(21)
    expect(find(leak, 'worker', 'worker-1').connections).toBe(20)
    // the dependency sees what its clients hold, including leaked connections
    expect(find(leak, 'db', 'db-0').connections).toBe(41)
  })

  it('counts cache occupancy on the cache dependency, not on the service metric', () => {
    const world = makeWorld()
    const spans = [
      span({ component: 'api', instance: 'api-0', kind: 'client', peer: 'cache', durationMs: 25_000 }),
      span({ component: 'api', instance: 'api-0', kind: 'client', peer: 'db', durationMs: 100 }),
    ]
    const records = deriveMetrics(input(world, spans))
    expect(find(records, 'api', 'api-0').connections).toBe(1)
    expect(find(records, 'cache', 'cache-0').connections).toBe(3)
    expect(find(records, 'db', 'db-0').connections).toBe(1)
  })

  it('a service without databases still reports connectionsAdd, and dependencies take their own effect', () => {
    const world: World = { ...makeWorld(), services: [service('solo', 1)] }
    const records = deriveMetrics(
      input(world, [], {
        resourceEffects: new Map([
          ['solo-0', { connectionsAdd: 4 }],
          ['db-0', { connectionsAdd: 500, connectionsCap: 200 }],
        ]),
      }),
    )
    expect(find(records, 'solo', 'solo-0').connections).toBe(4)
    expect(find(records, 'db', 'db-0').connections).toBe(200)
  })

  it('a down instance reports zeros except mem and holds no connections', () => {
    const world = makeWorld()
    const spans = [span({ component: 'worker', instance: 'worker-0', kind: 'client', peer: 'db', durationMs: 30_000 })]
    const up = deriveMetrics(input(world, spans))
    const records = deriveMetrics(
      input(world, spans, {
        down: new Set(['worker-0', 'cache-0']),
        resourceEffects: new Map([['worker-0', { cpuPctAdd: 50, connectionsAdd: 10 }]]),
      }),
    )
    const r = find(records, 'worker', 'worker-0')
    expect([r.rps, r.p50, r.p95, r.p99, r.errorPct, r.cpu, r.connections]).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(r.mem).toBe(find(up, 'worker', 'worker-0').mem)
    expect(find(records, 'db', 'db-0').connections).toBe(0)
    expect(find(records, 'cache', 'cache-0').cpu).toBe(0)
  })

  it('splits client connections among dependency instances by the instance that served them', () => {
    const world: World = { ...makeWorld(), deps: [dependency('db', 'database', 2), dependency('cache', 'cache')] }
    const c1 = span({ component: 'worker', instance: 'worker-0', kind: 'client', peer: 'db', durationMs: 30_000 })
    const c2 = span({ component: 'worker', instance: 'worker-0', kind: 'client', peer: 'db', durationMs: 10_000 })
    const spans = [
      c1,
      span({ component: 'db', instance: 'db-1', parentId: c1.spanId, traceId: c1.traceId, durationMs: 29_000 }),
      c2,
      span({ component: 'db', instance: 'db-0', parentId: c2.spanId, traceId: c2.traceId, durationMs: 9_000 }),
    ]
    const records = deriveMetrics(input(world, spans))
    expect(find(records, 'worker', 'worker-0').connections).toBe(4)
    expect(find(records, 'db', 'db-0').connections).toBe(1)
    expect(find(records, 'db', 'db-1').connections).toBe(3)
    expect(find(records, 'db').connections).toBe(4)
  })
})

describe('distribute', () => {
  const usage = (entries: [string, number][]) => ({ ms: 0, byInstance: new Map(entries) })

  it('uses largest remainder with ties to the lower index', () => {
    expect(distribute(3, ['a', 'b', 'c'], usage([['a', 1], ['b', 1], ['c', 1]]), new Set())).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ])
    expect(distribute(2, ['a', 'b', 'c'], usage([['a', 1], ['b', 1], ['c', 1]]), new Set())).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 0],
    ])
  })

  it('gives everything to the first up instance when nothing was served, nothing when all are down', () => {
    expect(distribute(5, ['a', 'b'], undefined, new Set(['a']))).toEqual([['b', 5]])
    expect(distribute(5, ['a'], undefined, new Set(['a']))).toEqual([])
  })
})

describe('deriveMetrics — determinism (DET)', () => {
  const sha = (records: MetricRecord[]) => createHash('sha256').update(JSON.stringify(records)).digest('hex')

  it('same input + same factory seed ⇒ identical records, byte for byte', () => {
    const world = makeWorld()
    const spans = randomSpans(world, rngFrom(123))
    const effects = new Map<InstanceId, ResourceEffect>([['api-1', { cpuPctAdd: 3, connectionsAdd: 2 }]])
    const a = deriveMetrics(input(world, spans, { rng: factory('det'), resourceEffects: effects }))
    const b = deriveMetrics(input(world, spans, { rng: factory('det'), resourceEffects: effects }))
    expect(b).toStrictEqual(a)
    expect(sha(b)).toBe(sha(a))
  })

  it('different seeds change resource jitter but never request metrics', () => {
    const world = makeWorld()
    const spans = randomSpans(world, rngFrom(77))
    const a = deriveMetrics(input(world, spans, { rng: factory('one') }))
    const b = deriveMetrics(input(world, spans, { rng: factory('two') }))
    expect(sha(a)).not.toBe(sha(b))
    const req = (r: MetricRecord) => [r.rps, r.p50, r.p95, r.p99, r.errorPct, r.connections]
    expect(b.map(req)).toEqual(a.map(req))
  })

  it('jitter of an instance does not depend on spans of other instances (per-instance stream)', () => {
    const world = makeWorld()
    const a = deriveMetrics(input(world, []))
    const b = deriveMetrics(input(world, [span({ component: 'api', instance: 'api-2', durationMs: 5 })]))
    expect(find(b, 'api', 'api-0')).toStrictEqual(find(a, 'api', 'api-0'))
    expect(find(b, 'worker', 'worker-1')).toStrictEqual(find(a, 'worker', 'worker-1'))
  })
})
