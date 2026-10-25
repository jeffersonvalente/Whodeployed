/**
 * T1.9 — `logs` handler (Q-5, ADR-006) against a fake TelemetryView built here.
 * The real store (T1.8) is developed in parallel; this view honours the same contract
 * (closed tick intervals, record order preserved).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { logs, matchesFilter } from '../../src/questions/logs.js'
import type { LogLevel, LogRecord, QuestionContext, TelemetryRecord, TelemetryView, World } from '../../src/types.js'

const world: World = {
  seed: 'fake',
  tick: 0,
  services: [
    {
      name: 'payment',
      replicas: 3,
      instances: ['payment-0', 'payment-1', 'payment-2'],
      latencyP50Ms: 40,
      latencyP99Ms: 150,
      cpuBasePct: 6,
      cpuPerRequestPct: 2,
      memBaseMb: 320,
      calls: [],
      dbPoolSize: 20,
    },
    {
      name: 'cart',
      replicas: 1,
      instances: ['cart-0'],
      latencyP50Ms: 10,
      latencyP99Ms: 40,
      cpuBasePct: 3,
      cpuPerRequestPct: 0.6,
      memBaseMb: 256,
      calls: [],
      dbPoolSize: 20,
    },
  ],
  deps: [],
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
    throw new Error('logs must not read lastWeek')
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

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']
const MESSAGES = ['request served', 'upstream timeout', 'connection refused']

/** Logs of payment and cart for ticks [0, now], several per tick, some with traceId and attrs. */
function telemetry(seed: number, now: number): TelemetryRecord[] {
  const rand = prng(seed)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T
  const out: TelemetryRecord[] = []
  for (let tick = 0; tick <= now; tick++) {
    out.push({ type: 'event', tick, kind: 'config', target: 'payment' })
    for (let seq = 0; seq < 4; seq++) {
      const service = pick(world.services)
      const entry: LogRecord = {
        type: 'log',
        tick,
        component: service.name,
        instance: pick(service.instances),
        level: pick(LEVELS),
        message: pick(MESSAGES),
      }
      if (rand() < 0.7) entry.traceId = `t${tick}r${seq}`
      if (rand() < 0.6) entry.attrs = { peer: pick(['postgres', 'queue']), status: pick([200, 503]) }
      out.push(entry)
    }
  }
  return out
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const logsOf = (records: readonly TelemetryRecord[], component: string, from: number, to: number) =>
  records.filter(ofType('log')).filter((r) => r.component === component && r.tick >= from && r.tick <= to)

describe('logs window (Q-5: window in ticks, closed interval ending at now)', () => {
  it('returns only entries of the service with tick in [now - window, now], in record order', () => {
    const records = telemetry(1, 40)
    const signal = logs({ kind: 'logs', service: 'payment', window: 5 }, ctxOf(fakeView(records, 40)))
    expect(signal).toMatchObject({ kind: 'logs', service: 'payment', from: 35, to: 40 })
    expect(signal.entries.length).toBeGreaterThan(0)
    expect(signal.entries).toStrictEqual(logsOf(records, 'payment', 35, 40))
    expect(signal.entries.every((e) => e.component === 'payment' && e.tick >= 35 && e.tick <= 40)).toBe(true)
  })

  it('"last 5 minutes" is window: 30 (ADR-006)', () => {
    const records = telemetry(2, 100)
    const signal = logs({ kind: 'logs', service: 'cart', window: 30 }, ctxOf(fakeView(records, 100)))
    expect(signal.from).toBe(70)
    expect(signal.entries).toStrictEqual(logsOf(records, 'cart', 70, 100))
  })

  it('window: 1 covers the previous and the current tick', () => {
    const records = telemetry(3, 20)
    const signal = logs({ kind: 'logs', service: 'payment', window: 1 }, ctxOf(fakeView(records, 20)))
    expect([signal.from, signal.to]).toStrictEqual([19, 20])
    expect(new Set(signal.entries.map((e) => e.tick))).toStrictEqual(
      new Set(logsOf(records, 'payment', 19, 20).map((e) => e.tick)),
    )
  })

  it('clamps the window at tick 0', () => {
    const records = telemetry(4, 10)
    const signal = logs({ kind: 'logs', service: 'payment', window: 500 }, ctxOf(fakeView(records, 10)))
    expect(signal.from).toBe(0)
    expect(signal.entries).toStrictEqual(logsOf(records, 'payment', 0, 10))
  })

  it('returns an empty list when the service logged nothing in the window', () => {
    const records = telemetry(5, 10).filter((r) => !(r.type === 'log' && r.component === 'cart'))
    const signal = logs({ kind: 'logs', service: 'cart', window: 10 }, ctxOf(fakeView(records, 10)))
    expect(signal.entries).toStrictEqual([])
  })
})

describe('logs filter (Q-5, ADR-006)', () => {
  const records = telemetry(7, 60)
  const view = fakeView(records, 60)
  const all = logsOf(records, 'payment', 30, 60)
  const ask = (filter?: Record<string, string>) =>
    logs({ kind: 'logs', service: 'payment', window: 30, ...(filter === undefined ? {} : { filter }) }, ctxOf(view))
      .entries

  it('empty or absent filter means no filter', () => {
    expect(ask()).toStrictEqual(all)
    expect(ask({})).toStrictEqual(all)
  })

  it('filters by each top-level field: level, instance, message, traceId', () => {
    const errors = ask({ level: 'error' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors).toStrictEqual(all.filter((e) => e.level === 'error'))

    expect(ask({ instance: 'payment-1' })).toStrictEqual(all.filter((e) => e.instance === 'payment-1'))
    expect(ask({ message: 'upstream timeout' })).toStrictEqual(all.filter((e) => e.message === 'upstream timeout'))

    const traced = all.find((e) => e.traceId !== undefined)
    expect(traced).toBeDefined()
    const byTrace = ask({ traceId: traced?.traceId ?? '' })
    expect(byTrace).toStrictEqual(all.filter((e) => e.traceId === traced?.traceId))
  })

  it('filters by attrs keys, comparing String(value) (numbers match their decimal string)', () => {
    const peer = ask({ peer: 'postgres' })
    expect(peer.length).toBeGreaterThan(0)
    expect(peer).toStrictEqual(all.filter((e) => e.attrs?.peer === 'postgres'))

    const status = ask({ status: '503' })
    expect(status.length).toBeGreaterThan(0)
    expect(status).toStrictEqual(all.filter((e) => e.attrs?.status === 503))
    expect(ask({ status: '503.0' })).toStrictEqual([])
  })

  it('requires every pair to match (AND)', () => {
    const both = ask({ level: 'error', peer: 'queue' })
    expect(both).toStrictEqual(all.filter((e) => e.level === 'error' && e.attrs?.peer === 'queue'))
    expect(ask({ level: 'error', instance: 'cart-0' })).toStrictEqual([])
  })

  it('a key missing from the entry does not match', () => {
    expect(ask({ nosuchkey: 'x' })).toStrictEqual([])
    // Entries without attrs never match an attrs key; entries without traceId never match traceId.
    expect(ask({ peer: 'postgres' }).every((e) => e.attrs !== undefined)).toBe(true)
    const untraced: LogRecord = { type: 'log', tick: 0, component: 'payment', instance: 'payment-0', level: 'info', message: 'm' }
    expect(matchesFilter(untraced, { traceId: 'undefined' })).toBe(false)
  })

  it('top-level fields take precedence over an attrs key with the same name', () => {
    const entry: LogRecord = {
      type: 'log',
      tick: 3,
      component: 'payment',
      instance: 'payment-0',
      level: 'warn',
      message: 'm',
      attrs: { level: 'error' },
    }
    expect(matchesFilter(entry, { level: 'warn' })).toBe(true)
    expect(matchesFilter(entry, { level: 'error' })).toBe(false)
  })

  it('does not treat inherited properties of attrs as fields', () => {
    const entry: LogRecord = { type: 'log', tick: 0, component: 'payment', instance: 'payment-0', level: 'info', message: 'm', attrs: {} }
    expect(matchesFilter(entry, { toString: String(Object.prototype.toString) })).toBe(false)
  })

  it('does not alter the telemetry it reads (Q-3)', () => {
    const before = sha(records)
    ask({ level: 'error' })
    ask()
    expect(sha(records)).toBe(before)
  })
})

describe('logs DET', () => {
  it('same view and question give a byte-identical signal', () => {
    for (let seed = 0; seed < 20; seed++) {
      const q = { kind: 'logs', service: 'payment', window: 15, filter: { level: 'error' } } as const
      const a = logs(q, ctxOf(fakeView(telemetry(seed, 60), 60)))
      const b = logs(q, ctxOf(fakeView(telemetry(seed, 60), 60)))
      expect(sha(a)).toBe(sha(b))
      expect(a).toStrictEqual(b)
    }
  })
})
