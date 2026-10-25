/**
 * T1.9 — `whatChanged` handler (Q-7, ADR-006) against a fake TelemetryView built here.
 * The real store (T1.8) is developed in parallel; this view honours the same contract
 * (closed tick intervals, record order preserved).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { whatChanged } from '../../src/questions/whatChanged.js'
import type { EventRecord, QuestionContext, TelemetryRecord, TelemetryView, World } from '../../src/types.js'

const world: World = { seed: 'fake', tick: 0, services: [], deps: [] }

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
    throw new Error('whatChanged must not read lastWeek')
  },
})

/**
 * Events as the orchestrator would record them: a fault deploy with instance (tick 12),
 * a noise deploy with note (tick 10), a noise config (tick 25), a fault restart (tick 30),
 * and a noise config at tick 3 that falls outside most windows. Logs and metrics around them.
 */
const events: EventRecord[] = [
  { type: 'event', tick: 3, kind: 'config', target: 'auth', note: 'rotate session ttl' },
  { type: 'event', tick: 10, kind: 'deploy', target: 'catalog', note: 'harmless frontend copy change' },
  { type: 'event', tick: 12, kind: 'deploy', target: 'payment', instance: 'payment-2' },
  { type: 'event', tick: 12, kind: 'config', target: 'gateway' },
  { type: 'event', tick: 25, kind: 'config', target: 'cart' },
  { type: 'event', tick: 30, kind: 'config', target: 'redis', restart: true },
]

function telemetry(now: number): TelemetryRecord[] {
  const out: TelemetryRecord[] = []
  for (let tick = 0; tick <= now; tick++) {
    out.push(...events.filter((e) => e.tick === tick))
    out.push({ type: 'log', tick, component: 'payment', instance: 'payment-0', level: 'info', message: 'request served' })
  }
  return out
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('whatChanged (Q-7)', () => {
  it('returns all and only the events with tick in [now - window, now], in record order', () => {
    const signal = whatChanged({ kind: 'whatChanged', window: 20 }, ctxOf(fakeView(telemetry(30), 30)))
    expect(signal).toMatchObject({ kind: 'whatChanged', from: 10, to: 30 })
    expect(signal.events).toStrictEqual(events.slice(1))
  })

  it('includes both window ends (closed interval)', () => {
    const view = fakeView(telemetry(25), 25)
    const signal = whatChanged({ kind: 'whatChanged', window: 13 }, ctxOf(view))
    expect([signal.from, signal.to]).toStrictEqual([12, 25])
    expect(signal.events.map((e) => e.tick)).toStrictEqual([12, 12, 25])
  })

  it('excludes events just outside the window', () => {
    const view = fakeView(telemetry(29), 29)
    const signal = whatChanged({ kind: 'whatChanged', window: 16 }, ctxOf(view))
    expect(signal.from).toBe(13)
    expect(signal.events).toStrictEqual([events[4]])
  })

  it('returns deploy and config events alike, fault and noise alike, fields untouched', () => {
    const signal = whatChanged({ kind: 'whatChanged', window: 30 }, ctxOf(fakeView(telemetry(30), 30)))
    expect(signal.events).toStrictEqual(events)
    expect(new Set(signal.events.map((e) => e.kind))).toStrictEqual(new Set(['deploy', 'config']))
    // Nothing in the signal tells a fault event from a noise one (SPEC §3.4, ADR-006).
    for (const e of signal.events) {
      expect(Object.keys(e).every((k) => ['type', 'tick', 'kind', 'target', 'instance', 'restart', 'note'].includes(k))).toBe(
        true,
      )
    }
  })

  it('clamps at tick 0 and is empty when nothing changed', () => {
    const quiet = telemetry(8).filter((r) => r.type !== 'event')
    const signal = whatChanged({ kind: 'whatChanged', window: 30 }, ctxOf(fakeView(quiet, 8)))
    expect([signal.from, signal.to]).toStrictEqual([0, 8])
    expect(signal.events).toStrictEqual([])
  })

  it('never returns non-event records', () => {
    const signal = whatChanged({ kind: 'whatChanged', window: 30 }, ctxOf(fakeView(telemetry(30), 30)))
    expect(signal.events.every((e) => e.type === 'event')).toBe(true)
  })

  it('does not alter the telemetry it reads (Q-3)', () => {
    const records = telemetry(30)
    const before = sha(records)
    whatChanged({ kind: 'whatChanged', window: 5 }, ctxOf(fakeView(records, 30)))
    expect(sha(records)).toBe(before)
  })

  it('DET: same view and question give a byte-identical signal', () => {
    for (let window = 1; window <= 40; window++) {
      const a = whatChanged({ kind: 'whatChanged', window }, ctxOf(fakeView(telemetry(35), 35)))
      const b = whatChanged({ kind: 'whatChanged', window }, ctxOf(fakeView(telemetry(35), 35)))
      expect(sha(a)).toBe(sha(b))
    }
  })
})
