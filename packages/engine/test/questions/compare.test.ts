/**
 * T1.10 — `compare` handler (ADR-006, PRD Q-8), tested against fake TelemetryViews.
 *
 * `lastWeek` is whatever view the context injects (the dispatcher builds the real one with
 * seed `${seed}:lastWeek` in T1.16); here the test injects a second fake view and checks the
 * series equals that view's aggregate, tick by tick.
 */
import { describe, expect, it } from 'vitest'
import { COMPARE_WINDOW_TICKS, compare } from '../../src/questions/compare.js'
import type {
  CompareSignal,
  MetricName,
  MetricRecord,
  QuestionContext,
  QuestionOf,
  Service,
  TelemetryView,
  World,
} from '../../src/types.js'

const METRICS: readonly MetricName[] = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']

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

function makeWorld(tick: number, seed = 'fake'): World {
  return {
    services: [service('gateway', 3), service('catalog', 4)],
    deps: [
      {
        name: 'postgres',
        kind: 'database',
        replicas: 2,
        latencyP50Ms: 5,
        latencyP99Ms: 50,
        cpuBasePct: 10,
        cpuPerRequestPct: 0.1,
        memBaseMb: 1024,
        maxConnections: 100,
        instances: ['postgres-0', 'postgres-1'],
      },
    ],
    tick,
    seed,
  }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * Metric records for ticks [0, now]: per component, instance records then aggregate (ADR-005
 * order). `badInstance` (if given) gets a high errorPct, as a bad deploy on 1 of N would (F-5).
 */
function metrics(world: World, seed: number, badInstance?: string): MetricRecord[] {
  const rand = lcg(seed)
  const out: MetricRecord[] = []
  const value = () => Math.round(rand() * 1000) / 10
  for (let tick = 0; tick <= world.tick; tick++) {
    for (const c of [...world.services, ...world.deps]) {
      for (const instance of c.instances) {
        const r: MetricRecord = { type: 'metric', tick, component: c.name, instance, rps: value(), p50: value(), p95: value(), p99: value(), errorPct: value() / 20, cpu: value(), mem: value(), connections: Math.floor(value()) }
        if (instance === badInstance) r.errorPct = 60 + rand() * 10
        out.push(r)
      }
      out.push({ type: 'metric', tick, component: c.name, rps: value(), p50: value(), p95: value(), p99: value(), errorPct: value(), cpu: value(), mem: value(), connections: Math.floor(value()) })
    }
  }
  return out
}

function fakeView(world: World, records: readonly MetricRecord[]): TelemetryView {
  return {
    world,
    now: world.tick,
    metricsOf: (c, from, to) => records.filter((m) => m.component === c && m.tick >= from && m.tick <= to),
    logsOf: () => [],
    spansOf: () => [],
    traceOf: () => [],
    eventsIn: () => [],
    all: () => records,
  }
}

function ctxOf(view: TelemetryView, lastWeek?: TelemetryView): QuestionContext & { lastWeekCalls: number } {
  const ctx = {
    view,
    lastWeekCalls: 0,
    lastWeek: () => {
      ctx.lastWeekCalls++
      if (!lastWeek) throw new Error('lastWeek view not provided')
      return lastWeek
    },
  }
  return ctx
}

const q = (rest: Omit<QuestionOf<'compare'>, 'kind'>): QuestionOf<'compare'> => ({ kind: 'compare', ...rest })

/** Expected series values straight from the records, by a filter over the view. */
function expected(view: TelemetryView, component: string, metric: MetricName, from: number, to: number, instance?: string) {
  return view
    .metricsOf(component, from, to)
    .filter((r) => r.instance === instance)
    .map((r) => ({ tick: r.tick, value: r[metric] }))
}

describe('compare by instance (Q-8)', () => {
  it('one series per instance, in world order, for every metric', () => {
    const world = makeWorld(50)
    const view = fakeView(world, metrics(world, 1))
    for (const metric of METRICS) {
      const signal = compare(q({ service: 'catalog', metric, by: 'instance' }), ctxOf(view))
      expect(signal.series.map((s) => s.label)).toEqual(['catalog-0', 'catalog-1', 'catalog-2', 'catalog-3'])
      for (const s of signal.series) {
        expect(s.points).toEqual(expected(view, 'catalog', metric, 20, 50, s.label))
      }
    }
  })

  it('uses the fixed 30-tick window [now - 30, now] and reports it', () => {
    expect(COMPARE_WINDOW_TICKS).toBe(30)
    const world = makeWorld(50)
    const signal = compare(q({ service: 'gateway', metric: 'p95', by: 'instance' }), ctxOf(fakeView(world, metrics(world, 2))))
    expect([signal.from, signal.to]).toEqual([20, 50])
    for (const s of signal.series) {
      expect(s.points.map((p) => p.tick)).toEqual(Array.from({ length: 31 }, (_, i) => 20 + i))
    }
  })

  it('clamps the window at tick 0', () => {
    for (const now of [0, 1, 29, 30]) {
      const world = makeWorld(now)
      const signal = compare(q({ service: 'gateway', metric: 'rps', by: 'instance' }), ctxOf(fakeView(world, metrics(world, 3))))
      expect([signal.from, signal.to]).toEqual([0, now])
      expect(signal.series[0]?.points).toHaveLength(now + 1)
    }
  })

  it('works for dependencies and never mixes in the aggregate record', () => {
    const world = makeWorld(10)
    const view = fakeView(world, metrics(world, 4))
    const signal = compare(q({ service: 'postgres', metric: 'connections', by: 'instance' }), ctxOf(view))
    expect(signal.series.map((s) => s.label)).toEqual(['postgres-0', 'postgres-1'])
    expect(signal.series.every((s) => s.points.length === 11)).toBe(true)
  })

  it('the instance hit by a bad deploy is the one with the highest error % (F-5 shape)', () => {
    const world = makeWorld(40)
    const view = fakeView(world, metrics(world, 5, 'catalog-2'))
    const signal = compare(q({ service: 'catalog', metric: 'errorPct', by: 'instance' }), ctxOf(view))
    const mean = (xs: readonly { value: number }[]) => xs.reduce((a, p) => a + p.value, 0) / xs.length
    const worst = [...signal.series].sort((a, b) => mean(b.points) - mean(a.points))[0]
    expect(worst?.label).toBe('catalog-2')
  })

  it('returns the signal header and does not touch lastWeek', () => {
    const world = makeWorld(12)
    const ctx = ctxOf(fakeView(world, metrics(world, 6)))
    const signal = compare(q({ service: 'catalog', metric: 'cpu', by: 'instance' }), ctx)
    expect(signal).toMatchObject({ kind: 'compare', service: 'catalog', metric: 'cpu', by: 'instance', from: 0, to: 12 })
    expect(ctx.lastWeekCalls).toBe(0)
  })

  it('unknown component (validated upstream) yields no series', () => {
    const world = makeWorld(3)
    const signal = compare(q({ service: 'nope', metric: 'cpu', by: 'instance' }), ctxOf(fakeView(world, metrics(world, 7))))
    expect(signal.series).toEqual([])
  })
})

describe('compare by lastWeek (Q-8)', () => {
  it('returns current (this run aggregate) and lastWeek (injected view aggregate) over the same ticks', () => {
    const world = makeWorld(45, 's')
    const lwWorld = makeWorld(45, 's:lastWeek')
    const view = fakeView(world, metrics(world, 10, 'catalog-1'))
    const lastWeek = fakeView(lwWorld, metrics(lwWorld, 11))
    for (const metric of METRICS) {
      const ctx = ctxOf(view, lastWeek)
      const signal = compare(q({ service: 'catalog', metric, by: 'lastWeek' }), ctx)
      expect(signal.series.map((s) => s.label)).toEqual(['current', 'lastWeek'])
      expect(signal.series[0]?.points).toEqual(expected(view, 'catalog', metric, 15, 45))
      expect(signal.series[1]?.points).toEqual(expected(lastWeek, 'catalog', metric, 15, 45))
      expect(signal.series[0]?.points.map((p) => p.tick)).toEqual(signal.series[1]?.points.map((p) => p.tick))
      expect(ctx.lastWeekCalls).toBe(1)
    }
  })

  it('the lastWeek series does not carry the fault effect of the current run', () => {
    const world = makeWorld(40)
    const view = fakeView(world, metrics(world, 12))
    // Current run: aggregate errorPct forced high (a fault); lastWeek: the same records unfaulted.
    const faulted = fakeView(
      world,
      view.all().map((r) => (r.type === 'metric' && r.instance === undefined && r.component === 'gateway' ? { ...r, errorPct: 90 } : r)) as MetricRecord[],
    )
    const signal = compare(q({ service: 'gateway', metric: 'errorPct', by: 'lastWeek' }), ctxOf(faulted, view))
    expect(signal.series[0]?.points.every((p) => p.value === 90)).toBe(true)
    expect(signal.series[1]?.points).toEqual(expected(view, 'gateway', 'errorPct', 10, 40))
  })

  it('header carries by: lastWeek and the window', () => {
    const world = makeWorld(5)
    const view = fakeView(world, metrics(world, 13))
    const signal = compare(q({ service: 'postgres', metric: 'p99', by: 'lastWeek' }), ctxOf(view, view))
    expect(signal).toMatchObject({ kind: 'compare', service: 'postgres', metric: 'p99', by: 'lastWeek', from: 0, to: 5 })
  })
})

describe('compare determinism (DET)', () => {
  it('same views + same question => equal Signal, byte-identical JSON', () => {
    for (const seed of [1, 2, 3, 42]) {
      const build = (): CompareSignal[] => {
        const world = makeWorld(60)
        const view = fakeView(world, metrics(world, seed))
        const lw = fakeView(world, metrics(world, seed + 100))
        return (['instance', 'lastWeek'] as const).flatMap((by) =>
          METRICS.map((metric) => compare(q({ service: 'catalog', metric, by }), ctxOf(view, lw))),
        )
      }
      const a = build()
      const b = build()
      expect(b).toStrictEqual(a)
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    }
  })

  it('does not mutate the view records', () => {
    const world = makeWorld(20)
    const records = metrics(world, 9)
    const before = JSON.stringify(records)
    const view = fakeView(world, records)
    compare(q({ service: 'catalog', metric: 'mem', by: 'instance' }), ctxOf(view))
    compare(q({ service: 'catalog', metric: 'mem', by: 'lastWeek' }), ctxOf(view, view))
    expect(JSON.stringify(records)).toBe(before)
  })
})
