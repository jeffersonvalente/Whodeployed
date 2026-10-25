/**
 * GenerateLogs (ADR-002 §3 step 6, ADR-005 "Logs").
 *
 * Order of the returned list (ADR-005 "Ordem das linhas", item 3): fault logs first, in the
 * order received (the orchestrator already concatenates them in fault order), then request logs
 * in span order.
 *
 * Request logs:
 * - every span with status 'error' (client or server) yields exactly one 'error' log on the same
 *   component, instance and tick, with the same traceId and the message of its ErrorDetail (P-3);
 * - every 'server' span draws once from the stream ('logs', tick, component, instance) and, when
 *   it is 'ok', emits an 'info' log with probability INFO_SAMPLE_RATE. The draw happens for every
 *   server span regardless of status, so the stream advances the same way whatever fails.
 *
 * Messages are generic English telemetry, never scenario text (S-5). No I/O, no clock.
 */
import type {
  ErrorDetail,
  FaultLog,
  GenerateLogs,
  GenerateLogsInput,
  LogLevel,
  LogRecord,
  Rng,
  SpanRecord,
} from '../types.js'

/** Log level vocabulary (S-2), in severity order. */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** Fraction of server spans that get an 'info' log (ADR-005: ~20%). */
export const INFO_SAMPLE_RATE = 0.2

/** Message of sampled 'info' request logs. */
export const REQUEST_COMPLETED = 'request completed'

/**
 * Builds a LogRecord with the key order of ADR-005
 * (`type, tick, component, instance, level, message, traceId?, attrs?`), omitting absent optionals.
 */
function logRecord(tick: number, log: FaultLog): LogRecord {
  if (!LOG_LEVELS.includes(log.level)) {
    throw new Error(`invalid log level '${String(log.level)}'; valid: ${LOG_LEVELS.join(', ')}`)
  }
  const record: LogRecord = {
    type: 'log',
    tick,
    component: log.component,
    instance: log.instance,
    level: log.level,
    message: log.message,
  }
  if (log.traceId !== undefined) record.traceId = log.traceId
  if (log.attrs !== undefined) record.attrs = { ...log.attrs }
  return record
}

function errorLog(tick: number, span: SpanRecord, detail: ErrorDetail): LogRecord {
  return logRecord(tick, {
    component: span.component,
    instance: span.instance,
    level: 'error',
    message: detail.message,
    traceId: span.traceId,
    attrs: {
      operation: span.operation,
      spanId: span.spanId,
      ...(span.peer !== undefined ? { peer: span.peer } : {}),
      ...detail.attrs,
    },
  })
}

function infoLog(tick: number, span: SpanRecord): LogRecord {
  return logRecord(tick, {
    component: span.component,
    instance: span.instance,
    level: 'info',
    message: REQUEST_COMPLETED,
    traceId: span.traceId,
    attrs: { operation: span.operation, durationMs: span.durationMs },
  })
}

export const generateLogs: GenerateLogs = (input: GenerateLogsInput): LogRecord[] => {
  const { tick, spans, errors, faultLogs, rng } = input

  const details = new Map<string, ErrorDetail>()
  for (const detail of errors) {
    if (details.has(detail.spanId)) throw new Error(`duplicate ErrorDetail for span '${detail.spanId}'`)
    details.set(detail.spanId, detail)
  }

  const out: LogRecord[] = faultLogs.map((log) => logRecord(tick, log))

  const streams = new Map<string, Rng>()
  const streamOf = (span: SpanRecord): Rng => {
    const k = `${span.component}\u001f${span.instance}`
    let stream = streams.get(k)
    if (!stream) {
      stream = rng('logs', tick, span.component, span.instance)
      streams.set(k, stream)
    }
    return stream
  }

  let matched = 0
  for (const span of spans) {
    if (span.status === 'error') {
      const detail = details.get(span.spanId)
      if (!detail) throw new Error(`error span '${span.spanId}' has no ErrorDetail (P-3)`)
      matched += 1
      out.push(errorLog(tick, span, detail))
    }
    if (span.kind === 'server') {
      const sampled = streamOf(span).chance(INFO_SAMPLE_RATE)
      if (sampled && span.status === 'ok') out.push(infoLog(tick, span))
    }
  }
  if (matched !== details.size) {
    const orphan = errors.find((d) => !spans.some((s) => s.spanId === d.spanId && s.status === 'error'))
    throw new Error(`ErrorDetail for span '${orphan?.spanId ?? '?'}' has no matching error span (P-3)`)
  }
  return out
}
