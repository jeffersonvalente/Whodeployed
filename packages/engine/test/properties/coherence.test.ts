/**
 * T1.24 — coherence property suite over the real simulation (PRD P-1, P-2, P-3, Q-6, S-1, S-2,
 * S-3, S-4, W-4, DET; ADR-005 incl. Emenda 1; ADR-006 Emenda 1 "Q-6 na simulação real").
 *
 * Every run is `default-shop` x 30 ticks, for >= 100 seeds x (baseline + the 6 kinds of
 * `faultKinds`, each with its catalog defaults). The suite is parametrized by `faultKinds`, so a
 * fault module that replaces its T1.1 stub (T1.17–T1.22) is exercised here automatically.
 *
 * Independence: the expected metrics are recomputed in this file from the span records alone
 * (nearest-rank, rps, errorPct), without importing src/sim/metrics.ts; only the public index is
 * used to run the engine. The Q-6 part calls the `trace` and `dashboard` handlers on the live
 * view, tick by tick, with a QuestionContext built here; when ask() (T1.16) is implemented, the
 * Answer of `sim.ask()` is also compared with the handler output.
 *
 * As a cross-check, scripts/verify-coherence.mjs (T1.13, independent of this file too) is run on
 * the NDJSON of a few seeds.
 *
 * DET: seeds come from a PRNG local to this test with a fixed seed; violations are collected and
 * reported together (at most MAX_REPORTED per assertion) so the suite stays well under 60 s.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createSimulation,
  defaultShop,
  faultKinds,
  resolveFaults,
  simulate,
  toNdjson,
  type Fault,
  type FaultKind,
  type MetricRecord,
  type NoiseEvent,
  type SpanRecord,
  type TelemetryRecord,
  type World,
} from '../../src/index.js'
import { questionRegistry } from '../../src/questions/registry.js'
import type { QuestionContext } from '../../src/types.js'

const TICKS = 30
const PROPERTY_SEEDS = 100
const Q6_SEEDS = 10
const NOISE_SEEDS = 5
const VERIFIER_SEEDS = 3
const DET_SEEDS = 3
/** Seeds (per config) whose NDJSON is parsed back for the S-2 format checks; the rest skip it. */
const FORMAT_SEEDS = 10
const TOLERANCE = 1e-9
const MAX_REPORTED = 20
const PERCENTILES = [50, 95, 99] as const

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')

// ---------------------------------------------------------------------------------------------
// Test-local seed generation (DET): mulberry32 seeded with a fixed constant. Not the engine RNG.
// ---------------------------------------------------------------------------------------------

function testPrng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generateSeeds(count: number): string[] {
  const next = testPrng(0x7124)
  const seeds = new Set<string>()
  while (seeds.size < count) seeds.add(`prop-${Math.floor(next() * 0xffffffff).toString(36)}`)
  return [...seeds]
}

const SEEDS = generateSeeds(PROPERTY_SEEDS)

// ---------------------------------------------------------------------------------------------
// Configurations: baseline + one run per FaultKind with catalog defaults.
// ---------------------------------------------------------------------------------------------

type ConfigName = 'baseline' | FaultKind
const CONFIGS: readonly ConfigName[] = ['baseline', ...faultKinds]

/** Fault resolution reads only the catalog and the world structure; the seed is irrelevant. */
const referenceWorld: World = createSimulation({ system: defaultShop, seed: 'prop-world' }).world

const FAULTS = new Map<ConfigName, readonly Fault[]>(
  CONFIGS.map((name) => [name, name === 'baseline' ? [] : resolveFaults([{ kind: name }], referenceWorld)]),
)
const faultsOf = (config: ConfigName): readonly Fault[] => FAULTS.get(config) ?? []

function run(seed: string, config: ConfigName, noise?: readonly NoiseEvent[]): TelemetryRecord[] {
  return simulate({ system: defaultShop, seed, faults: faultsOf(config), ...(noise ? { noise } : {}) }, TICKS)
}

// ---------------------------------------------------------------------------------------------
// World facts, read from the World (not from default-shop constants).
// ---------------------------------------------------------------------------------------------

interface ComponentInfo {
  name: string
  instances: readonly string[]
}

function componentsOf(world: World): ComponentInfo[] {
  return [...world.services, ...world.deps].map((c) => ({ name: c.name, instances: c.instances }))
}

const COMPONENTS = componentsOf(referenceWorld)
const COMPONENT_NAMES = new Set(COMPONENTS.map((c) => c.name))
const INSTANCE_OWNER = new Map(COMPONENTS.flatMap((c) => c.instances.map((i) => [i, c.name] as const)))

// ---------------------------------------------------------------------------------------------
// Expected formats (ADR-005) and closed vocabularies (ADR-005 Emenda 1), restated here on purpose.
// ---------------------------------------------------------------------------------------------

/** Canonical key order per record type; `?` marks an optional key. */
const KEY_ORDER: Readonly<Record<TelemetryRecord['type'], readonly string[]>> = {
  metric: ['type', 'tick', 'component', 'instance?', 'rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections'],
  span: ['type', 'tick', 'traceId', 'spanId', 'parentId?', 'component', 'instance', 'operation', 'kind', 'peer?', 'startMs', 'durationMs', 'status'],
  log: ['type', 'tick', 'component', 'instance', 'level', 'message', 'traceId?', 'attrs?'],
  event: ['type', 'tick', 'kind', 'target', 'instance?', 'restart?', 'note?'],
}
const METRIC_NAMES = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections'] as const
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])
const SPAN_KINDS = new Set(['server', 'client', 'internal'])
const SPAN_STATUSES = new Set(['ok', 'error'])
const CHANGE_KINDS = new Set(['deploy', 'config'])
const ATTR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const MESSAGES = new Set([
  // traffic (T1.14)
  'connection refused',
  'upstream timeout',
  'upstream error',
  'dependency call failed',
  // request logs (T1.7)
  'request completed',
  // faults (ADR-004 "Semântica")
  'process exited',
  'no space left on device',
  'disk usage high',
  'connection pool timeout',
  'unhandled exception',
])
const TYPE_ORDER: Readonly<Record<TelemetryRecord['type'], number>> = { event: 0, span: 1, log: 2, metric: 3 }

// ---------------------------------------------------------------------------------------------
// Independent recomputation of the request metrics (P-1, P-2).
// ---------------------------------------------------------------------------------------------

interface RequestMetrics {
  rps: number
  errorPct: number
  p50: number
  p95: number
  p99: number
}

function nearestRankOf(sortedDurations: readonly number[], p: number): number {
  const n = sortedDurations.length
  if (n === 0) return 0
  return sortedDurations[Math.ceil((p / 100) * n) - 1] as number
}

function requestMetrics(servers: readonly SpanRecord[]): RequestMetrics {
  const n = servers.length
  const errors = servers.filter((s) => s.status === 'error').length
  const sorted = servers.map((s) => s.durationMs).sort((a, b) => a - b)
  return {
    rps: n / 10,
    errorPct: n === 0 ? 0 : (errors / n) * 100,
    p50: nearestRankOf(sorted, 50),
    p95: nearestRankOf(sorted, 95),
    p99: nearestRankOf(sorted, 99),
  }
}

const metricKey = (tick: number, component: string, instance?: string) => `${tick}|${component}|${instance ?? '*'}`

/** S-1: one metric record per tick x component (world order) x (instances, then the aggregate). */
const EXPECTED_METRIC_ORDER: readonly string[] = Array.from({ length: TICKS }, (_, tick) =>
  COMPONENTS.flatMap((c) => [...c.instances.map((i) => metricKey(tick, c.name, i)), metricKey(tick, c.name)]),
).flat()
const EXPECTED_METRIC_ORDER_TEXT = EXPECTED_METRIC_ORDER.join('\n')

// ---------------------------------------------------------------------------------------------
// The property check of one run. Returns violations (empty = coherent).
// ---------------------------------------------------------------------------------------------

class Violations {
  readonly list: string[] = []
  count = 0
  constructor(private readonly label: string) {}
  add(message: string): void {
    this.count += 1
    if (this.list.length < MAX_REPORTED) this.list.push(`${this.label}: ${message}`)
  }
}

function checkKeyOrder(record: Record<string, unknown>, v: Violations, where: string): void {
  const type = record.type as TelemetryRecord['type']
  const order = KEY_ORDER[type]
  if (order === undefined) {
    v.add(`${where}: unknown type ${String(record.type)}`)
    return
  }
  const keys = Object.keys(record)
  const expected = order.map((k) => k.replace('?', '')).filter((k) => keys.includes(k))
  const required = order.filter((k) => !k.endsWith('?'))
  if (keys.join(',') !== expected.join(',') || keys.length !== expected.length) {
    v.add(`${where}: keys [${keys.join(',')}] not in ADR-005 order [${order.join(',')}]`)
  }
  for (const k of required) if (!keys.includes(k)) v.add(`${where}: missing key ${k}`)
  for (const [k, value] of Object.entries(record)) if (value === null) v.add(`${where}: null in ${k}`)
}

/**
 * With `format`, the run is serialized with toNdjson and every line is parsed back, so key order,
 * optional keys and JSON-serializability are checked on the NDJSON itself (S-2, ADR-005); the
 * other properties are then checked on the parsed lines. Without it they are checked on the
 * records directly (same values, roughly half the cost).
 */
function checkRun(records: readonly TelemetryRecord[], label: string, format = true): Violations {
  const v = new Violations(label)
  let lines: readonly (string | TelemetryRecord)[] = records
  if (format) {
    lines = toNdjson(records).split('\n').filter((l) => l !== '')
    if (lines.length !== records.length) v.add(`NDJSON has ${lines.length} lines for ${records.length} records`)
  }

  const metrics = new Map<string, MetricRecord>()
  const serversBy = new Map<string, SpanRecord[]>()
  const spansByTrace = new Map<string, SpanRecord[]>()
  const errorLogCount = new Map<string, number>()
  const metricOrder: string[] = []
  let previousTick = -1
  let previousType = -1

  lines.forEach((line, index) => {
    const where = `record ${index + 1}`
    let record: TelemetryRecord
    if (typeof line === 'string') {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        v.add(`${where}: not JSON`)
        return
      }
      checkKeyOrder(parsed, v, where)
      record = parsed as unknown as TelemetryRecord
    } else {
      record = line
    }

    // W-4: integer tick in [0, TICKS); canonical order: tick ascending, then event/span/log/metric.
    if (!Number.isInteger(record.tick) || record.tick < 0 || record.tick >= TICKS) v.add(`${where}: tick ${record.tick}`)
    if (record.tick < previousTick) v.add(`${where}: tick goes back`)
    if (record.tick !== previousTick) previousType = -1
    const typeRank = TYPE_ORDER[record.type]
    if (typeRank < previousType) v.add(`${where}: ${record.type} after a later type in tick ${record.tick}`)
    previousTick = record.tick
    previousType = typeRank

    switch (record.type) {
      case 'metric': {
        const key = metricKey(record.tick, record.component, record.instance)
        if (metrics.has(key)) v.add(`${where}: duplicate metric ${key}`)
        metrics.set(key, record)
        metricOrder.push(key)
        for (const name of METRIC_NAMES) {
          const value = record[name]
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) v.add(`${where}: ${name}=${String(value)}`)
        }
        if (record.cpu > 100) v.add(`${where}: cpu ${record.cpu} > 100`)
        if (record.errorPct > 100) v.add(`${where}: errorPct ${record.errorPct} > 100`)
        if (!Number.isInteger(record.connections)) v.add(`${where}: connections ${record.connections} not integer`)
        break
      }
      case 'span': {
        if (INSTANCE_OWNER.get(record.instance) !== record.component) v.add(`${where}: instance ${record.instance} not of ${record.component}`)
        if (!SPAN_KINDS.has(record.kind)) v.add(`${where}: span kind ${record.kind}`)
        if (!SPAN_STATUSES.has(record.status)) v.add(`${where}: span status ${record.status}`)
        if ((record.kind === 'client') !== (record.peer !== undefined)) v.add(`${where}: peer must be present exactly on client spans`)
        if (record.peer !== undefined && !COMPONENT_NAMES.has(record.peer)) v.add(`${where}: unknown peer ${record.peer}`)
        if (!Number.isInteger(record.startMs) || record.startMs < 0) v.add(`${where}: startMs ${record.startMs}`)
        if (!Number.isInteger(record.durationMs) || record.durationMs < 0) v.add(`${where}: durationMs ${record.durationMs}`)
        if (typeof record.operation !== 'string' || record.operation === '') v.add(`${where}: empty operation`)
        const trace = spansByTrace.get(record.traceId) ?? []
        trace.push(record)
        spansByTrace.set(record.traceId, trace)
        if (record.kind === 'server') {
          for (const key of [metricKey(record.tick, record.component, record.instance), metricKey(record.tick, record.component)]) {
            const list = serversBy.get(key) ?? []
            list.push(record)
            serversBy.set(key, list)
          }
        }
        break
      }
      case 'log': {
        // S-2: structured entry; closed level and message vocabularies; attrs keys are identifiers.
        if (INSTANCE_OWNER.get(record.instance) !== record.component) v.add(`${where}: instance ${record.instance} not of ${record.component}`)
        if (!LOG_LEVELS.has(record.level)) v.add(`${where}: level ${record.level}`)
        if (!MESSAGES.has(record.message)) v.add(`${where}: message '${record.message}' not in the closed vocabulary`)
        if (record.traceId !== undefined && (typeof record.traceId !== 'string' || record.traceId === '')) v.add(`${where}: traceId`)
        if (record.attrs !== undefined) {
          if (typeof record.attrs !== 'object' || Array.isArray(record.attrs)) v.add(`${where}: attrs not an object`)
          for (const [key, value] of Object.entries(record.attrs)) {
            if (!ATTR_KEY.test(key)) v.add(`${where}: attrs key '${key}' does not match ${String(ATTR_KEY)}`)
            if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) v.add(`${where}: attrs.${key}=${String(value)}`)
          }
        }
        if (record.level === 'error' && record.traceId !== undefined) {
          const key = `${record.tick}|${record.component}|${record.instance}|${record.traceId}`
          errorLogCount.set(key, (errorLogCount.get(key) ?? 0) + 1)
        }
        break
      }
      case 'event': {
        if (!CHANGE_KINDS.has(record.kind)) v.add(`${where}: event kind ${record.kind}`)
        if (!COMPONENT_NAMES.has(record.target)) v.add(`${where}: event target ${record.target}`)
        if (record.instance !== undefined && INSTANCE_OWNER.get(record.instance) !== record.target) v.add(`${where}: event instance ${record.instance}`)
        if (record.restart !== undefined && record.restart !== true) v.add(`${where}: restart ${String(record.restart)}`)
        break
      }
    }
  })

  // S-1: every component x (instances, then aggregate) x tick has exactly one metric record, in
  // world order (ADR-005), and nothing else.
  if (metricOrder.join('\n') !== EXPECTED_METRIC_ORDER_TEXT) {
    const expectedOrder = EXPECTED_METRIC_ORDER
    const missing = expectedOrder.filter((k) => !metrics.has(k))
    const extra = metricOrder.filter((k) => !expectedOrder.includes(k))
    v.add(`S-1: metric records differ from world x ticks (missing ${missing.slice(0, 3).join(', ')}; extra ${extra.slice(0, 3).join(', ')}; or out of order)`)
  }
  for (const key of serversBy.keys()) if (!metrics.has(key)) v.add(`P-1: server spans without metric record ${key}`)

  // P-1 (instance) and P-2 (aggregate over the union of instance spans).
  for (const [key, record] of metrics) {
    const expected = requestMetrics(serversBy.get(key) ?? [])
    for (const name of ['rps', 'errorPct', 'p50', 'p95', 'p99'] as const) {
      if (Math.abs(record[name] - expected[name]) > TOLERANCE) {
        v.add(`${record.instance === undefined ? 'P-2' : 'P-1'} ${key} ${name}: metric ${record[name]} != spans ${expected[name]}`)
      }
    }
  }

  // S-3: one root per trace, parents resolvable inside the trace, child within its parent.
  for (const [traceId, spans] of spansByTrace) {
    const byId = new Map<string, SpanRecord>()
    for (const span of spans) {
      if (byId.has(span.spanId)) v.add(`S-3 ${traceId}: duplicate spanId ${span.spanId}`)
      byId.set(span.spanId, span)
    }
    const roots = spans.filter((s) => s.parentId === undefined)
    if (roots.length !== 1) v.add(`S-3 ${traceId}: ${roots.length} roots`)
    const root = roots[0]
    if (root !== undefined && (root.kind !== 'server' || root.startMs !== 0)) v.add(`S-3 ${traceId}: root is not a server span at 0 ms`)
    for (const span of spans) {
      if (span.tick !== spans[0]?.tick) v.add(`S-3 ${traceId}: spans in different ticks`)
      if (span.parentId === undefined) continue
      const parent = byId.get(span.parentId)
      if (parent === undefined) {
        v.add(`S-3 ${traceId}: ${span.spanId} has unknown parent ${span.parentId}`)
        continue
      }
      if (span.durationMs > parent.durationMs) v.add(`S-3 ${traceId}: ${span.spanId} longer than its parent`)
      if (span.startMs < parent.startMs) v.add(`S-3 ${traceId}: ${span.spanId} starts before its parent`)
      if (span.startMs + span.durationMs > parent.startMs + parent.durationMs) v.add(`S-3 ${traceId}: ${span.spanId} ends after its parent`)
    }
    // Every span reaches the root (no cycles).
    for (const span of spans) {
      let cursor: SpanRecord | undefined = span
      let steps = 0
      while (cursor?.parentId !== undefined && steps <= spans.length) {
        cursor = byId.get(cursor.parentId)
        steps += 1
      }
      if (cursor === undefined || cursor !== root) v.add(`S-3 ${traceId}: ${span.spanId} does not reach the root`)
    }
  }

  // P-3: one error log per error span, same component, instance, tick and traceId.
  const errorSpanCount = new Map<string, number>()
  for (const spans of spansByTrace.values()) {
    for (const span of spans) {
      if (span.status !== 'error') continue
      const key = `${span.tick}|${span.component}|${span.instance}|${span.traceId}`
      errorSpanCount.set(key, (errorSpanCount.get(key) ?? 0) + 1)
    }
  }
  for (const [key, spans] of errorSpanCount) {
    const logs = errorLogCount.get(key) ?? 0
    if (logs < spans) v.add(`P-3 ${key}: ${spans} error spans but ${logs} error logs`)
  }
  return v
}

function expectCoherent(v: Violations): void {
  expect(v.list, `${v.count} violation(s)`).toEqual([])
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------------------------

describe('T1.24 setup', () => {
  it('uses >= 100 distinct seeds from a fixed-seed test PRNG (DET)', () => {
    expect(SEEDS).toHaveLength(PROPERTY_SEEDS)
    expect(new Set(SEEDS).size).toBe(PROPERTY_SEEDS)
    expect(generateSeeds(PROPERTY_SEEDS)).toEqual(SEEDS)
  })

  it('covers baseline + every FaultKind of faultKinds, each with a resolved default fault', () => {
    expect(CONFIGS).toEqual(['baseline', ...faultKinds])
    expect(faultKinds).toHaveLength(6)
    for (const kind of faultKinds) {
      const faults = faultsOf(kind)
      expect(faults).toHaveLength(1)
      expect(faults[0]?.kind).toBe(kind)
      // The fault starts inside the 30 simulated ticks, so its active ticks are covered.
      expect(faults[0]?.startTick).toBeLessThan(TICKS)
    }
  })

  it('the checker rejects broken telemetry (self-test of the independent recomputation)', () => {
    const records = run(SEEDS[0] as string, 'baseline')
    expectCoherent(checkRun(records, 'intact'))

    const index = records.findIndex((r) => r.type === 'metric' && r.instance === undefined && r.rps > 0)
    const metric = records[index] as MetricRecord
    const withBadP95 = records.map((r, i) => (i === index ? { ...metric, p95: metric.p95 + 1 } : r))
    expect(checkRun(withBadP95, 'bad p95').list.join('\n')).toMatch(/P-2 .* p95/)

    // An ok server span turned into an error: no error log for it (P-3) and errorPct is off (P-1).
    const span = records.find((r): r is SpanRecord => r.type === 'span' && r.kind === 'server' && r.status === 'ok')
    expect(span).toBeDefined()
    const flipped = records.map((r) => (r === span ? { ...span, status: 'error' as const } : r))
    const flippedReport = checkRun(flipped, 'flipped').list.join('\n')
    expect(flippedReport).toMatch(/P-3/)
    expect(flippedReport).toMatch(/P-1 .* errorPct/)

    // A log outside the closed message vocabulary, with an integer-like attrs key (ADR-005 Emenda 1).
    const logIndex = records.findIndex((r) => r.type === 'log')
    expect(logIndex).toBeGreaterThanOrEqual(0)
    const badLog = records.map((r, i) =>
      i === logIndex && r.type === 'log' ? { ...r, message: 'checkout exploded', attrs: { ...r.attrs, '2': 1 } } : r,
    )
    const report = checkRun(badLog, 'bad log').list.join('\n')
    expect(report).toMatch(/closed vocabulary/)
    expect(report).toMatch(/attrs key '2'/)

    // A child span longer than its parent (S-3).
    const child = records.find((r): r is SpanRecord => r.type === 'span' && r.parentId !== undefined)
    expect(child).toBeDefined()
    const stretched = records.map((r) => (r === child ? { ...child, durationMs: child.durationMs + 100_000 } : r))
    expect(checkRun(stretched, 'stretched').list.join('\n')).toMatch(/S-3 .* longer than its parent/)

    // Key order of an NDJSON line (S-2). toNdjson always writes the canonical order, so the line
    // check is exercised directly on parsed objects.
    const keyCheck = (line: Record<string, unknown>) => {
      const v = new Violations('keys')
      checkKeyOrder(line, v, 'line')
      return v.list.join('\n')
    }
    expect(keyCheck({ type: 'log', tick: 0, component: 'c', instance: 'c-0', level: 'info', message: 'request completed' })).toBe('')
    expect(keyCheck({ type: 'log', tick: 0, level: 'info', component: 'c', instance: 'c-0', message: 'request completed' })).toMatch(/ADR-005 order/)
    expect(keyCheck({ type: 'event', tick: 0, kind: 'deploy', target: 'c', note: null })).toMatch(/null in note/)
    expect(keyCheck({ type: 'span', tick: 0 })).toMatch(/missing key traceId/)

    const withoutAMetric = records.filter((_, i) => i !== index)
    expect(checkRun(withoutAMetric, 'missing metric').list.join('\n')).toMatch(/S-1/)
  })
})

describe('P-1, P-2, P-3, S-1, S-2, S-3, W-4 over >= 100 seeds x 30 ticks', () => {
  for (const config of CONFIGS) {
    it(`${config}: ${PROPERTY_SEEDS} seeds`, () => {
      const reports: string[] = []
      let total = 0
      SEEDS.forEach((seed, index) => {
        const v = checkRun(run(seed, config), `${config}/${seed}`, index < FORMAT_SEEDS)
        total += v.count
        if (reports.length < MAX_REPORTED) reports.push(...v.list.slice(0, MAX_REPORTED - reports.length))
      })
      expect(reports, `${total} violation(s)`).toEqual([])
    }, 60_000)
  }
})

describe('DET: same seed + same config => byte-identical NDJSON', () => {
  for (const config of CONFIGS) {
    it(config, () => {
      for (const seed of SEEDS.slice(0, DET_SEEDS)) {
        expect(sha256(toNdjson(run(seed, config)))).toBe(sha256(toNdjson(run(seed, config))))
      }
    })
  }
})

describe('S-4: noise only adds event records', () => {
  const noise: NoiseEvent[] = [
    { kind: 'deploy', target: 'catalog', tick: 5, note: 'harmless frontend copy change' },
    { kind: 'config', target: 'gateway', tick: 14 },
  ]
  for (const config of CONFIGS) {
    it(config, () => {
      for (const seed of SEEDS.slice(0, NOISE_SEEDS)) {
        const plain = run(seed, config)
        const noisy = run(seed, config, noise)
        expectCoherent(checkRun(noisy, `${config}/${seed}+noise`, false))
        const nonEvents = (records: readonly TelemetryRecord[]) => toNdjson(records.filter((r) => r.type !== 'event'))
        expect(nonEvents(noisy)).toBe(nonEvents(plain))
        const extra = noisy.filter((r) => r.type === 'event').length - plain.filter((r) => r.type === 'event').length
        expect(extra).toBe(noise.length)
        for (const n of noise) {
          expect(noisy).toContainEqual({ type: 'event', tick: n.tick, kind: n.kind, target: n.target, ...(n.note ? { note: n.note } : {}) })
        }
      }
    })
  }
})

describe('Q-6 on the real simulation: trace focus duration = dashboard pXX, tick by tick', () => {
  // ask() is the T1.1 stub until T1.16 lands; probe it once instead of catching on every call.
  const askImplemented = (() => {
    try {
      createSimulation({ system: defaultShop, seed: 'prop-probe' }).ask({ kind: 'trace', service: COMPONENTS[0]?.name ?? '', percentile: 50 })
      return true
    } catch (error) {
      if (error instanceof Error && /not implemented/.test(error.message)) return false
      throw error
    }
  })()

  for (const config of CONFIGS) {
    it(`${config}: ${Q6_SEEDS} seeds x ${TICKS} ticks x every component x p50/p95/p99`, () => {
      const v = new Violations(config)
      let comparedWithAsk = 0
      for (const seed of SEEDS.slice(0, Q6_SEEDS)) {
        const sim = createSimulation({ system: defaultShop, seed, faults: faultsOf(config) })
        const view = sim.telemetry()
        const ctx: QuestionContext = {
          view,
          lastWeek: () => {
            throw new Error('trace and dashboard never use lastWeek (ADR-006 Emenda 1)')
          },
        }
        for (let tick = 0; tick < TICKS; tick += 1) {
          if (tick > 0) sim.advance(1)
          if (view.now !== tick) v.add(`view.now ${view.now} != ${tick}`)
          for (const { name } of COMPONENTS) {
            const dash = questionRegistry.dashboard({ kind: 'dashboard', service: name }, ctx)
            const aggregate = dash.records[dash.records.length - 1]
            if (aggregate === undefined || aggregate.tick !== tick || aggregate.instance !== undefined) {
              v.add(`${seed} t${tick} ${name}: dashboard has no aggregate for the current tick`)
              continue
            }
            const servers = view.spansOf(name, tick).filter((s) => s.kind === 'server')
            for (const percentile of PERCENTILES) {
              const question = { kind: 'trace', service: name, percentile } as const
              const signal = questionRegistry.trace(question, ctx)
              const expected = aggregate[`p${percentile}`]
              const where = `${seed} t${tick} ${name} p${percentile}`
              if (signal.tick !== tick) v.add(`${where}: signal tick ${signal.tick}`)
              if (signal.focusSpanId === null) {
                if (servers.length !== 0) v.add(`${where}: no focus but ${servers.length} server spans`)
                if (expected !== 0 || signal.spans.length !== 0) v.add(`${where}: empty trace must match p=0 and no spans`)
              } else {
                const focus = signal.spans.find((s) => s.spanId === signal.focusSpanId)
                if (focus === undefined) {
                  v.add(`${where}: focus span not in the returned trace`)
                  continue
                }
                if (focus.kind !== 'server' || focus.component !== name || focus.tick !== tick) v.add(`${where}: focus is not a server span of ${name} in the tick`)
                if (focus.durationMs !== expected) v.add(`${where}: focus ${focus.durationMs} ms != dashboard ${expected} ms`)
                if (toNdjson(signal.spans) !== toNdjson(view.traceOf(focus.traceId))) v.add(`${where}: spans are not the whole trace`)
              }
              // Once ask() (T1.16) is implemented, the public path must give the same signal.
              if (askImplemented) {
                comparedWithAsk += 1
                if (JSON.stringify(sim.ask(question).data) !== JSON.stringify(signal)) v.add(`${where}: ask() differs from the trace handler`)
              }
            }
          }
        }
      }
      expect(v.list, `${v.count} violation(s); ask() compared ${comparedWithAsk} times`).toEqual([])
    }, 60_000)
  }
})

describe('cross-check with scripts/verify-coherence.mjs (P-4 verifier)', () => {
  for (const config of CONFIGS) {
    it(config, () => {
      for (const seed of SEEDS.slice(0, VERIFIER_SEEDS)) {
        const r = spawnSync(process.execPath, [verifier], {
          input: toNdjson(run(seed, config)),
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
        })
        expect({ seed, status: r.status, stderr: r.stderr }).toEqual({ seed, status: 0, stderr: '' })
      }
    })
  }
})
