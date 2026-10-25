/**
 * T1.11 — `askNpc` handler (Q-9, ADR-006) against fake TelemetryViews built here.
 * The real store (T1.8) and the lastWeek run (T1.16) are developed in parallel; the views
 * below honour the same contract (closed tick intervals, record order preserved).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  NPC_LOOKBACK_TICKS,
  NPC_MAX_HINTS,
  NPC_MIN_DEVIATION,
  askNpc,
  npcCandidates,
} from '../../src/questions/askNpc.js'
import type {
  ComponentSpecBase,
  MetricName,
  MetricRecord,
  MetricValues,
  NpcSignal,
  QuestionContext,
  TelemetryRecord,
  TelemetryView,
  World,
} from '../../src/types.js'

const base: Omit<ComponentSpecBase, 'name' | 'replicas'> = {
  latencyP50Ms: 10,
  latencyP99Ms: 40,
  cpuBasePct: 4,
  cpuPerRequestPct: 1,
  memBaseMb: 256,
}

/** gateway -> auth (redis, onMiss postgres), gateway -> payment (postgres, queue). */
const world: World = {
  seed: 'fake',
  tick: 0,
  services: [
    {
      ...base,
      name: 'gateway',
      replicas: 2,
      instances: ['gateway-0', 'gateway-1'],
      dbPoolSize: 20,
      ingress: { ratePerTick: 12, operation: 'http.request' },
      calls: [
        { target: 'auth', operation: 'auth.verify', ratio: 1, timeoutMs: 800, retries: 1 },
        { target: 'payment', operation: 'payment.checkout', ratio: 0.1, timeoutMs: 5000, retries: 0 },
      ],
    },
    {
      ...base,
      name: 'auth',
      replicas: 2,
      instances: ['auth-0', 'auth-1'],
      dbPoolSize: 20,
      calls: [
        {
          target: 'redis',
          operation: 'session.get',
          ratio: 1,
          timeoutMs: 100,
          retries: 1,
          onMiss: { target: 'postgres', operation: 'db.query', timeoutMs: 500, retries: 1 },
        },
      ],
    },
    {
      ...base,
      name: 'payment',
      replicas: 3,
      instances: ['payment-0', 'payment-1', 'payment-2'],
      dbPoolSize: 20,
      calls: [
        { target: 'postgres', operation: 'db.insert', ratio: 1, timeoutMs: 2000, retries: 1 },
        { target: 'queue', operation: 'queue.publish', ratio: 1, timeoutMs: 500, retries: 1 },
      ],
    },
  ],
  deps: [
    { ...base, name: 'postgres', kind: 'database', replicas: 1, instances: ['postgres-0'], maxConnections: 200 },
    { ...base, name: 'redis', kind: 'cache', replicas: 1, instances: ['redis-0'], maxConnections: 1000, cacheHitRatio: 0.9 },
    { ...base, name: 'queue', kind: 'queue', replicas: 1, instances: ['queue-0'], maxConnections: 500 },
  ],
}

const METRICS: readonly MetricName[] = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']
const COMPONENTS = [...world.services, ...world.deps]
const IDENTIFIERS = new Set<string>([
  ...COMPONENTS.map((c) => c.name),
  ...COMPONENTS.flatMap((c) => c.instances),
  ...METRICS,
])

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

const USUAL: MetricValues = { rps: 12, p50: 20, p95: 60, p99: 90, errorPct: 0.5, cpu: 20, mem: 300, connections: 8 }

/** Multiplies (or, with `add`, offsets) one metric of one record series from `fromTick` on. */
interface Anomaly {
  component: string
  instance?: string
  metric: MetricName
  fromTick: number
  factor?: number
  add?: number
}

/** Metric records for ticks [0, now]: usual values with a ±4% seeded jitter, plus anomalies. */
function telemetry(seed: number, now: number, anomalies: readonly Anomaly[] = []): TelemetryRecord[] {
  const rand = prng(seed)
  const out: TelemetryRecord[] = []
  const record = (tick: number, component: string, instance?: string): MetricRecord => {
    const values = {} as MetricValues
    for (const metric of METRICS) {
      let value = USUAL[metric] * (0.96 + 0.08 * rand())
      for (const a of anomalies) {
        if (a.component === component && a.instance === instance && a.metric === metric && tick >= a.fromTick) {
          value = value * (a.factor ?? 1) + (a.add ?? 0)
        }
      }
      values[metric] = value
    }
    return { type: 'metric', tick, component, ...(instance === undefined ? {} : { instance }), ...values }
  }
  for (let tick = 0; tick <= now; tick++) {
    out.push({ type: 'event', tick, kind: 'config', target: 'payment' })
    for (const c of COMPONENTS) {
      for (const i of c.instances) out.push(record(tick, c.name, i))
      out.push(record(tick, c.name))
    }
  }
  return out
}

const NOW = 40
const lastWeekRecords = telemetry(1000, NOW)

function ctxOf(view: TelemetryView, lastWeek: TelemetryView = fakeView(lastWeekRecords, NOW)): QuestionContext {
  return { view, lastWeek: () => lastWeek }
}

const ask = (role: 'dev' | 'dba' | 'oncall', records: readonly TelemetryRecord[], now = NOW): NpcSignal =>
  askNpc({ kind: 'askNpc', role }, ctxOf(fakeView(records, now)))

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A payment pool exhaustion as the telemetry would show it, without naming it. */
const incident: Anomaly[] = [
  { component: 'payment', metric: 'p95', fromTick: 30, factor: 4 },
  { component: 'payment', metric: 'errorPct', fromTick: 30, add: 6 },
  { component: 'payment', metric: 'connections', fromTick: 30, factor: 2.5 },
  { component: 'payment', instance: 'payment-1', metric: 'p95', fromTick: 30, factor: 5 },
  { component: 'payment', instance: 'payment-1', metric: 'cpu', fromTick: 30, factor: 1.6 },
  { component: 'gateway', metric: 'p95', fromTick: 30, factor: 1.5 },
  { component: 'postgres', metric: 'connections', fromTick: 30, factor: 2 },
  { component: 'postgres', metric: 'p99', fromTick: 30, factor: 1.4 },
]

describe('askNpc constants (ADR-006)', () => {
  it('looks back 6 ticks, keeps deviations >= 0.25, at most 3 hints', () => {
    expect(NPC_LOOKBACK_TICKS).toBe(5)
    expect(NPC_MIN_DEVIATION).toBe(0.25)
    expect(NPC_MAX_HINTS).toBe(3)
  })
})

describe('askNpc baseline vs incident (Q-9)', () => {
  it('a run that looks like last week yields no hints, for every role', () => {
    const baseline = telemetry(7, NOW)
    for (const role of ['dev', 'dba', 'oncall'] as const) {
      const signal = ask(role, baseline)
      expect(signal).toStrictEqual({ kind: 'askNpc', role, tick: NOW, hints: [] })
    }
  })

  it('hints change between baseline and incident for each of the 3 roles', () => {
    const baseline = telemetry(7, NOW)
    const faulty = telemetry(7, NOW, incident)
    for (const role of ['dev', 'dba', 'oncall'] as const) {
      const a = ask(role, baseline)
      const b = ask(role, faulty)
      expect(b.hints.length).toBeGreaterThan(0)
      expect(sha(b)).not.toBe(sha(a))
    }
  })

  it('dev points at service aggregates (rps, p95, errorPct), largest deviation first', () => {
    const { hints } = ask('dev', telemetry(7, NOW, incident))
    expect(hints.map((h) => [h.component, h.metric])).toStrictEqual([
      ['payment', 'errorPct'],
      ['payment', 'p95'],
      ['gateway', 'p95'],
    ])
    for (const h of hints) expect(h).not.toHaveProperty('instance')
  })

  it('dba points at the database and at connections of the services that call it', () => {
    const { hints } = ask('dba', telemetry(7, NOW, incident))
    expect(hints.map((h) => [h.component, h.metric])).toStrictEqual([
      ['payment', 'connections'],
      ['postgres', 'connections'],
      ['postgres', 'p99'],
    ])
  })

  it('oncall points at instances (p95, errorPct, cpu), so a single bad instance surfaces', () => {
    const { hints } = ask('oncall', telemetry(7, NOW, incident))
    expect(hints.map((h) => [h.component, h.instance, h.metric])).toStrictEqual([
      ['payment', 'payment-1', 'p95'],
      ['payment', 'payment-1', 'cpu'],
    ])
  })

  it('reports current and usual as the means of the last 6 ticks of each run', () => {
    const faulty = telemetry(7, NOW, incident)
    const { hints } = ask('dev', faulty)
    const mean = (records: readonly TelemetryRecord[], metric: MetricName) => {
      const values = records
        .filter(ofType('metric'))
        .filter((r) => r.component === 'payment' && r.instance === undefined && r.tick >= NOW - 5)
        .map((r) => r[metric])
      return values.reduce((s, v) => s + v, 0) / values.length
    }
    const p95 = hints.find((h) => h.metric === 'p95' && h.component === 'payment')
    expect(p95?.current).toBeCloseTo(mean(faulty, 'p95'), 9)
    expect(p95?.usual).toBeCloseTo(mean(lastWeekRecords, 'p95'), 9)
  })
})

describe('askNpc structure (Q-9: identifiers and numbers only, never the root cause)', () => {
  it('every string in data is an identifier of the world or a MetricName', () => {
    for (const role of ['dev', 'dba', 'oncall'] as const) {
      const signal = ask(role, telemetry(11, NOW, incident))
      expect(Object.keys(signal).sort()).toStrictEqual(['hints', 'kind', 'role', 'tick'])
      expect(signal.kind).toBe('askNpc')
      expect(signal.role).toBe(role)
      expect(Number.isInteger(signal.tick)).toBe(true)
      for (const hint of signal.hints) {
        for (const [key, value] of Object.entries(hint)) {
          expect(['component', 'instance', 'metric', 'current', 'usual']).toContain(key)
          if (typeof value === 'string') expect(IDENTIFIERS.has(value)).toBe(true)
          else expect(Number.isFinite(value)).toBe(true)
        }
      }
    }
  })

  it('never returns a fault kind or any prose', () => {
    const text = JSON.stringify(['dev', 'dba', 'oncall'].map((r) => ask(r as 'dev', telemetry(12, NOW, incident))))
    expect(text).not.toMatch(
      /service_crash_loop|disk_full|connection_pool_exhaustion|bad_deploy|slow_dependency|cache_cold_start|root|cause| /,
    )
  })
})

describe('askNpc scope by role (ADR-006)', () => {
  it('dev candidates: service aggregates x (rps, p95, errorPct)', () => {
    const c = npcCandidates(world, 'dev')
    expect(c).toHaveLength(world.services.length * 3)
    expect(c.every((x) => x.instance === undefined)).toBe(true)
    expect(new Set(c.map((x) => x.component))).toStrictEqual(new Set(['gateway', 'auth', 'payment']))
    expect(new Set(c.map((x) => x.metric))).toStrictEqual(new Set(['rps', 'p95', 'errorPct']))
  })

  it('dba candidates: database aggregates (8 metrics) and connections of callers, incl. on cache miss', () => {
    const c = npcCandidates(world, 'dba')
    expect(c.map((x) => `${x.component}.${x.metric}`)).toStrictEqual([
      'auth.connections',
      'payment.connections',
      ...METRICS.map((m) => `postgres.${m}`),
    ])
    expect(c.every((x) => x.instance === undefined)).toBe(true)
  })

  it('oncall candidates: every instance of every component x (p95, errorPct, cpu)', () => {
    const c = npcCandidates(world, 'oncall')
    const instances = COMPONENTS.flatMap((x) => x.instances)
    expect(c).toHaveLength(instances.length * 3)
    expect(c.map((x) => x.instance)).toStrictEqual(instances.flatMap((i) => [i, i, i]))
    expect(c.slice(0, 3).map((x) => x.metric)).toStrictEqual(['p95', 'errorPct', 'cpu'])
  })

  it('ignores anomalies outside the role scope', () => {
    const outOfScope: Anomaly[] = [
      { component: 'redis', metric: 'p95', fromTick: 30, factor: 5 }, // cache: not dba, not dev
      { component: 'payment', metric: 'mem', fromTick: 30, factor: 3 }, // mem: not dev
      { component: 'queue', metric: 'connections', fromTick: 30, factor: 3 }, // queue: not dba
      { component: 'gateway', metric: 'connections', fromTick: 30, factor: 3 }, // gateway calls no database
    ]
    const records = telemetry(13, NOW, outOfScope)
    expect(ask('dev', records).hints).toStrictEqual([])
    expect(ask('dba', records).hints).toStrictEqual([])
    // On-call sees instances only; the anomalies above are on aggregates.
    expect(ask('oncall', records).hints).toStrictEqual([])
  })

  it('a world without databases gives the dba nothing to look at', () => {
    const noDb: World = { ...world, deps: world.deps.filter((d) => d.kind !== 'database') }
    expect(npcCandidates(noDb, 'dba')).toStrictEqual([])
  })
})

describe('askNpc window, threshold and ordering (ADR-006)', () => {
  /** Exact values (no jitter): current and usual are fully controlled. */
  function flat(now: number, overrides: readonly Anomaly[] = []): TelemetryRecord[] {
    const out: TelemetryRecord[] = []
    for (let tick = 0; tick <= now; tick++) {
      for (const c of COMPONENTS) {
        for (const instance of [...c.instances, undefined]) {
          const values = { ...USUAL }
          for (const a of overrides) {
            if (a.component === c.name && a.instance === instance && tick >= a.fromTick) {
              values[a.metric] = values[a.metric] * (a.factor ?? 1) + (a.add ?? 0)
            }
          }
          out.push({ type: 'metric', tick, component: c.name, ...(instance === undefined ? {} : { instance }), ...values })
        }
      }
    }
    return out
  }
  const flatCtx = (records: readonly TelemetryRecord[], now: number, lastWeek = flat(now)) =>
    ctxOf(fakeView(records, now), fakeView(lastWeek, now))
  const dev = (records: readonly TelemetryRecord[], now = NOW, lastWeek = flat(now)) =>
    askNpc({ kind: 'askNpc', role: 'dev' }, flatCtx(records, now, lastWeek)).hints

  it('only the last 6 ticks count: an anomaly that ended before them is not reported', () => {
    const spike: Anomaly[] = [{ component: 'auth', metric: 'p95', fromTick: 0, factor: 10 }]
    const old = flat(NOW, spike).map((r) =>
      r.type === 'metric' && r.component === 'auth' && r.tick >= NOW - 5 ? { ...r, p95: USUAL.p95 } : r,
    )
    expect(dev(old)).toStrictEqual([])
    // ...while the same anomaly starting at now - 5 is reported.
    expect(dev(flat(NOW, [{ component: 'auth', metric: 'p95', fromTick: NOW - 5, factor: 10 }]))).toHaveLength(1)
  })

  it('a deviation of exactly 0.25 is kept and one just below is dropped', () => {
    expect(dev(flat(NOW, [{ component: 'auth', metric: 'p95', fromTick: 0, factor: 1.25 }]))).toHaveLength(1)
    expect(dev(flat(NOW, [{ component: 'auth', metric: 'p95', fromTick: 0, factor: 1.24 }]))).toStrictEqual([])
    // Drops count too (|current - usual|).
    expect(dev(flat(NOW, [{ component: 'auth', metric: 'rps', fromTick: 0, factor: 0.5 }]))).toHaveLength(1)
  })

  it('divides by max(usual, 1): tiny usual values do not explode the deviation', () => {
    // errorPct usual 0.5; +0.2 => 0.2 / 1 = 0.2 < 0.25 (would be 0.4 if divided by 0.5).
    expect(dev(flat(NOW, [{ component: 'auth', metric: 'errorPct', fromTick: 0, add: 0.2 }]))).toStrictEqual([])
    expect(dev(flat(NOW, [{ component: 'auth', metric: 'errorPct', fromTick: 0, add: 0.3 }]))).toHaveLength(1)
  })

  it('keeps at most 3 hints, ordered by deviation desc', () => {
    const many: Anomaly[] = [
      { component: 'gateway', metric: 'rps', fromTick: 0, factor: 1.5 },
      { component: 'auth', metric: 'p95', fromTick: 0, factor: 3 },
      { component: 'payment', metric: 'p95', fromTick: 0, factor: 2 },
      { component: 'payment', metric: 'rps', fromTick: 0, factor: 4 },
    ]
    const hints = dev(flat(NOW, many))
    expect(hints.map((h) => `${h.component}.${h.metric}`)).toStrictEqual(['payment.rps', 'auth.p95', 'payment.p95'])
  })

  it('breaks ties by world order, then by MetricName order', () => {
    const ties: Anomaly[] = [
      { component: 'payment', metric: 'p95', fromTick: 0, factor: 2 },
      { component: 'payment', metric: 'rps', fromTick: 0, factor: 2 },
      { component: 'auth', metric: 'p95', fromTick: 0, factor: 2 },
      { component: 'gateway', metric: 'p95', fromTick: 0, factor: 2 },
    ]
    expect(dev(flat(NOW, ties)).map((h) => `${h.component}.${h.metric}`)).toStrictEqual([
      'gateway.p95',
      'auth.p95',
      'payment.rps',
    ])
  })

  it('clamps the look-back at tick 0 on a freshly created simulation', () => {
    const signal = askNpc({ kind: 'askNpc', role: 'oncall' }, flatCtx(flat(0, [{ component: 'payment', instance: 'payment-2', metric: 'cpu', fromTick: 0, factor: 2 }]), 0))
    expect(signal.tick).toBe(0)
    expect(signal.hints).toStrictEqual([
      { component: 'payment', instance: 'payment-2', metric: 'cpu', current: 40, usual: 20 },
    ])
  })

  it('compares only ticks present in both runs and skips candidates with no data', () => {
    const lastWeekShort = flat(NOW).filter((r) => !(r.type === 'metric' && r.component === 'auth'))
    const records = flat(NOW, [{ component: 'auth', metric: 'p95', fromTick: 0, factor: 5 }])
    expect(dev(records, NOW, lastWeekShort)).toStrictEqual([])
  })
})

describe('askNpc purity and DET', () => {
  it('does not alter either run it reads (Q-3)', () => {
    const records = telemetry(21, NOW, incident)
    const before = [sha(records), sha(lastWeekRecords)]
    for (const role of ['dev', 'dba', 'oncall'] as const) ask(role, records)
    expect([sha(records), sha(lastWeekRecords)]).toStrictEqual(before)
  })

  it('DET: same views and question give a byte-identical signal', () => {
    for (let seed = 0; seed < 10; seed++) {
      for (const role of ['dev', 'dba', 'oncall'] as const) {
        const a = ask(role, telemetry(seed, NOW, incident))
        const b = ask(role, telemetry(seed, NOW, incident))
        expect(sha(a)).toBe(sha(b))
        expect(a).toStrictEqual(b)
      }
    }
  })
})
