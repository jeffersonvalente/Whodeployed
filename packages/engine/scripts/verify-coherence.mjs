#!/usr/bin/env node
/**
 * Independent coherence verifier (PRD P-4, ADR-005 "Verificador independente").
 *
 * Reads engine NDJSON (a file path argument, or stdin when no argument / "-") and re-derives,
 * from the span records alone, what the metric records claim. It imports nothing from the
 * engine (`src/`) nor any package: only Node built-ins. Formulas are re-implemented from
 * ADR-005, on purpose, so a bug in the engine cannot hide behind shared code.
 *
 * Checks, reported in this order (the first deviation found wins):
 *   1. Format   every line is a JSON object with `type` in {metric, log, span, event} and an
 *               integer `tick` >= 0 (CLI-1, W-4); an optional field is omitted, never `null`
 *               (ADR-005 "campos opcionais ausentes são omitidos, nunca null", Emenda 1).
 *   2. P-1/P-2  for every metric record (per instance, and the component aggregate without
 *               `instance`), rps / errorPct / p50 / p95 / p99 equal the values recomputed from
 *               the `kind: 'server'` spans of that component (and instance) started in that tick,
 *               within 1e-9:
 *                 rps = n / 10; errorPct = errors / n * 100 (0 if n = 0);
 *                 pX = sorted[ceil(X / 100 * n) - 1] (nearest-rank, 0 if n = 0).
 *               The aggregate uses the union of the instance spans (never a mean of percentiles).
 *               A metric key may appear only once, and every (tick, component, instance) that
 *               has server spans must have a metric record (nothing is sampled away).
 *   3. P-3      every span with status 'error' has >= 1 log of level 'error' with the same
 *               component, instance, tick and traceId.
 *   4. S-3      per traceId: unique spanIds, exactly one root (no parentId), every parentId
 *               refers to a span of the same trace, every span reaches the root, and for every
 *               child: durationMs <= parent.durationMs and
 *               startMs + durationMs <= parent.startMs + parent.durationMs.
 *
 * Exit codes: 0 everything matches (one summary line on stdout); 1 first deviation on stderr;
 * 2 usage or read error on stderr. Output depends only on the input bytes (deterministic).
 */
import { readFileSync } from 'node:fs'

const TOLERANCE = 1e-9
const TYPES = new Set(['metric', 'log', 'span', 'event'])
/** Optional fields per record type (ADR-005 key order): absent is fine, `null` is a deviation. */
const OPTIONAL_FIELDS = {
  metric: ['instance'],
  span: ['parentId', 'peer'],
  log: ['traceId', 'attrs'],
  event: ['instance', 'restart', 'note'],
}
const PERCENTILES = [
  ['p50', 50],
  ['p95', 95],
  ['p99', 99],
]

class Deviation extends Error {}

const fail = (message) => {
  throw new Deviation(message)
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** Nearest-rank percentile over ascending-sorted values; 0 for an empty list (ADR-005). */
function nearestRank(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}

/** Request metrics re-derived from server spans (P-1). */
function derive(spans) {
  const n = spans.length
  const errors = spans.filter((s) => s.status === 'error').length
  const sorted = spans.map((s) => s.durationMs).sort((a, b) => a - b)
  const out = { rps: n / 10, errorPct: n === 0 ? 0 : (errors / n) * 100 }
  for (const [name, p] of PERCENTILES) out[name] = nearestRank(sorted, p)
  return out
}

/** "tick|component|instance"; the aggregate uses an empty instance. JSON keeps it unambiguous. */
const keyOf = (tick, component, instance) => JSON.stringify([tick, component, instance ?? null])

function describeKey(record) {
  const where = record.instance === undefined ? 'aggregate' : `instance ${JSON.stringify(record.instance)}`
  return `tick ${record.tick}, component ${JSON.stringify(record.component)}, ${where}`
}

function parse(text) {
  const records = []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const [index, line] of lines.entries()) {
    const lineNo = index + 1
    let record
    try {
      record = JSON.parse(line)
    } catch {
      fail(`line ${lineNo}: not valid JSON`)
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      fail(`line ${lineNo}: not a JSON object`)
    }
    if (!TYPES.has(record.type)) {
      fail(`line ${lineNo}: type ${JSON.stringify(record.type)} is not one of metric, log, span, event`)
    }
    if (!Number.isInteger(record.tick) || record.tick < 0) {
      fail(`line ${lineNo}: tick ${JSON.stringify(record.tick)} is not an integer >= 0`)
    }
    for (const field of OPTIONAL_FIELDS[record.type]) {
      if (record[field] === null) {
        fail(`line ${lineNo}: ${record.type} field ${field} is null; an optional field is omitted, never null (ADR-005)`)
      }
    }
    if (record.type === 'span') {
      for (const field of ['traceId', 'spanId', 'component', 'instance', 'kind', 'status']) {
        if (typeof record[field] !== 'string') fail(`line ${lineNo}: span field ${field} is not a string`)
      }
      if (record.parentId !== undefined && typeof record.parentId !== 'string') {
        fail(`line ${lineNo}: span field parentId is not a string`)
      }
      for (const field of ['startMs', 'durationMs']) {
        if (!isNumber(record[field])) fail(`line ${lineNo}: span field ${field} is not a number`)
      }
    }
    if (record.type === 'metric') {
      if (typeof record.component !== 'string') fail(`line ${lineNo}: metric field component is not a string`)
      for (const field of ['rps', 'errorPct', 'p50', 'p95', 'p99']) {
        if (!isNumber(record[field])) fail(`line ${lineNo}: metric field ${field} is not a number`)
      }
    }
    records.push({ lineNo, record })
  }
  return records
}

function checkMetrics(records) {
  /** Server spans grouped by instance key and by aggregate key, in input order. */
  const serverSpans = new Map()
  const add = (key, span) => {
    const list = serverSpans.get(key)
    if (list === undefined) serverSpans.set(key, [span])
    else list.push(span)
  }
  for (const { record } of records) {
    if (record.type !== 'span' || record.kind !== 'server') continue
    add(keyOf(record.tick, record.component, record.instance), record)
    add(keyOf(record.tick, record.component, undefined), record)
  }

  const seen = new Map()
  let checked = 0
  for (const { lineNo, record } of records) {
    if (record.type !== 'metric') continue
    const key = keyOf(record.tick, record.component, record.instance)
    if (seen.has(key)) {
      fail(`line ${lineNo}: duplicate metric record for ${describeKey(record)} (first at line ${seen.get(key)})`)
    }
    seen.set(key, lineNo)
    const spans = serverSpans.get(key) ?? []
    const expected = derive(spans)
    for (const name of ['rps', 'errorPct', 'p50', 'p95', 'p99']) {
      if (Math.abs(record[name] - expected[name]) > TOLERANCE) {
        fail(
          `line ${lineNo}: P-${record.instance === undefined ? '2' : '1'} ${name} mismatch for ${describeKey(record)}: ` +
            `metric says ${JSON.stringify(record[name])}, ${spans.length} server span(s) give ${JSON.stringify(expected[name])}`,
        )
      }
    }
    checked++
  }

  for (const { lineNo, record } of records) {
    if (record.type !== 'span' || record.kind !== 'server') continue
    for (const instance of [record.instance, undefined]) {
      if (!seen.has(keyOf(record.tick, record.component, instance))) {
        fail(
          `line ${lineNo}: P-4 server span ${JSON.stringify(record.spanId)} has no metric record for ` +
            describeKey({ tick: record.tick, component: record.component, instance }),
        )
      }
    }
  }
  return checked
}

function checkErrorLogs(records) {
  const errorLogs = new Set()
  for (const { record } of records) {
    if (record.type === 'log' && record.level === 'error' && record.traceId !== undefined) {
      errorLogs.add(JSON.stringify([record.tick, record.component, record.instance, record.traceId]))
    }
  }
  let checked = 0
  for (const { lineNo, record } of records) {
    if (record.type !== 'span' || record.status !== 'error') continue
    if (!errorLogs.has(JSON.stringify([record.tick, record.component, record.instance, record.traceId]))) {
      fail(
        `line ${lineNo}: P-3 error span ${JSON.stringify(record.spanId)} has no 'error' log with the same ` +
          `component ${JSON.stringify(record.component)}, instance ${JSON.stringify(record.instance)}, ` +
          `tick ${record.tick} and traceId ${JSON.stringify(record.traceId)}`,
      )
    }
    checked++
  }
  return checked
}

function checkTraces(records) {
  /** traceId -> entries in input order; Map keeps first-appearance order of traces. */
  const traces = new Map()
  for (const entry of records) {
    if (entry.record.type !== 'span') continue
    const list = traces.get(entry.record.traceId)
    if (list === undefined) traces.set(entry.record.traceId, [entry])
    else list.push(entry)
  }

  for (const [traceId, entries] of traces) {
    const byId = new Map()
    for (const { lineNo, record } of entries) {
      if (byId.has(record.spanId)) {
        fail(`line ${lineNo}: S-3 trace ${JSON.stringify(traceId)} repeats spanId ${JSON.stringify(record.spanId)}`)
      }
      byId.set(record.spanId, { lineNo, record })
    }
    const roots = entries.filter(({ record }) => record.parentId === undefined)
    if (roots.length !== 1) {
      const lines = roots.map(({ lineNo }) => lineNo).join(', ')
      fail(
        `line ${entries[0].lineNo}: S-3 trace ${JSON.stringify(traceId)} has ${roots.length} roots` +
          (roots.length > 0 ? ` (lines ${lines})` : ''),
      )
    }
    for (const { lineNo, record } of entries) {
      if (record.parentId === undefined) continue
      const parent = byId.get(record.parentId)?.record
      if (parent === undefined) {
        fail(
          `line ${lineNo}: S-3 span ${JSON.stringify(record.spanId)} has parentId ${JSON.stringify(record.parentId)} ` +
            `not found in trace ${JSON.stringify(traceId)}`,
        )
      }
      if (record.durationMs > parent.durationMs) {
        fail(
          `line ${lineNo}: S-3 span ${JSON.stringify(record.spanId)} lasts ${record.durationMs} ms, ` +
            `longer than its parent ${JSON.stringify(parent.spanId)} (${parent.durationMs} ms)`,
        )
      }
      if (record.startMs + record.durationMs > parent.startMs + parent.durationMs) {
        fail(
          `line ${lineNo}: S-3 span ${JSON.stringify(record.spanId)} ends at ${record.startMs + record.durationMs} ms, ` +
            `after its parent ${JSON.stringify(parent.spanId)} (${parent.startMs + parent.durationMs} ms)`,
        )
      }
    }
    // With one root and every parent present, a span that cannot reach the root is in a cycle.
    for (const { lineNo, record } of entries) {
      let current = record
      for (let steps = 0; current.parentId !== undefined; steps++) {
        if (steps >= entries.length) {
          fail(`line ${lineNo}: S-3 span ${JSON.stringify(record.spanId)} is in a parent cycle, not under the root`)
        }
        current = byId.get(current.parentId).record
      }
    }
  }
  return traces.size
}

function verify(text) {
  const records = parse(text)
  const metrics = checkMetrics(records)
  const errorSpans = checkErrorLogs(records)
  const traces = checkTraces(records)
  return `ok: ${records.length} records; ${metrics} metric records, ${errorSpans} error spans, ${traces} traces coherent`
}

function readInput(argv) {
  if (argv.length > 1) {
    throw new Error('usage: verify-coherence.mjs [file.ndjson | -]   (reads stdin when no file is given)')
  }
  const source = argv[0] === undefined || argv[0] === '-' ? 0 : argv[0]
  try {
    return readFileSync(source, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${source === 0 ? 'stdin' : JSON.stringify(source)}: ${error.message}`)
  }
}

function main(argv) {
  let text
  try {
    text = readInput(argv)
  } catch (error) {
    process.stderr.write(`verify-coherence: ${error.message}\n`)
    return 2
  }
  try {
    process.stdout.write(`verify-coherence: ${verify(text)}\n`)
    return 0
  } catch (error) {
    if (!(error instanceof Deviation)) throw error
    process.stderr.write(`verify-coherence: ${error.message}\n`)
    return 1
  }
}

process.exitCode = main(process.argv.slice(2))
