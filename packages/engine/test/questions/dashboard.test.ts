/**
 * T1.9 — `dashboard` handler (Q-4, ADR-006) against a fake TelemetryView built here.
 * The real store (T1.8) is developed in parallel; this view honours the same contract
 * (closed tick intervals, record order preserved).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_WINDOW_TICKS, dashboard } from '../../src/questions/dashboard.js'
import type {
  MetricRecord,
  QuestionContext,
  TelemetryRecord,
  TelemetryView,
  World,
} from '../../src/types.js'

const world: World = {
  seed: 'fake',
  tick: 0,
  services: [
    {
      name: 'gateway',
      replicas: 2,
      instances: ['gateway-0', 'gateway-1'],
      latencyP50Ms: 5,
      latencyP99Ms: 20,
      cpuBasePct: 4,
      cpuPerRequestPct: 0.8,
      memBaseMb: 256,
      calls: [],
      dbPoolSize: 20,
    },
  ],
  deps: [
    {
      name: 'postgres',
      kind: 'database',
      replicas: 1,
      instances: ['postgres-0'],
      latencyP50Ms: 4,
      latencyP99Ms: 25,
      cpuBasePct: 10,
      cpuPerRequestPct: 0.3,
      memBaseMb: 2048,
      maxConnections: 200,
    },
  ],
}

const ofType =
  <T extends TelemetryRecord['type']>(type: T) =>
  (r: TelemetryRecord): r is Extract<TelemetryRecord, { type: T }> =>
    r.type === type

function fakeView(records: readonly TelemetryRecord[], now: number): TelemetryView {
  const inRange = (tick: number, from: number, to: number) => tick >= from && tick <= to
  return {
    world: { ...world, tick: now },
    now,
    metricsOf: (c, from, to) => records.filter(ofType('metric')).filter((r) => r.component === c && inRange(r.tick, from, to)),
    logsOf: (c, from, to) => records.filter(ofType('log')).filter((r) => r.component === c && inRange(r.tick, from, to)),
    spansOf: (c, tick) => records.filter(ofType('span')).filter((r) => r.component === c && r.tick === tick),
    traceOf: (id) => records.filter(ofType('span')).filter((r) => r.traceId === id),
    eventsIn: (from, to) => records.filter(ofType('event')).filter((r) => inRange(r.tick, from, to)),
    all: () => records,
  }
}

const ctxOf = (view: TelemetryView): QuestionContext => ({
  view,
  lastWeek: () => {
    throw new Error('dashboard must not read lastWeek')
  },
})

/** Small seeded PRNG local to the test (mulberry32), so fixtures are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function metric(rand: () => number, tick: number, component: string, instance?: string): MetricRecord {
  const p50 = Math.round(rand() * 20)
  return {
    type: 'metric',
    tick,
    component,
    ...(instance === undefined ? {} : { instance }),
    rps: Math.round(rand() * 30) / 10,
    p50,
    p95: p50 + Math.round(rand() * 30),
    p99: p50 + 40,
    errorPct: Math.round(rand() * 1000) / 10,
    cpu: Math.round(rand() * 1000) / 10,
    mem: 256,
    connections: Math.round(rand() * 10),
  }
}

/** Canonical-order metrics for ticks [0, now]: instances then aggregate, per component. */
function telemetry(seed: number, now: number): TelemetryRecord[] {
  const rand = prng(seed)
  const out: TelemetryRecord[] = []
  for (let tick = 0; tick <= now; tick++) {
    out.push({ type: 'event', tick, kind: 'deploy', target: 'gateway' })
    out.push({ type: 'log', tick, component: 'gateway', instance: 'gateway-0', level: 'info', message: 'ok' })
    for (const c of [...world.services, ...world.deps]) {
      for (const i of c.instances) out.push(metric(rand, tick, c.name, i))
      out.push(metric(rand, tick, c.name))
    }
  }
  return out
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('dashboard (Q-4)', () => {
  it('uses a fixed 30-tick window (ADR-006)', () => {
    expect(DASHBOARD_WINDOW_TICKS).toBe(30)
  })

  it('returns the aggregate records of the window, equal to the telemetry ones, ascending', () => {
    const records = telemetry(1, 50)
    const view = fakeView(records, 50)
    const signal = dashboard({ kind: 'dashboard', service: 'gateway' }, ctxOf(view))

    const expected = records.filter(
      (r) => r.type === 'metric' && r.component === 'gateway' && r.instance === undefined && r.tick >= 20,
    )
    expect(signal.kind).toBe('dashboard')
    expect(signal.service).toBe('gateway')
    expect(signal.from).toBe(20)
    expect(signal.to).toBe(50)
    expect(signal.records).toHaveLength(31)
    expect(signal.records).toStrictEqual(expected)
    expect(signal.records.map((r) => r.tick)).toStrictEqual(Array.from({ length: 31 }, (_, i) => 20 + i))
    for (const r of signal.records) expect(r).not.toHaveProperty('instance')
  })

  it('exposes exactly the 8 metrics of S-1 per record', () => {
    const view = fakeView(telemetry(2, 10), 10)
    const signal = dashboard({ kind: 'dashboard', service: 'gateway' }, ctxOf(view))
    for (const r of signal.records) {
      expect(Object.keys(r).sort()).toStrictEqual(
        ['component', 'connections', 'cpu', 'errorPct', 'mem', 'p50', 'p95', 'p99', 'rps', 'tick', 'type'].sort(),
      )
    }
  })

  it('clamps the window at tick 0', () => {
    const view = fakeView(telemetry(3, 12), 12)
    const signal = dashboard({ kind: 'dashboard', service: 'gateway' }, ctxOf(view))
    expect(signal.from).toBe(0)
    expect(signal.to).toBe(12)
    expect(signal.records.map((r) => r.tick)).toStrictEqual(Array.from({ length: 13 }, (_, i) => i))
  })

  it('works on a freshly created simulation (tick 0)', () => {
    const view = fakeView(telemetry(4, 0), 0)
    const signal = dashboard({ kind: 'dashboard', service: 'gateway' }, ctxOf(view))
    expect(signal.from).toBe(0)
    expect(signal.to).toBe(0)
    expect(signal.records).toHaveLength(1)
  })

  it('accepts a dependency as service (SPEC §7 "dashboard postgres")', () => {
    const records = telemetry(5, 40)
    const signal = dashboard({ kind: 'dashboard', service: 'postgres' }, ctxOf(fakeView(records, 40)))
    expect(signal.records).toHaveLength(31)
    expect(signal.records.every((r) => r.component === 'postgres' && r.instance === undefined)).toBe(true)
  })

  it('does not alter the telemetry it reads (Q-3)', () => {
    const records = telemetry(6, 45)
    const before = sha(records)
    dashboard({ kind: 'dashboard', service: 'gateway' }, ctxOf(fakeView(records, 45)))
    expect(sha(records)).toBe(before)
  })

  it('DET: same view and question give a byte-identical signal', () => {
    for (let seed = 0; seed < 20; seed++) {
      const a = dashboard({ kind: 'dashboard', service: 'gateway' }, ctxOf(fakeView(telemetry(seed, 60), 60)))
      const b = dashboard({ kind: 'dashboard', service: 'gateway' }, ctxOf(fakeView(telemetry(seed, 60), 60)))
      expect(sha(a)).toBe(sha(b))
      expect(a).toStrictEqual(b)
    }
  })
})
