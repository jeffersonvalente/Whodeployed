/**
 * T1.7 — generateLogs (ADR-005 "Logs"; PRD S-2, P-3).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { INFO_SAMPLE_RATE, LOG_LEVELS, REQUEST_COMPLETED, generateLogs } from '../../src/sim/logs.js'
import type {
  ErrorDetail,
  FaultLog,
  GenerateLogsInput,
  LogRecord,
  Rng,
  RngFactory,
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

const world: World = { seed: 'w', tick: 0, services: [], deps: [] }
const TICK = 4
const COMPONENTS = [
  { name: 'api', instances: ['api-0', 'api-1', 'api-2'] },
  { name: 'db', instances: ['db-0'] },
]

let seq = 0
function span(partial: Partial<SpanRecord> & Pick<SpanRecord, 'component' | 'instance'>): SpanRecord {
  seq += 1
  return {
    type: 'span',
    tick: TICK,
    traceId: `t${TICK}r${seq}`,
    spanId: `t${TICK}r${seq}s0`,
    operation: 'op.run',
    kind: 'server',
    startMs: 0,
    durationMs: 10,
    status: 'ok',
    ...partial,
  }
}

function input(over: Partial<GenerateLogsInput> = {}): GenerateLogsInput {
  return { world, tick: TICK, spans: [], errors: [], faultLogs: [], rng: factory('logs-test'), ...over }
}

const MESSAGES = ['connection refused', 'upstream timeout', 'no space left on device']

/** Random tick: spans of every kind and status, with one ErrorDetail per error span. */
function randomTick(rng: Rng): { spans: SpanRecord[]; errors: ErrorDetail[] } {
  const spans: SpanRecord[] = []
  const errors: ErrorDetail[] = []
  const count = rng.int(0, 80)
  for (let i = 0; i < count; i++) {
    const c = rng.pick(COMPONENTS)
    const kind = rng.pick(['server', 'server', 'client', 'internal'] as const)
    const s = span({
      component: c.name,
      instance: rng.pick(c.instances),
      kind,
      ...(kind === 'client' ? { peer: 'db' } : {}),
      status: rng.chance(0.25) ? 'error' : 'ok',
      durationMs: rng.int(0, 2000),
    })
    spans.push(s)
    if (s.status === 'error') {
      errors.push({
        spanId: s.spanId,
        message: rng.pick(MESSAGES),
        ...(rng.chance(0.5) ? { attrs: { attempt: rng.int(0, 3) } } : {}),
      })
    }
  }
  // ErrorDetails may come in any order; generateLogs follows span order.
  return { spans, errors: [...errors].reverse() }
}

const LOG_KEYS = ['type', 'tick', 'component', 'instance', 'level', 'message', 'traceId', 'attrs']

/** S-2 format: header fields, level vocabulary, ADR-005 key order, one JSON line. */
function assertFormat(log: LogRecord) {
  expect(log.type).toBe('log')
  expect(Number.isInteger(log.tick)).toBe(true)
  expect(typeof log.component).toBe('string')
  expect(typeof log.instance).toBe('string')
  expect(LOG_LEVELS).toContain(log.level)
  expect(typeof log.message).toBe('string')
  expect(log.message.length).toBeGreaterThan(0)
  const keys = Object.keys(log)
  expect(keys).toEqual(LOG_KEYS.filter((k) => keys.includes(k)))
  for (const v of Object.values(log)) expect(v).not.toBeUndefined()
  if (log.attrs) for (const v of Object.values(log.attrs)) expect(['string', 'number']).toContain(typeof v)
  const line = JSON.stringify(log)
  expect(line).not.toContain('\n')
  expect(JSON.parse(line)).toEqual(log)
}

// --- tests -------------------------------------------------------------------------------

describe('generateLogs — vocabulary and format (S-2)', () => {
  it('uses exactly the level vocabulary debug, info, warn, error', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('every log of 200 random ticks matches the format and is one JSON line', () => {
    for (let s = 0; s < 200; s++) {
      const { spans, errors } = randomTick(rngFrom(hash32(`fmt-${s}`)))
      const faultLogs: FaultLog[] = [{ component: 'db', instance: 'db-0', level: 'warn', message: 'disk usage high', attrs: { usagePct: 91 } }]
      const logs = generateLogs(input({ spans, errors, faultLogs, rng: factory(`fmt-${s}`) }))
      for (const log of logs) {
        assertFormat(log)
        expect(log.tick).toBe(TICK)
      }
      // request logs are tied to a request
      for (const log of logs.slice(faultLogs.length)) expect(log.traceId).toMatch(/^t\d+r\d+$/)
    }
  })
})

describe('generateLogs — fault logs', () => {
  it('come first, in the order received, with key order and optional fields as given', () => {
    const faultLogs: FaultLog[] = [
      { component: 'api', instance: 'api-1', level: 'error', message: 'process exited', attrs: { exitCode: 137, restartCount: 2 } },
      { component: 'db', instance: 'db-0', level: 'warn', message: 'disk usage high' },
      { component: 'api', instance: 'api-0', level: 'debug', message: 'pool stats', traceId: 't4r9' },
    ]
    const spans = [span({ component: 'api', instance: 'api-0', status: 'error' })]
    const errors = [{ spanId: spans[0]!.spanId, message: 'upstream timeout' }]
    const logs = generateLogs(input({ spans, errors, faultLogs }))
    expect(logs.slice(0, 3)).toStrictEqual([
      { type: 'log', tick: TICK, component: 'api', instance: 'api-1', level: 'error', message: 'process exited', attrs: { exitCode: 137, restartCount: 2 } },
      { type: 'log', tick: TICK, component: 'db', instance: 'db-0', level: 'warn', message: 'disk usage high' },
      { type: 'log', tick: TICK, component: 'api', instance: 'api-0', level: 'debug', message: 'pool stats', traceId: 't4r9' },
    ])
    expect(logs[3]!.message).toBe('upstream timeout')
    expect(JSON.stringify(logs[0])).toBe(
      '{"type":"log","tick":4,"component":"api","instance":"api-1","level":"error","message":"process exited","attrs":{"exitCode":137,"restartCount":2}}',
    )
  })

  it('copies attrs (no aliasing of the fault module object)', () => {
    const attrs = { usagePct: 95 }
    const logs = generateLogs(input({ faultLogs: [{ component: 'db', instance: 'db-0', level: 'error', message: 'disk full', attrs }] }))
    attrs.usagePct = 1
    expect(logs[0]!.attrs).toEqual({ usagePct: 95 })
  })

  it('rejects a level outside the vocabulary', () => {
    const bad = { component: 'db', instance: 'db-0', level: 'fatal', message: 'x' } as unknown as FaultLog
    expect(() => generateLogs(input({ faultLogs: [bad] }))).toThrow(/invalid log level 'fatal'.*debug, info, warn, error/)
  })
})

describe('generateLogs — error logs (P-3)', () => {
  it('exactly one error log per error span, same component/instance/tick/traceId, message of its ErrorDetail, over 300 seeds', () => {
    for (let s = 0; s < 300; s++) {
      const { spans, errors } = randomTick(rngFrom(hash32(`p3-${s}`)))
      const logs = generateLogs(input({ spans, errors, rng: factory(`p3-${s}`) }))
      const errorLogs = logs.filter((l) => l.level === 'error')
      const errorSpans = spans.filter((x) => x.status === 'error')
      expect(errorLogs).toHaveLength(errorSpans.length)
      for (const es of errorSpans) {
        const detail = errors.find((d) => d.spanId === es.spanId)!
        const matching = errorLogs.filter((l) => l.attrs?.spanId === es.spanId)
        expect(matching).toHaveLength(1)
        const log = matching[0]!
        expect([log.component, log.instance, log.tick, log.traceId]).toEqual([es.component, es.instance, es.tick, es.traceId])
        expect(log.message).toBe(detail.message)
        for (const [k, v] of Object.entries(detail.attrs ?? {})) expect(log.attrs?.[k]).toBe(v)
      }
    }
  })

  it('request logs follow span order, error log carries operation, spanId and peer', () => {
    const a = span({ component: 'api', instance: 'api-0', kind: 'client', peer: 'db', operation: 'db.query', status: 'error' })
    const b = span({ component: 'api', instance: 'api-0', status: 'error', operation: 'http.request' })
    const errors = [
      { spanId: b.spanId, message: 'upstream error' },
      { spanId: a.spanId, message: 'connection refused', attrs: { attempt: 1 } },
    ]
    const logs = generateLogs(input({ spans: [a, b], errors }))
    expect(logs.map((l) => l.message)).toEqual(['connection refused', 'upstream error'])
    expect(logs[0]!.attrs).toStrictEqual({ operation: 'db.query', spanId: a.spanId, peer: 'db', attempt: 1 })
    expect(logs[1]!.attrs).toStrictEqual({ operation: 'http.request', spanId: b.spanId })
  })

  it('fails loudly when the traffic contract (one ErrorDetail per error span) is broken', () => {
    const e = span({ component: 'api', instance: 'api-0', status: 'error' })
    const ok = span({ component: 'api', instance: 'api-0' })
    expect(() => generateLogs(input({ spans: [e] }))).toThrow(/has no ErrorDetail/)
    expect(() =>
      generateLogs(input({ spans: [e], errors: [{ spanId: e.spanId, message: 'x' }, { spanId: e.spanId, message: 'y' }] })),
    ).toThrow(/duplicate ErrorDetail/)
    expect(() =>
      generateLogs(input({ spans: [e, ok], errors: [{ spanId: e.spanId, message: 'x' }, { spanId: ok.spanId, message: 'y' }] })),
    ).toThrow(new RegExp(`'${ok.spanId}' has no matching error span`))
  })
})

describe('generateLogs — sampled info logs', () => {
  it('only for ok server spans, about INFO_SAMPLE_RATE of them', () => {
    const spans: SpanRecord[] = []
    for (let i = 0; i < 4000; i++) {
      spans.push(span({ component: 'api', instance: `api-${i % 3}` }))
      spans.push(span({ component: 'api', instance: `api-${i % 3}`, kind: 'client', peer: 'db' }))
      spans.push(span({ component: 'api', instance: `api-${i % 3}`, kind: 'internal' }))
    }
    const logs = generateLogs(input({ spans }))
    const info = logs.filter((l) => l.level === 'info')
    expect(logs).toHaveLength(info.length)
    const byTrace = new Map(spans.map((s) => [s.traceId, s]))
    for (const log of info) {
      const s = byTrace.get(log.traceId!)!
      expect(s.kind).toBe('server')
      expect(log.message).toBe(REQUEST_COMPLETED)
      expect(log.attrs).toStrictEqual({ operation: s.operation, durationMs: s.durationMs })
      expect([log.component, log.instance]).toEqual([s.component, s.instance])
    }
    const rate = info.length / 4000
    expect(rate).toBeGreaterThan(INFO_SAMPLE_RATE - 0.03)
    expect(rate).toBeLessThan(INFO_SAMPLE_RATE + 0.03)
  })

  it('a failing span does not shift the sampling of the other spans (one draw per server span)', () => {
    const spans = Array.from({ length: 60 }, (_, i) => span({ component: 'api', instance: 'api-0', durationMs: i }))
    const okLogs = generateLogs(input({ spans }))
    const failed = spans.map((s, i) => (i === 3 ? { ...s, status: 'error' as const } : s))
    const withError = generateLogs(input({ spans: failed, errors: [{ spanId: spans[3]!.spanId, message: 'boom' }] }))
    const infoTraces = (logs: LogRecord[]) => logs.filter((l) => l.level === 'info').map((l) => l.traceId)
    expect(infoTraces(withError)).toEqual(infoTraces(okLogs).filter((t) => t !== spans[3]!.traceId))
  })

  it('empty tick yields no logs', () => {
    expect(generateLogs(input())).toEqual([])
  })
})

describe('generateLogs — determinism (DET)', () => {
  const sha = (logs: LogRecord[]) => createHash('sha256').update(logs.map((l) => JSON.stringify(l)).join('\n')).digest('hex')

  it('same input + same factory seed ⇒ identical list, byte for byte', () => {
    const { spans, errors } = randomTick(rngFrom(42))
    const faultLogs: FaultLog[] = [{ component: 'api', instance: 'api-2', level: 'error', message: 'process exited' }]
    const a = generateLogs(input({ spans, errors, faultLogs, rng: factory('det') }))
    const b = generateLogs(input({ spans, errors, faultLogs, rng: factory('det') }))
    expect(b).toStrictEqual(a)
    expect(sha(b)).toBe(sha(a))
  })

  it('a different seed changes only the info sampling; error and fault logs are the same', () => {
    const spans = Array.from({ length: 200 }, (_, i) =>
      span({ component: 'api', instance: `api-${i % 3}`, status: i % 7 === 0 ? 'error' : 'ok' }),
    )
    const errors = spans.filter((s) => s.status === 'error').map((s) => ({ spanId: s.spanId, message: 'upstream timeout' }))
    const a = generateLogs(input({ spans, errors, rng: factory('one') }))
    const b = generateLogs(input({ spans, errors, rng: factory('two') }))
    expect(sha(a)).not.toBe(sha(b))
    const notInfo = (logs: LogRecord[]) => logs.filter((l) => l.level !== 'info')
    expect(notInfo(b)).toStrictEqual(notInfo(a))
  })
})
