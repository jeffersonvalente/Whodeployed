/**
 * Canonical NDJSON serializer (ADR-005). One record = one line; byte-identical output for
 * equal records is what D-1/D-2 hash.
 *
 * - Keys are written in the fixed per-type order of ADR-005, never in object order, so two
 *   records built in different ways serialize identically.
 * - Optional fields that are absent (undefined) are omitted, never written as null.
 * - Every value is formatted by JSON.stringify (locale- and time-zone-independent, D-2).
 * - Fields not in the ADR-005 list are not written.
 * - `attrs` keeps the generator's insertion order (ADR-005), which is deterministic.
 * - Non-finite numbers (NaN, Infinity) would become `null` under JSON.stringify; they are an
 *   engine bug and are rejected with a TypeError instead of being written.
 */
import type {
  EventRecord,
  LogRecord,
  MetricRecord,
  SerializeRecord,
  SpanRecord,
  TelemetryRecord,
} from '../types.js'

type FieldList<R> = readonly (keyof R & string)[]

/** ADR-005 key order per record type. */
export const KEY_ORDER: {
  readonly metric: FieldList<MetricRecord>
  readonly span: FieldList<SpanRecord>
  readonly log: FieldList<LogRecord>
  readonly event: FieldList<EventRecord>
} = {
  metric: ['type', 'tick', 'component', 'instance', 'rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections'],
  span: [
    'type',
    'tick',
    'traceId',
    'spanId',
    'parentId',
    'component',
    'instance',
    'operation',
    'kind',
    'peer',
    'startMs',
    'durationMs',
    'status',
  ],
  log: ['type', 'tick', 'component', 'instance', 'level', 'message', 'traceId', 'attrs'],
  event: ['type', 'tick', 'kind', 'target', 'instance', 'restart', 'note'],
}

function formatValue(value: unknown, path: string): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`serializeRecord: ${path} is not a finite number (${String(value)})`)
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const parts: string[] = []
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue
      parts.push(`${JSON.stringify(key)}:${formatValue(inner, `${path}.${key}`)}`)
    }
    return `{${parts.join(',')}}`
  }
  throw new TypeError(`serializeRecord: ${path} has unsupported value ${JSON.stringify(value) ?? String(value)}`)
}

function writeFields<R extends TelemetryRecord>(record: R, fields: FieldList<R>): string {
  const parts: string[] = []
  for (const field of fields) {
    const value = record[field]
    if (value === undefined) continue
    parts.push(`${JSON.stringify(field)}:${formatValue(value, `${record.type}.${field}`)}`)
  }
  return `{${parts.join(',')}}`
}

/** Canonical NDJSON line for one record, without trailing newline (ADR-005). */
export const serializeRecord: SerializeRecord = (record) => {
  switch (record.type) {
    case 'metric':
      return writeFields(record, KEY_ORDER.metric)
    case 'span':
      return writeFields(record, KEY_ORDER.span)
    case 'log':
      return writeFields(record, KEY_ORDER.log)
    case 'event':
      return writeFields(record, KEY_ORDER.event)
    default: {
      const unknownType: unknown = (record as { type?: unknown }).type
      throw new TypeError(`serializeRecord: unknown record type ${JSON.stringify(unknownType) ?? String(unknownType)}`)
    }
  }
}

/** NDJSON document: one canonical line per record, each terminated by '\n' (empty input => ''). */
export function toNdjson(records: readonly TelemetryRecord[]): string {
  let out = ''
  for (const record of records) out += serializeRecord(record) + '\n'
  return out
}
