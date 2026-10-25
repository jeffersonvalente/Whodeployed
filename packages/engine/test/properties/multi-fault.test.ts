/**
 * T1.25 — two simultaneous faults (PRD F-6, D-1, DET; SPEC §7 `faults:` is a list, campaign row 8).
 *
 * `connection_pool_exhaustion` on `payment` + `service_crash_loop` on `catalog`, both with their
 * catalog defaults (ADR-004), in one run. Both F-3 signatures (rows 3 and 1) must show, measured
 * in each fault's signature window (startTick+6 .. startTick+11) against the no-fault baseline,
 * with the seed aggregation of PRD Emenda 2:
 *
 * - R1: a fixed list of 12 seeds, declared below and not chosen to pass.
 * - R2: the table threshold holds on the mean over the seeds of the window means.
 * - R3: effect-size conditions hold per seed at >= 75% of the required size.
 * - R4: existence conditions hold in every seed (pool reaches poolSize, an error log of the
 *   crashing target in every window tick, a db.acquire wait >= 50% of the root in the p95 trace).
 * - R5: ceilings hold on the mean only (gateway p50 <= 1.5x).
 *
 * Comparisons are always window means, never trace or instance equality against the baseline
 * while a fault is active (ADR-003 §8). Defaults are read from the catalog, so a change of
 * default (ADR-004) is picked up here without editing this file.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { faultCatalog } from '../../src/faults/catalog.js'
import { ACQUIRE_OPERATION } from '../../src/faults/connection_pool_exhaustion.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { trace } from '../../src/questions/trace.js'
import { serializeRecord, toNdjson } from '../../src/sim/serialize.js'
import { createSimulation, simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type { Fault, FaultInput, LogRecord, MetricName, MetricRecord, SpanRecord, TelemetryRecord } from '../../src/types.js'

const POOL = 'connection_pool_exhaustion'
const CRASH = 'service_crash_loop'
const POOL_TARGET = 'payment'
const CRASH_TARGET = 'catalog'
const INPUTS: readonly FaultInput[] = [
  { kind: POOL, target: POOL_TARGET },
  { kind: CRASH, target: CRASH_TARGET },
]

const POOL_START = faultCatalog[POOL].defaultStartTick
const CRASH_START = faultCatalog[CRASH].defaultStartTick
const POOL_SIZE = faultCatalog[POOL].params['poolSize']!.default
const windowOf = (start: number) => Array.from({ length: 6 }, (_, i) => start + 6 + i)
const POOL_WINDOW = windowOf(POOL_START)
const CRASH_WINDOW = windowOf(CRASH_START)
const TICKS = Math.max(POOL_START, CRASH_START) + 12

/** R1: fixed seed list (>= 10). */
const SEEDS = Array.from({ length: 12 }, (_, i) => `multi-${i}`)

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const mainTs = join(pkgDir, 'src', 'cli', 'main.ts')
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

const faultsOf = (seed: string): Fault[] => resolveFaults(INPUTS, buildWorld(defaultShop, seed))
const run = (seed: string, ticks = TICKS) => simulate({ system: defaultShop, seed, faults: faultsOf(seed) }, ticks)
const baseline = (seed: string, ticks = TICKS) => simulate({ system: defaultShop, seed }, ticks)

const metricOf = (records: readonly TelemetryRecord[], component: string, tick: number, instance?: string): MetricRecord => {
  const m = records.find((r): r is MetricRecord => r.type === 'metric' && r.component === component && r.instance === instance && r.tick === tick)
  if (m === undefined) throw new Error(`no metric for ${component}/${instance ?? '*'} at ${tick}`)
  return m
}

/** Window mean of an aggregate metric in one run. */
const windowMean = (records: readonly TelemetryRecord[], window: readonly number[], component: string, metric: MetricName) =>
  mean(window.map((tick) => metricOf(records, component, tick)[metric]))

const FAULTED = SEEDS.map((seed) => run(seed))
const BASE = SEEDS.map((seed) => baseline(seed))

/** Per-seed window means (faulted and baseline) and their R2 means over the seeds. */
function measure(window: readonly number[], component: string, metric: MetricName) {
  const perSeed = SEEDS.map((seed, i) => ({
    seed,
    fault: windowMean(FAULTED[i]!, window, component, metric),
    base: windowMean(BASE[i]!, window, component, metric),
  }))
  return { perSeed, fault: mean(perSeed.map((s) => s.fault)), base: mean(perSeed.map((s) => s.base)) }
}

describe('F-6 — the engine accepts both faults, with their catalog defaults', () => {
  it('resolves two faults of different kinds on different targets, in input order', () => {
    const faults = faultsOf('resolve')
    expect(faults.map((f) => [f.kind, f.target])).toEqual([
      [POOL, POOL_TARGET],
      [CRASH, CRASH_TARGET],
    ])
    for (const f of faults) expect(f.startTick).toBe(faultCatalog[f.kind].defaultStartTick)
  })
})

describe(`F-6 — F-3 row 3 (${POOL} on ${POOL_TARGET}) shows with the other fault active, ${SEEDS.length} seeds`, () => {
  it('R4: the connections metric of the target reaches poolSize in >= 1 window tick, in every seed', () => {
    const instances = buildWorld(defaultShop, 'x').services.find((s) => s.name === POOL_TARGET)!.instances
    SEEDS.forEach((seed, i) => {
      const reached = POOL_WINDOW.some((tick) => instances.some((inst) => metricOf(FAULTED[i]!, POOL_TARGET, tick, inst).connections === POOL_SIZE))
      expect(reached, seed).toBe(true)
    })
  })

  it('target p95: R2 >= 3x the baseline; R3 >= 2.5x in every seed', () => {
    const p95 = measure(POOL_WINDOW, POOL_TARGET, 'p95')
    expect(p95.fault).toBeGreaterThanOrEqual(3 * p95.base)
    for (const s of p95.perSeed) expect(s.fault, s.seed).toBeGreaterThanOrEqual(2.5 * s.base)
  })

  it('R4: in every seed, the p95 trace of the target once the pool is exhausted has a db.acquire wait >= 50% of the root', () => {
    for (const seed of SEEDS) {
      const sim = createSimulation({ system: defaultShop, seed, faults: faultsOf(seed) })
      sim.advance(POOL_WINDOW[0]! - 1)
      let checked = 0
      for (const tick of POOL_WINDOW) {
        sim.advance(1)
        // Exhausted = every target instance reports connections at poolSize (read from telemetry).
        const instances = sim.telemetry().metricsOf(POOL_TARGET, tick, tick).filter((m) => m.instance !== undefined)
        if (!instances.every((m) => m.connections === POOL_SIZE)) continue
        const signal = trace({ kind: 'trace', service: POOL_TARGET, percentile: 95 }, { view: sim.telemetry(), lastWeek: () => sim.telemetry() })
        if (signal.focusSpanId === null) continue
        const focus = signal.spans.find((s) => s.spanId === signal.focusSpanId) as SpanRecord
        const root = signal.spans.find((s) => s.parentId === undefined) as SpanRecord
        const waits = signal.spans.filter((s) => s.parentId === focus.spanId && s.operation === ACQUIRE_OPERATION && s.kind === 'internal')
        const longest = Math.max(0, ...waits.map((s) => s.durationMs))
        expect(longest, `${seed} tick ${tick}`).toBeGreaterThanOrEqual(0.5 * focus.durationMs)
        expect(longest, `${seed} tick ${tick}`).toBeGreaterThanOrEqual(0.5 * root.durationMs)
        checked += 1
      }
      expect(checked, seed).toBeGreaterThanOrEqual(1)
    }
  })

  it('indirect, gateway p95: R2 >= +25%; R3 >= +18.75% in every seed', () => {
    const p95 = measure(POOL_WINDOW, 'gateway', 'p95')
    expect(p95.fault).toBeGreaterThanOrEqual(1.25 * p95.base)
    for (const s of p95.perSeed) expect(s.fault, s.seed).toBeGreaterThanOrEqual(1.1875 * s.base)
  })

  it('indirect, gateway p50: R5 <= 1.5x the baseline on the mean (the aggregate hides the bottleneck)', () => {
    const p50 = measure(POOL_WINDOW, 'gateway', 'p50')
    expect(p50.fault).toBeLessThanOrEqual(1.5 * p50.base)
  })
})

describe(`F-6 — F-3 row 1 (${CRASH} on ${CRASH_TARGET}) shows with the other fault active, ${SEEDS.length} seeds`, () => {
  it('target: served RPS R2 <= 50% (R3 <= 62.5% per seed), or error % R2 >= +20 p.p. (R3 >= +15 p.p.)', () => {
    const rps = measure(CRASH_WINDOW, CRASH_TARGET, 'rps')
    const err = measure(CRASH_WINDOW, CRASH_TARGET, 'errorPct')
    expect(rps.fault <= 0.5 * rps.base || err.fault >= err.base + 20).toBe(true)
    SEEDS.forEach((seed, i) => {
      const r = rps.perSeed[i]!
      const e = err.perSeed[i]!
      expect(r.fault <= 0.625 * r.base || e.fault >= e.base + 15, seed).toBe(true)
    })
  })

  it('R4: >= 1 error log of the target in every tick of the window, in every seed', () => {
    SEEDS.forEach((seed, i) => {
      for (const tick of CRASH_WINDOW) {
        const found = FAULTED[i]!.some((r): r is LogRecord => r.type === 'log' && r.component === CRASH_TARGET && r.tick === tick && r.level === 'error')
        expect(found, `${seed} tick ${tick}`).toBe(true)
      }
    })
  })

  it('indirect, error % of the direct caller (gateway): R2 >= +5 p.p.; R3 >= +3.75 p.p. in every seed', () => {
    const err = measure(CRASH_WINDOW, 'gateway', 'errorPct')
    expect(err.fault).toBeGreaterThanOrEqual(err.base + 5)
    for (const s of err.perSeed) expect(s.fault, s.seed).toBeGreaterThanOrEqual(s.base + 3.75)
  })
})

describe('F-6 — the combined run stays coherent and invisible before startTick', () => {
  it('F-2: records with tick < min(startTick) are byte-identical to the baseline', () => {
    const first = Math.min(POOL_START, CRASH_START)
    const before = (records: readonly TelemetryRecord[]) => records.filter((r) => r.tick < first).map(serializeRecord).join('\n')
    SEEDS.slice(0, 3).forEach((seed, i) => expect(before(FAULTED[i]!), seed).toBe(before(BASE[i]!)))
  })

  it.each(['qa', 'multi-coh'])('verify-coherence.mjs accepts the NDJSON (seed %s, 60 ticks)', (seed) => {
    const r = spawnSync(process.execPath, [verifier], { input: toNdjson(run(seed, 60)), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})

describe('DET / D-1 — the two-fault run is byte-identical between runs', () => {
  it('two in-process runs give the same NDJSON hash; another seed differs', () => {
    const a = sha(toNdjson(run('det', 60)))
    expect(sha(toNdjson(run('det', 60)))).toBe(a)
    expect(sha(toNdjson(run('det-2', 60)))).not.toBe(a)
  })

  it(
    'the CLI with two --fault flags, in two separate processes, gives the same SHA-256 as the library',
    () => {
      const args = ['simulate', '--seed', 'gate1', '--ticks', '60', '--fault', `${POOL}:target=${POOL_TARGET}`, '--fault', `${CRASH}:target=${CRASH_TARGET}`]
      const cli = () => {
        const r = spawnSync(process.execPath, ['--import', 'tsx', mainTs, ...args], { cwd: pkgDir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
        expect(r.stderr).toBe('')
        expect(r.status).toBe(0)
        return sha(r.stdout)
      }
      const first = cli()
      expect(cli()).toBe(first)
      expect(first).toBe(sha(toNdjson(run('gate1', 60))))
    },
    120_000,
  )
})
