/**
 * T1.5 — Canonical NDJSON serializer (ADR-005).
 * Criteria: CLI-1 (format: one JSON line per record, `type` discriminator), W-4 (tick on every
 * record), D-1 (byte-identical), D-2 (independent of TZ/LANG), DET.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { KEY_ORDER, serializeRecord, toNdjson } from '../../src/sim/serialize.js'
import type { EventRecord, LogRecord, MetricRecord, SpanRecord, TelemetryRecord } from '../../src/types.js'

const metricInstance: MetricRecord = {
  type: 'metric',
  tick: 12,
  component: 'payment',
  instance: 'payment-1',
  rps: 4.2,
  p50: 31,
  p95: 180,
  p99: 1910,
  errorPct: 2.380952380952381,
  cpu: 37.5,
  mem: 512.3,
  connections: 20,
}

const spanChild: SpanRecord = {
  type: 'span',
  tick: 12,
  traceId: 't12r3',
  spanId: 't12r3s2',
  parentId: 't12r3s1',
  component: 'payment',
  instance: 'payment-1',
  operation: 'db.query',
  kind: 'client',
  peer: 'postgres',
  startMs: 1900,
  durationMs: 8,
  status: 'error',
}

const logWithAttrs: LogRecord = {
  type: 'log',
  tick: 12,
  component: 'payment',
  instance: 'payment-1',
  level: 'error',
  message: 'connection pool exhausted',
  traceId: 't12r3',
  attrs: { pool: 'postgres', waitMs: 1900, 'é "q"': 'line\nbreak' },
}

const eventFull: EventRecord = {
  type: 'event',
  tick: 3,
  kind: 'config',
  target: 'redis',
  instance: 'redis-0',
  restart: true,
  note: 'harmless frontend copy change',
}

/** Reverses own-key order, to prove the output does not follow object order. */
function shuffled<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).reverse()) as T
}

describe('golden strings per type (ADR-005 key order)', () => {
  it('metric (instance record)', () => {
    expect(serializeRecord(metricInstance)).toBe(
      '{"type":"metric","tick":12,"component":"payment","instance":"payment-1","rps":4.2,"p50":31,"p95":180,"p99":1910,"errorPct":2.380952380952381,"cpu":37.5,"mem":512.3,"connections":20}',
    )
  })

  it('metric (aggregate record omits instance)', () => {
    const aggregate: MetricRecord = { ...metricInstance }
    delete aggregate.instance
    expect(serializeRecord({ ...aggregate, rps: 0, p50: 0, p95: 0, p99: 0, errorPct: 0 })).toBe(
      '{"type":"metric","tick":12,"component":"payment","rps":0,"p50":0,"p95":0,"p99":0,"errorPct":0,"cpu":37.5,"mem":512.3,"connections":20}',
    )
  })

  it('span (child client span with peer)', () => {
    expect(serializeRecord(spanChild)).toBe(
      '{"type":"span","tick":12,"traceId":"t12r3","spanId":"t12r3s2","parentId":"t12r3s1","component":"payment","instance":"payment-1","operation":"db.query","kind":"client","peer":"postgres","startMs":1900,"durationMs":8,"status":"error"}',
    )
  })

  it('span (root server span omits parentId and peer)', () => {
    const root: SpanRecord = {
      type: 'span',
      tick: 0,
      traceId: 't0r0',
      spanId: 't0r0s0',
      component: 'gateway',
      instance: 'gateway-2',
      operation: 'http.checkout',
      kind: 'server',
      startMs: 0,
      durationMs: 42,
      status: 'ok',
    }
    expect(serializeRecord(root)).toBe(
      '{"type":"span","tick":0,"traceId":"t0r0","spanId":"t0r0s0","component":"gateway","instance":"gateway-2","operation":"http.checkout","kind":"server","startMs":0,"durationMs":42,"status":"ok"}',
    )
  })

  it('log (with traceId and attrs, attrs in insertion order, JSON escaping)', () => {
    expect(serializeRecord(logWithAttrs)).toBe(
      '{"type":"log","tick":12,"component":"payment","instance":"payment-1","level":"error","message":"connection pool exhausted","traceId":"t12r3","attrs":{"pool":"postgres","waitMs":1900,"é \\"q\\"":"line\\nbreak"}}',
    )
  })

  it('log (no traceId, no attrs)', () => {
    const plain: LogRecord = {
      type: 'log',
      tick: 5,
      component: 'postgres',
      instance: 'postgres-0',
      level: 'warn',
      message: 'disk usage high',
    }
    expect(serializeRecord(plain)).toBe(
      '{"type":"log","tick":5,"component":"postgres","instance":"postgres-0","level":"warn","message":"disk usage high"}',
    )
  })

  it('event (all optional fields)', () => {
    expect(serializeRecord(eventFull)).toBe(
      '{"type":"event","tick":3,"kind":"config","target":"redis","instance":"redis-0","restart":true,"note":"harmless frontend copy change"}',
    )
  })

  it('event (no optional fields)', () => {
    expect(serializeRecord({ type: 'event', tick: 10, kind: 'deploy', target: 'catalog' })).toBe(
      '{"type":"event","tick":10,"kind":"deploy","target":"catalog"}',
    )
  })
})

describe('canonical form', () => {
  const all: TelemetryRecord[] = [eventFull, spanChild, logWithAttrs, metricInstance]

  it('key order is the ADR-005 order regardless of object key order', () => {
    for (const record of all) {
      const line = serializeRecord(shuffled(record))
      expect(line).toBe(serializeRecord(record))
      const keys = Object.keys(JSON.parse(line) as object)
      const order = KEY_ORDER[record.type] as readonly string[]
      expect(keys).toEqual(order.filter((k) => k in record))
    }
  })

  it('explicitly undefined optionals are omitted, never null', () => {
    const withUndefined = { ...spanChild, parentId: undefined, peer: undefined } as unknown as SpanRecord
    const line = serializeRecord(withUndefined)
    expect(line).not.toContain('null')
    expect(line).not.toContain('parentId')
    expect(line).not.toContain('peer')
    const attrsUndefined = { ...logWithAttrs, attrs: { a: 1, b: undefined } } as unknown as LogRecord
    expect(serializeRecord(attrsUndefined)).toContain('"attrs":{"a":1}')
  })

  it('fields outside ADR-005 are not written', () => {
    const extra = { ...eventFull, secret: 'x' } as unknown as EventRecord
    expect(serializeRecord(extra)).toBe(serializeRecord(eventFull))
  })

  it('every line round-trips through JSON.parse with a type discriminator and integer tick (CLI-1, W-4)', () => {
    for (const record of all) {
      const line = serializeRecord(record)
      expect(line).not.toContain('\n')
      const parsed = JSON.parse(line) as TelemetryRecord
      expect(parsed).toEqual(record)
      expect(['metric', 'log', 'span', 'event']).toContain(parsed.type)
      expect(Number.isInteger(parsed.tick)).toBe(true)
    }
  })

  it('numbers use JSON.stringify formatting', () => {
    const tiny = { ...metricInstance, rps: 0.1 + 0.2, errorPct: 1e-7, mem: -0 }
    const line = serializeRecord(tiny)
    expect(line).toContain('"rps":0.30000000000000004')
    expect(line).toContain('"errorPct":1e-7')
    expect(line).toContain('"mem":0')
  })

  it('rejects non-finite numbers instead of writing null', () => {
    expect(() => serializeRecord({ ...metricInstance, p95: Number.NaN })).toThrow(/metric\.p95 is not a finite number/)
    expect(() => serializeRecord({ ...metricInstance, cpu: Number.POSITIVE_INFINITY })).toThrow(TypeError)
    const badAttr = { ...logWithAttrs, attrs: { n: Number.NaN } }
    expect(() => serializeRecord(badAttr)).toThrow(/log\.attrs\.n/)
  })

  it('rejects unsupported values and unknown record types', () => {
    expect(() => serializeRecord({ ...eventFull, note: null } as unknown as EventRecord)).toThrow(/event\.note has unsupported value null/)
    expect(() => serializeRecord({ ...logWithAttrs, attrs: [1] } as unknown as LogRecord)).toThrow(TypeError)
    expect(() => serializeRecord({ ...eventFull, note: () => 1 } as unknown as EventRecord)).toThrow(/event\.note has unsupported value/)
    expect(() => serializeRecord({ type: 'alert', tick: 1 } as unknown as TelemetryRecord)).toThrow(/unknown record type "alert"/)
    expect(() => serializeRecord({ tick: 1 } as unknown as TelemetryRecord)).toThrow(/unknown record type undefined/)
  })
})

describe('toNdjson', () => {
  it('one line per record, each terminated by a newline, in input order', () => {
    const records: TelemetryRecord[] = [eventFull, spanChild, logWithAttrs, metricInstance]
    const text = toNdjson(records)
    expect(text.endsWith('\n')).toBe(true)
    expect(text.split('\n').slice(0, -1)).toEqual(records.map(serializeRecord))
    expect(toNdjson([])).toBe('')
  })
})

describe('DET: determinism (D-1, D-2)', () => {
  const records: TelemetryRecord[] = [eventFull, spanChild, logWithAttrs, metricInstance]
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const originalTz = process.env.TZ

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  it('same records serialize to byte-identical output across runs', () => {
    expect(hash(toNdjson(records))).toBe(hash(toNdjson(records.map((r) => shuffled(structuredClone(r))))))
  })

  it('output is identical when process.env.TZ changes in-process', () => {
    process.env.TZ = 'UTC'
    const utc = toNdjson(records)
    process.env.TZ = 'Asia/Tokyo'
    const tokyo = toNdjson(records)
    expect(tokyo).toBe(utc)
  })

  it('separate processes under TZ=UTC LANG=C and TZ=Asia/Tokyo LANG=pt_BR.UTF-8 give the same hash', () => {
    const modPath = fileURLToPath(new URL('../../src/sim/serialize.ts', import.meta.url))
    const script = [
      `import { toNdjson } from ${JSON.stringify(modPath)}`,
      `import { createHash } from 'node:crypto'`,
      `const records = JSON.parse(process.env.RECORDS)`,
      `process.stdout.write(createHash('sha256').update(toNdjson(records)).digest('hex'))`,
    ].join('\n')
    const run = (env: Record<string, string>) => {
      const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        env: { ...process.env, ...env, RECORDS: JSON.stringify(records) },
        encoding: 'utf8',
      })
      expect(res.status, res.stderr).toBe(0)
      return res.stdout
    }
    const utc = run({ TZ: 'UTC', LANG: 'C', LC_ALL: 'C' })
    const tokyo = run({ TZ: 'Asia/Tokyo', LANG: 'pt_BR.UTF-8', LC_ALL: 'pt_BR.UTF-8' })
    expect(utc).toBe(tokyo)
    expect(utc).toBe(hash(toNdjson(records)))
  })
})
