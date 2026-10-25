/**
 * T1.10 — `trace` handler (ADR-006, PRD Q-6), tested against a fake TelemetryView.
 *
 * The fake view computes its aggregate MetricRecords with an independent nearest-rank
 * implementation, so "focused duration = pXX of the dashboard aggregate in the same tick"
 * is checked against a second, test-owned derivation (Q-6).
 */
import { describe, expect, it } from 'vitest'
import { trace } from '../../src/questions/trace.js'
import { nearestRankIndex } from '../../src/sim/metrics.js'
import type {
  MetricRecord,
  QuestionContext,
  QuestionOf,
  Service,
  SpanRecord,
  TelemetryRecord,
  TelemetryView,
  World,
} from '../../src/types.js'

// --- fake world / view -------------------------------------------------------------------

function service(name: string, replicas: number): Service {
  return {
    name,
    replicas,
    latencyP50Ms: 20,
    latencyP99Ms: 200,
    cpuBasePct: 5,
    cpuPerRequestPct: 0.5,
    memBaseMb: 256,
    calls: [],
    dbPoolSize: 10,
    instances: Array.from({ length: replicas }, (_, i) => `${name}-${i}`),
  }
}

function makeWorld(tick: number): World {
  return {
    services: [service('gateway', 3), service('payment', 3)],
    deps: [
      {
        name: 'postgres',
        kind: 'database',
        replicas: 1,
        latencyP50Ms: 5,
        latencyP99Ms: 50,
        cpuBasePct: 10,
        cpuPerRequestPct: 0.1,
        memBaseMb: 1024,
        maxConnections: 100,
        instances: ['postgres-0'],
      },
    ],
    tick,
    seed: 'fake',
  }
}

/** Independent nearest-rank (ADR-005): sorted[ceil(p/100 * n) - 1], 0 when n = 0. */
function refPercentile(durations: readonly number[], p: number): number {
  if (durations.length === 0) return 0
  const sorted = [...durations].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] as number
}

function aggregate(component: string, tick: number, spans: readonly SpanRecord[]): MetricRecord {
  const servers = spans.filter((s) => s.component === component && s.kind === 'server' && s.tick === tick)
  const d = servers.map((s) => s.durationMs)
  const errors = servers.filter((s) => s.status === 'error').length
  return {
    type: 'metric',
    tick,
    component,
    rps: servers.length / 10,
    p50: refPercentile(d, 50),
    p95: refPercentile(d, 95),
    p99: refPercentile(d, 99),
    errorPct: servers.length === 0 ? 0 : (errors / servers.length) * 100,
    cpu: 0,
    mem: 0,
    connections: 0,
  }
}

function fakeView(world: World, records: readonly TelemetryRecord[]): TelemetryView {
  const metrics = records.filter((r): r is MetricRecord => r.type === 'metric')
  const spans = records.filter((r): r is SpanRecord => r.type === 'span')
  return {
    world,
    now: world.tick,
    metricsOf: (c, from, to) => metrics.filter((m) => m.component === c && m.tick >= from && m.tick <= to),
    logsOf: () => [],
    spansOf: (c, tick) => spans.filter((s) => s.component === c && s.tick === tick),
    traceOf: (id) => spans.filter((s) => s.traceId === id),
    eventsIn: () => [],
    all: () => records,
  }
}

const ctxOf = (view: TelemetryView): QuestionContext => ({
  view,
  lastWeek: () => {
    throw new Error('trace must not read lastWeek')
  },
})

/** Deterministic test PRNG (LCG), so fixtures are reproducible without Math.random. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * Builds ticks [0, now] of telemetry: per tick, `n` gateway roots each calling payment
 * (client span on gateway + server span on payment + internal db span on payment).
 */
function telemetry(now: number, n: number, seed: number): { world: World; records: TelemetryRecord[] } {
  const rand = lcg(seed)
  const records: TelemetryRecord[] = []
  for (let tick = 0; tick <= now; tick++) {
    const spans: SpanRecord[] = []
    for (let i = 0; i < n; i++) {
      const traceId = `t${tick}-${i}`
      const inst = i % 3
      const payDur = 10 + Math.floor(rand() * 40) * 5 // multiples of 5 -> ties are common
      const status = rand() < 0.1 ? 'error' : 'ok'
      spans.push(
        { type: 'span', tick, traceId, spanId: `${traceId}-a`, component: 'gateway', instance: `gateway-${inst}`, operation: 'http.checkout', kind: 'server', startMs: 0, durationMs: payDur + 20, status },
        { type: 'span', tick, traceId, spanId: `${traceId}-b`, parentId: `${traceId}-a`, component: 'gateway', instance: `gateway-${inst}`, operation: 'payment.charge', kind: 'client', peer: 'payment', startMs: 5, durationMs: payDur + 10, status },
        { type: 'span', tick, traceId, spanId: `${traceId}-c`, parentId: `${traceId}-b`, component: 'payment', instance: `payment-${inst}`, operation: 'payment.charge', kind: 'server', startMs: 10, durationMs: payDur, status },
        { type: 'span', tick, traceId, spanId: `${traceId}-d`, parentId: `${traceId}-c`, component: 'payment', instance: `payment-${inst}`, operation: 'db.acquire', kind: 'internal', startMs: 11, durationMs: 1, status: 'ok' },
      )
    }
    records.push(aggregate('gateway', tick, spans), aggregate('payment', tick, spans), aggregate('postgres', tick, spans))
    records.push(...spans)
  }
  return { world: makeWorld(now), records }
}

const ask = (view: TelemetryView, q: Omit<QuestionOf<'trace'>, 'kind'>) => trace({ kind: 'trace', ...q }, ctxOf(view))
const percentiles = [50, 95, 99] as const

// --- tests -------------------------------------------------------------------------------

describe('trace handler (Q-6)', () => {
  for (const n of [1, 2, 3, 7, 10, 12, 20, 101]) {
    for (const percentile of percentiles) {
      it(`n=${n} p${percentile}: focus is the nearest-rank server span and equals the dashboard pXX`, () => {
        const { world, records } = telemetry(8, n, 1000 + n)
        const view = fakeView(world, records)
        for (const service of ['payment', 'gateway']) {
          const signal = ask(view, { service, percentile })
          const servers = view.spansOf(service, view.now).filter((s) => s.kind === 'server')
          const focus = signal.spans.find((s) => s.spanId === signal.focusSpanId)
          expect(focus, `${service}`).toBeDefined()
          expect(focus?.component).toBe(service)
          expect(focus?.kind).toBe('server')
          expect(focus?.tick).toBe(view.now)
          expect(focus?.durationMs).toBe(refPercentile(servers.map((s) => s.durationMs), percentile))
          const dash = view.metricsOf(service, view.now, view.now).find((m) => m.instance === undefined)
          expect(focus?.durationMs).toBe(dash?.[`p${percentile}`])
        }
      })
    }
  }

  it('returns the signal header with service, tick = now and the percentile', () => {
    const { world, records } = telemetry(4, 5, 7)
    const signal = ask(fakeView(world, records), { service: 'payment', percentile: 95 })
    expect(signal.kind).toBe('trace')
    expect(signal.service).toBe('payment')
    expect(signal.tick).toBe(4)
    expect(signal.percentile).toBe(95)
  })

  it('returns the whole focused trace in generation order, across components', () => {
    const { world, records } = telemetry(3, 6, 11)
    const view = fakeView(world, records)
    const signal = ask(view, { service: 'payment', percentile: 50 })
    const focus = signal.spans.find((s) => s.spanId === signal.focusSpanId) as SpanRecord
    expect(signal.spans).toEqual(view.traceOf(focus.traceId))
    expect(signal.spans.map((s) => s.spanId)).toEqual(['a', 'b', 'c', 'd'].map((x) => `${focus.traceId}-${x}`))
    expect(new Set(signal.spans.map((s) => s.component))).toEqual(new Set(['gateway', 'payment']))
  })

  it('returns a copy of the trace, not the view array (read-only use of the view, Q-3)', () => {
    const { world, records } = telemetry(2, 4, 3)
    const view = fakeView(world, records)
    const shared = view.traceOf('t2-0')
    const signal = trace(
      { kind: 'trace', service: 'payment', percentile: 99 },
      ctxOf({ ...view, traceOf: () => shared }),
    )
    expect(signal.spans).not.toBe(shared)
    expect(signal.spans).toEqual(shared)
  })

  it('breaks duration ties by generation order (first generated wins)', () => {
    const world = makeWorld(0)
    const span = (id: string, durationMs: number): SpanRecord => ({
      type: 'span', tick: 0, traceId: id, spanId: `${id}-s`, component: 'payment', instance: 'payment-0', operation: 'op', kind: 'server', startMs: 0, durationMs, status: 'ok',
    })
    // durations sorted: 10, 20(x), 20(y), 20(z), 30 -> p50 rank ceil(2.5)=3 -> second 20 = y
    const records = [span('w', 30), span('x', 20), span('y', 20), span('a', 10), span('z', 20)]
    const view = fakeView(world, records)
    expect(ask(view, { service: 'payment', percentile: 50 }).focusSpanId).toBe('y-s')
    // p95/p99 rank 5 -> 30 = w
    expect(ask(view, { service: 'payment', percentile: 95 }).focusSpanId).toBe('w-s')
    expect(ask(view, { service: 'payment', percentile: 99 }).focusSpanId).toBe('w-s')
  })

  it('#21: a tie at the chosen rank is won by the first generated span, not a later one', () => {
    // ADR-006 Emenda 1: generation order x=20, y=20, a=10, w=30. Sorted with ties by generation
    // order: a(10), x(20), y(20), w(30). p50 -> rank ceil(0.5 * 4) = 2 -> x. Reversing the tie
    // comparator would give y, so this test kills that mutation.
    const world = makeWorld(0)
    const span = (id: string, durationMs: number): SpanRecord => ({
      type: 'span', tick: 0, traceId: id, spanId: `${id}-s`, component: 'payment', instance: 'payment-0', operation: 'op', kind: 'server', startMs: 0, durationMs, status: 'ok',
    })
    const records = [span('x', 20), span('y', 20), span('a', 10), span('w', 30)]
    const view = fakeView(world, records)
    expect(ask(view, { service: 'payment', percentile: 50 }).focusSpanId).toBe('x-s')
    // p95 / p99 -> rank 4 -> w (no tie there).
    expect(ask(view, { service: 'payment', percentile: 95 }).focusSpanId).toBe('w-s')
    expect(ask(view, { service: 'payment', percentile: 99 }).focusSpanId).toBe('w-s')
    // Same durations, y generated first: the tie now goes to y.
    const swapped = fakeView(world, [span('y', 20), span('x', 20), span('a', 10), span('w', 30)])
    expect(ask(swapped, { service: 'payment', percentile: 50 }).focusSpanId).toBe('y-s')
  })

  it('uses the nearest-rank index of src/sim/metrics.ts (single implementation, ADR-006 Emenda 1)', () => {
    const world = makeWorld(0)
    for (const n of [1, 2, 3, 4, 5, 19, 20, 21, 99, 100, 101]) {
      // Distinct durations, generated in descending order so sorting is exercised.
      const records: SpanRecord[] = Array.from({ length: n }, (_, i) => ({
        type: 'span', tick: 0, traceId: `t${i}`, spanId: `t${i}-s`, component: 'payment', instance: 'payment-0', operation: 'op', kind: 'server', startMs: 0, durationMs: 1000 - i, status: 'ok',
      }))
      const ascending = [...records].sort((a, b) => a.durationMs - b.durationMs)
      for (const percentile of percentiles) {
        const expected = ascending[nearestRankIndex(n, percentile)]?.spanId
        expect(ask(fakeView(world, records), { service: 'payment', percentile }).focusSpanId, `n=${n} p${percentile}`).toBe(expected)
      }
    }
  })

  it('only considers server spans of the service in the current tick', () => {
    const world = makeWorld(5)
    const base = { type: 'span', instance: 'payment-0', operation: 'op', startMs: 0, status: 'ok' } as const
    const records: SpanRecord[] = [
      { ...base, tick: 4, traceId: 'old', spanId: 'old-s', component: 'payment', kind: 'server', durationMs: 9999 },
      { ...base, tick: 5, traceId: 'cli', spanId: 'cli-s', component: 'payment', kind: 'client', peer: 'postgres', durationMs: 8888 },
      { ...base, tick: 5, traceId: 'int', spanId: 'int-s', component: 'payment', kind: 'internal', durationMs: 7777 },
      { ...base, tick: 5, traceId: 'gw', spanId: 'gw-s', component: 'gateway', instance: 'gateway-0', kind: 'server', durationMs: 6666 },
      { ...base, tick: 5, traceId: 'ok', spanId: 'ok-s', component: 'payment', kind: 'server', durationMs: 12 },
    ]
    for (const percentile of percentiles) {
      expect(ask(fakeView(world, records), { service: 'payment', percentile }).focusSpanId).toBe('ok-s')
    }
  })

  it('empty tick: focusSpanId null and no spans', () => {
    const { world, records } = telemetry(3, 4, 5)
    const view = fakeView(world, records)
    for (const percentile of percentiles) {
      expect(ask(view, { service: 'postgres', percentile })).toEqual({
        kind: 'trace',
        service: 'postgres',
        tick: 3,
        percentile,
        focusSpanId: null,
        spans: [],
      })
    }
    expect(ask(fakeView(makeWorld(0), []), { service: 'payment', percentile: 99 }).focusSpanId).toBeNull()
  })
})

describe('trace handler determinism (DET)', () => {
  it('same view + same question => equal Signal, byte-identical JSON', () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const a = telemetry(10, 12, seed)
      const b = telemetry(10, 12, seed)
      for (const percentile of percentiles) {
        const first = ask(fakeView(a.world, a.records), { service: 'payment', percentile })
        const again = ask(fakeView(a.world, a.records), { service: 'payment', percentile })
        const other = ask(fakeView(b.world, b.records), { service: 'payment', percentile })
        expect(again).toStrictEqual(first)
        expect(JSON.stringify(other)).toBe(JSON.stringify(first))
      }
    }
  })

  it('does not mutate the view records', () => {
    const { world, records } = telemetry(5, 9, 77)
    const before = JSON.stringify(records)
    const view = fakeView(world, records)
    for (const percentile of percentiles) ask(view, { service: 'payment', percentile })
    expect(JSON.stringify(records)).toBe(before)
  })
})
