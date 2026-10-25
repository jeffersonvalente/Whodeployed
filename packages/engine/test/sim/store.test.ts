/**
 * T1.8 — createTelemetryStore (ADR-002 §3, ADR-005).
 * Queries return exactly the expected records in insertion order; windows are closed;
 * traceOf is complete; appendTick rejects out-of-order ticks; reads are pure (Q-3 base);
 * DET: two stores fed the same appends expose identical all().
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createTelemetryStore } from '../../src/sim/store.js'
import type {
  EventRecord,
  LogRecord,
  MetricRecord,
  SpanRecord,
  TelemetryRecord,
  TelemetryView,
  World,
} from '../../src/types.js'

function makeWorld(tick = 0): World {
  return {
    services: [
      {
        name: 'api',
        replicas: 2,
        instances: ['api-0', 'api-1'],
        latencyP50Ms: 5,
        latencyP99Ms: 20,
        cpuBasePct: 1,
        cpuPerRequestPct: 0.1,
        memBaseMb: 100,
        ingress: { ratePerTick: 2, operation: 'http.request' },
        calls: [{ target: 'db', operation: 'db.query', ratio: 1, timeoutMs: 100, retries: 0 }],
        dbPoolSize: 10,
      },
    ],
    deps: [
      {
        name: 'db',
        kind: 'database',
        replicas: 1,
        instances: ['db-0'],
        latencyP50Ms: 2,
        latencyP99Ms: 8,
        cpuBasePct: 1,
        cpuPerRequestPct: 0.1,
        memBaseMb: 500,
        maxConnections: 50,
      },
    ],
    tick,
    seed: 'store-test',
  }
}

const metric = (tick: number, component: string, instance?: string): MetricRecord => ({
  type: 'metric',
  tick,
  component,
  ...(instance === undefined ? {} : { instance }),
  rps: 0.1,
  p50: 3,
  p95: 4,
  p99: 4,
  errorPct: 0,
  cpu: 1.2,
  mem: 100,
  connections: 1,
})

const span = (
  tick: number,
  traceId: string,
  n: number,
  component: string,
  instance: string,
  parentId?: string,
): SpanRecord => ({
  type: 'span',
  tick,
  traceId,
  spanId: `${traceId}s${n}`,
  ...(parentId === undefined ? {} : { parentId }),
  component,
  instance,
  operation: component === 'db' ? 'db.query' : 'http.request',
  kind: 'server',
  startMs: n,
  durationMs: 10 - n,
  status: 'ok',
})

const log = (tick: number, component: string, instance: string, traceId?: string): LogRecord => ({
  type: 'log',
  tick,
  component,
  instance,
  level: 'info',
  message: 'request served',
  ...(traceId === undefined ? {} : { traceId }),
})

const event = (tick: number, target: string, note?: string): EventRecord => ({
  type: 'event',
  tick,
  kind: 'deploy',
  target,
  ...(note === undefined ? {} : { note }),
})

/** Canonical-order records of one tick (ADR-005): events, spans, logs, metrics. */
function tickRecords(tick: number): TelemetryRecord[] {
  const t0 = `t${tick}r0`
  const t1 = `t${tick}r1`
  return [
    ...(tick % 2 === 0 ? [event(tick, 'api'), event(tick, 'db', 'noise')] : []),
    span(tick, t0, 0, 'api', 'api-0'),
    span(tick, t0, 1, 'db', 'db-0', `${t0}s0`),
    span(tick, t1, 0, 'api', 'api-1'),
    span(tick, t1, 1, 'db', 'db-0', `${t1}s0`),
    log(tick, 'api', 'api-0', t0),
    log(tick, 'db', 'db-0'),
    log(tick, 'api', 'api-1', t1),
    metric(tick, 'api', 'api-0'),
    metric(tick, 'api', 'api-1'),
    metric(tick, 'api'),
    metric(tick, 'db', 'db-0'),
    metric(tick, 'db'),
  ]
}

function filledStore(ticks: number, world: World = makeWorld()) {
  const store = createTelemetryStore(world)
  const appended: TelemetryRecord[][] = []
  for (let tick = world.tick; tick < world.tick + ticks; tick++) {
    const records = tickRecords(tick)
    appended.push(records)
    store.appendTick(tick, records)
  }
  return { store, appended, flat: appended.flat() }
}

/** Reference implementation: linear filter over the flat record list. */
const expectedOf = <T extends TelemetryRecord>(flat: TelemetryRecord[], pred: (r: TelemetryRecord) => boolean) =>
  flat.filter(pred) as T[]

const hashOf = (view: TelemetryView) =>
  createHash('sha256')
    .update(view.all().map((r) => JSON.stringify(r)).join('\n'))
    .digest('hex')

describe('createTelemetryStore — empty store', () => {
  it('starts at world.tick with no records', () => {
    const store = createTelemetryStore(makeWorld())
    expect(store.now).toBe(0)
    expect(store.world.tick).toBe(0)
    expect(store.all()).toEqual([])
    expect(store.metricsOf('api', 0, 100)).toEqual([])
    expect(store.logsOf('api', 0, 100)).toEqual([])
    expect(store.spansOf('api', 0)).toEqual([])
    expect(store.traceOf('t0r0')).toEqual([])
    expect(store.eventsIn(0, 100)).toEqual([])
  })

  it('rejects a world with an invalid tick', () => {
    expect(() => createTelemetryStore(makeWorld(-1))).toThrow(/world\.tick/)
    expect(() => createTelemetryStore(makeWorld(1.5))).toThrow(/world\.tick/)
  })

  it('exposes the world definition and seed', () => {
    const world = makeWorld()
    const store = createTelemetryStore(world)
    expect(store.world.seed).toBe('store-test')
    expect(store.world.services).toBe(world.services)
    expect(store.world.deps).toBe(world.deps)
  })
})

describe('createTelemetryStore — appendTick', () => {
  it('moves now and world.tick without mutating the caller world', () => {
    const world = makeWorld()
    const { store } = filledStore(3, world)
    expect(store.now).toBe(2)
    expect(store.world.tick).toBe(2)
    expect(world.tick).toBe(0)
  })

  it('accepts an empty tick', () => {
    const store = createTelemetryStore(makeWorld())
    store.appendTick(0, [])
    store.appendTick(1, tickRecords(1))
    expect(store.now).toBe(1)
    expect(store.metricsOf('api', 0, 0)).toEqual([])
    expect(store.metricsOf('api', 0, 1)).toHaveLength(3)
  })

  it('rejects out-of-order, repeated, skipped and non-integer ticks', () => {
    const store = createTelemetryStore(makeWorld())
    expect(() => store.appendTick(1, [])).toThrow(/expected tick 0/)
    store.appendTick(0, tickRecords(0))
    expect(() => store.appendTick(0, tickRecords(0))).toThrow(/expected tick 1/)
    expect(() => store.appendTick(2, tickRecords(2))).toThrow(/expected tick 1/)
    expect(() => store.appendTick(0.5, [])).toThrow(/expected tick 1/)
    expect(() => store.appendTick(Number.NaN, [])).toThrow(/expected tick 1/)
    store.appendTick(1, tickRecords(1))
    expect(store.now).toBe(1)
  })

  it('starts at a non-zero world.tick', () => {
    const { store, flat } = filledStore(3, makeWorld(5))
    expect(store.now).toBe(7)
    expect(() => store.appendTick(4, [])).toThrow(/expected tick 8/)
    expect(store.all()).toEqual(flat)
    expect(store.metricsOf('api', 0, 5)).toEqual(expectedOf(flat, (r) => r.type === 'metric' && r.component === 'api' && r.tick === 5))
  })

  it('rejects a record whose tick differs from the appended tick, atomically', () => {
    const store = createTelemetryStore(makeWorld())
    const records = [...tickRecords(0), metric(1, 'api')]
    expect(() => store.appendTick(0, records)).toThrow(/record 14 of tick 0 has tick 1/)
    // Nothing was stored and the tick can still be appended.
    expect(store.all()).toEqual([])
    expect(store.traceOf('t0r0')).toEqual([])
    store.appendTick(0, tickRecords(0))
    expect(store.all()).toEqual(tickRecords(0))
  })
})

describe('createTelemetryStore — queries', () => {
  const { store, flat } = filledStore(6)

  it('all() returns every record in insertion (canonical) order', () => {
    expect(store.all()).toEqual(flat)
  })

  it('metricsOf returns instance and aggregate records of the component in a closed window', () => {
    const got = store.metricsOf('api', 2, 4)
    expect(got).toEqual(
      expectedOf(flat, (r) => r.type === 'metric' && r.component === 'api' && r.tick >= 2 && r.tick <= 4),
    )
    expect(got).toHaveLength(9)
    expect(got[0]?.tick).toBe(2)
    expect(got.at(-1)?.tick).toBe(4)
    expect(got.filter((r) => r.instance === undefined)).toHaveLength(3)
  })

  it('logsOf returns only the component logs in a closed window', () => {
    expect(store.logsOf('api', 1, 3)).toEqual(
      expectedOf(flat, (r) => r.type === 'log' && r.component === 'api' && r.tick >= 1 && r.tick <= 3),
    )
    expect(store.logsOf('db', 3, 3)).toEqual([log(3, 'db', 'db-0')])
  })

  it('spansOf returns the component spans that started in the tick', () => {
    expect(store.spansOf('db', 4)).toEqual(
      expectedOf(flat, (r) => r.type === 'span' && r.component === 'db' && r.tick === 4),
    )
    expect(store.spansOf('api', 4).map((s) => s.spanId)).toEqual(['t4r0s0', 't4r1s0'])
  })

  it('traceOf returns the complete trace in generation order', () => {
    expect(store.traceOf('t3r1')).toEqual([span(3, 't3r1', 0, 'api', 'api-1'), span(3, 't3r1', 1, 'db', 'db-0', 't3r1s0')])
    expect(store.traceOf('missing')).toEqual([])
  })

  it('eventsIn returns every event in a closed window, in order', () => {
    expect(store.eventsIn(0, 2)).toEqual([event(0, 'api'), event(0, 'db', 'noise'), event(2, 'api'), event(2, 'db', 'noise')])
    expect(store.eventsIn(1, 1)).toEqual([])
  })

  it('clamps windows to the stored ticks and returns [] for empty windows', () => {
    expect(store.metricsOf('api', -10, 100)).toEqual(expectedOf(flat, (r) => r.type === 'metric' && r.component === 'api'))
    expect(store.eventsIn(-5, 0)).toEqual(store.eventsIn(0, 0))
    expect(store.metricsOf('api', 4, 2)).toEqual([])
    expect(store.metricsOf('api', 6, 9)).toEqual([])
    expect(store.metricsOf('api', -3, -1)).toEqual([])
    expect(store.spansOf('api', 6)).toEqual([])
    expect(store.spansOf('api', -1)).toEqual([])
  })

  it('treats fractional bounds as the closed integer window they contain', () => {
    expect(store.metricsOf('api', 1.5, 2.5)).toEqual(store.metricsOf('api', 2, 2))
    expect(store.spansOf('api', 1.5)).toEqual([])
  })

  it('returns [] for an unknown component', () => {
    expect(store.metricsOf('nope', 0, 5)).toEqual([])
    expect(store.logsOf('nope', 0, 5)).toEqual([])
    expect(store.spansOf('nope', 0)).toEqual([])
  })
})

describe('createTelemetryStore — reads are pure (Q-3 base)', () => {
  it('queries do not change all() and returned arrays are not shared with the store', () => {
    const { store, flat } = filledStore(4)
    const before = hashOf(store)

    store.metricsOf('api', 0, 3).length = 0
    store.logsOf('api', 0, 3).pop()
    store.spansOf('api', 1).splice(0)
    store.traceOf('t1r0').push(span(1, 't1r0', 9, 'api', 'api-0'))
    store.eventsIn(0, 3).reverse()
    ;(store.all() as TelemetryRecord[]).length = 0

    expect(hashOf(store)).toBe(before)
    expect(store.all()).toEqual(flat)
    expect(store.traceOf('t1r0')).toHaveLength(2)
    expect(store.metricsOf('api', 0, 3)).toHaveLength(12)
  })

  it('the same query on the same tick returns equal results', () => {
    const { store } = filledStore(4)
    expect(store.metricsOf('db', 1, 3)).toStrictEqual(store.metricsOf('db', 1, 3))
    expect(store.traceOf('t2r0')).toStrictEqual(store.traceOf('t2r0'))
  })
})

describe('createTelemetryStore — determinism (DET)', () => {
  it('two stores fed the same appends expose byte-identical all()', () => {
    const a = filledStore(10).store
    const b = filledStore(10).store
    expect(a.all()).toStrictEqual(b.all())
    expect(hashOf(a)).toBe(hashOf(b))
    for (let tick = 0; tick < 10; tick++) {
      expect(a.spansOf('api', tick)).toStrictEqual(b.spansOf('api', tick))
      expect(a.metricsOf('db', 0, tick)).toStrictEqual(b.metricsOf('db', 0, tick))
    }
  })

  it('different appends give different all()', () => {
    const a = filledStore(3).store
    const b = createTelemetryStore(makeWorld())
    b.appendTick(0, tickRecords(0))
    b.appendTick(1, tickRecords(1))
    b.appendTick(2, tickRecords(2).slice(1))
    expect(hashOf(a)).not.toBe(hashOf(b))
  })
})
