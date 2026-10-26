/**
 * T1.25 — two simultaneous faults (PRD F-6, D-1, DET; SPEC §7 `faults:` is a list, campaign row 8).
 *
 * `connection_pool_exhaustion` on `payment` + `service_crash_loop` on `catalog`, both with their
 * catalog defaults (ADR-004 and its Emendas), in one run. Both F-3 signatures (rows 3 and 1) must
 * show, measured in each fault's signature window (startTick+6 .. startTick+11) against the
 * no-fault baseline, read with the seed aggregation rule of PRD Emenda 2 through the T1.33 helper
 * (test/support/signature.ts): window means over the seeds of `signatureSeeds('multi')`
 * (replaceable with ENGINE_QA_SEEDS, R1), threshold on the mean (R2), 75% floor in every seed
 * (R3), existence in every seed (R4), ceilings on the mean only (R5). Comparisons are always
 * window means, never trace or instance equality against the baseline while a fault is active
 * (ADR-003 §8).
 *
 * R6 (PRD Emenda 3; ADR-004 Emenda 3): applies only to row 3 (the pool), and only to its three
 * conditions: p95 of the target, p95 of the gateway and the F-4 pair (gateway, p95). Every
 * exemption is built by `r6Exemption` with the real kind (`connection_pool_exhaustion`), the real
 * target (`payment`), the pool window and the faulted runs of this case. Row 1 (the crash loop)
 * takes no exemption. Connections at poolSize (R4) hold in every seed; the trace clause is per
 * window tick with >= 1 request of the target. The share of seeds in which `payment` serves no
 * request in the window is capped at 2% over 1000 consecutive seeds of this case.
 *
 * Defaults are read from the catalog, so a change of default (ADR-004) is picked up here without
 * editing this file.
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
import {
  R6_MIN_SEEDS,
  assertEligibleF4,
  assertPass,
  ceiling,
  effect,
  everySeed,
  exercised,
  r6Exemption,
  signatureSeeds,
  signatureWindow,
  unexercisedShare,
  windowMean,
  type R6Condition,
} from '../support/signature.js'
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
const POOL_WINDOW = signatureWindow(POOL_START)
const CRASH_WINDOW = signatureWindow(CRASH_START)
const TICKS = Math.max(POOL_START, CRASH_START) + 12

/** R1: fixed seed list (`multi-0..11`), or ENGINE_QA_SEEDS. */
const SEEDS = signatureSeeds('multi')

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const mainTs = join(pkgDir, 'src', 'cli', 'main.ts')
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const faultsOf = (seed: string): Fault[] => resolveFaults(INPUTS, buildWorld(defaultShop, seed))
const run = (seed: string, ticks = TICKS) => simulate({ system: defaultShop, seed, faults: faultsOf(seed) }, ticks)
const baseline = (seed: string, ticks = TICKS) => simulate({ system: defaultShop, seed }, ticks)

const metricOf = (records: readonly TelemetryRecord[], component: string, tick: number, instance?: string): MetricRecord => {
  const m = records.find((r): r is MetricRecord => r.type === 'metric' && r.component === component && r.instance === instance && r.tick === tick)
  if (m === undefined) throw new Error(`no metric for ${component}/${instance ?? '*'} at ${tick}`)
  return m
}

const FAULTED = SEEDS.map((seed) => run(seed))
const BASE = SEEDS.map((seed) => baseline(seed))

/** Per-seed window means of an aggregate metric, in seed order. */
const series = (runs: readonly (readonly TelemetryRecord[])[], window: readonly number[], component: string, metric: MetricName) =>
  runs.map((records) => windowMean(records, component, metric, window))

/**
 * R6 exemption of one row-3 condition, for this case: the real kind and target of the pool fault,
 * the pool window, and the faulted runs of this very case (never another kind or another run).
 */
const poolR6 = (condition: R6Condition) => r6Exemption(POOL, condition, FAULTED, POOL_TARGET, POOL_WINDOW)

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

describe(`F-6 — F-3 row 3 (${POOL} on ${POOL_TARGET}) shows with the other fault active, ${SEEDS.length} seeds (R1–R5, R6)`, () => {
  it('R4: the connections metric of the target reaches poolSize in >= 1 window tick, in every seed (no exemption)', () => {
    const instances = buildWorld(defaultShop, 'x').services.find((s) => s.name === POOL_TARGET)!.instances
    assertPass(
      everySeed(SEEDS, (_seed, i) => {
        const reached = POOL_WINDOW.some((tick) => instances.some((inst) => metricOf(FAULTED[i]!, POOL_TARGET, tick, inst).connections === POOL_SIZE))
        return reached || 'connections never reach poolSize in the window'
      }),
      'connections at poolSize',
    )
  })

  it('R3: p95 of the target >= 3x the baseline on the mean, >= 2.5x in every exercised seed (R6)', () => {
    assertPass(
      effect(series(FAULTED, POOL_WINDOW, POOL_TARGET, 'p95'), series(BASE, POOL_WINDOW, POOL_TARGET, 'p95'), { ratioAtLeast: 3 }, SEEDS, poolR6('targetP95')),
      'target p95',
    )
  })

  it('R4: in each window tick in which the target serves >= 1 request, a db.acquire span of its p95 trace is >= 50% of the root, in every seed', () => {
    assertPass(
      everySeed(SEEDS, (seed, i) => {
        const sim = createSimulation({ system: defaultShop, seed, faults: faultsOf(seed) })
        sim.advance(POOL_WINDOW[0]! - 1)
        let checked = 0
        for (const tick of POOL_WINDOW) {
          sim.advance(1)
          const aggregate = sim.telemetry().metricsOf(POOL_TARGET, tick, tick).find((m) => m.instance === undefined)!
          if (aggregate.rps === 0) continue
          const signal = trace({ kind: 'trace', service: POOL_TARGET, percentile: 95 }, { view: sim.telemetry(), lastWeek: () => sim.telemetry() })
          if (signal.focusSpanId === null) return `tick ${tick}: target has requests but no p95 trace`
          const focus = signal.spans.find((s) => s.spanId === signal.focusSpanId) as SpanRecord
          const root = signal.spans.find((s) => s.parentId === undefined) as SpanRecord
          const waits = signal.spans.filter((s) => s.parentId === focus.spanId && s.operation === ACQUIRE_OPERATION && s.kind === 'internal')
          const longest = Math.max(0, ...waits.map((s) => s.durationMs))
          // "Root" read both ways: the target's own server span and the root of the whole trace.
          if (longest < 0.5 * focus.durationMs) return `tick ${tick}: db.acquire ${longest} ms < 50% of the target span ${focus.durationMs} ms`
          if (longest < 0.5 * root.durationMs) return `tick ${tick}: db.acquire ${longest} ms < 50% of the root ${root.durationMs} ms`
          checked += 1
        }
        // The aggregate rps and the server spans agree: an exercised seed has >= 1 tick checked.
        const ex = exercised(FAULTED[i]!, POOL_TARGET, POOL_WINDOW)
        if (ex !== checked > 0) return `exercised ${ex} but ${checked} ticks with requests`
        return true
      }),
      'db.acquire share of the p95 trace',
    )
  })

  it('R3: gateway p95 rises >= 25% on the mean, >= 18.75% in every exercised seed (R6)', () => {
    assertPass(
      effect(series(FAULTED, POOL_WINDOW, 'gateway', 'p95'), series(BASE, POOL_WINDOW, 'gateway', 'p95'), { riseAtLeast: 0.25 }, SEEDS, poolR6('gatewayP95')),
      'gateway p95',
    )
  })

  it('R5: gateway p50 stays <= 1.5x the baseline on the mean (the aggregate hides the bottleneck)', () => {
    assertPass(ceiling(series(FAULTED, POOL_WINDOW, 'gateway', 'p50'), series(BASE, POOL_WINDOW, 'gateway', 'p50'), { ratioAtMost: 1.5 }, SEEDS), 'gateway p50')
  })

  it('F-4: fixed eligible pair of row 3 (gateway, p95), in every exercised seed (E1–E4, R6)', () => {
    const r = assertEligibleF4({ component: 'gateway', metric: 'p95' }, BASE, FAULTED, POOL_TARGET, { window: POOL_WINDOW, seeds: SEEDS, exempt: poolR6('f4Pair') })
    expect(r.direction).toBe('rise')
  })
})

describe(`F-6 — F-3 row 1 (${CRASH} on ${CRASH_TARGET}) shows with the other fault active, ${SEEDS.length} seeds (R1–R5, no R6)`, () => {
  // Row 1 offers "error % >= baseline + 20 p.p. OR served RPS <= 50% of the baseline". As in the
  // T1.34 suite, the branch is declared and read the same way in every seed: the crashing target
  // never reports a request error itself (callers see `connection refused`), so it is RPS.
  it('target: served RPS <= 0.5x on the mean, <= 0.625x in every seed (R2, R3)', () => {
    assertPass(
      effect(series(FAULTED, CRASH_WINDOW, CRASH_TARGET, 'rps'), series(BASE, CRASH_WINDOW, CRASH_TARGET, 'rps'), { ratioAtMost: 0.5 }, SEEDS),
      `${CRASH_TARGET} rps`,
    )
  })

  it('R4: >= 1 error log of the target in every tick of the window, in every seed', () => {
    assertPass(
      everySeed(SEEDS, (_seed, i) => {
        const missing = CRASH_WINDOW.filter(
          (tick) => !FAULTED[i]!.some((r): r is LogRecord => r.type === 'log' && r.component === CRASH_TARGET && r.tick === tick && r.level === 'error'),
        )
        return missing.length === 0 || `no error log of ${CRASH_TARGET} at ticks ${missing.join(', ')}`
      }),
      `${CRASH_TARGET} error logs`,
    )
  })

  it('indirect and F-4: fixed pair (gateway, errorPct) >= +5 p.p. on the mean, >= +3.75 p.p. in every seed (E1–E4)', () => {
    const r = assertEligibleF4({ component: 'gateway', metric: 'errorPct' }, BASE, FAULTED, CRASH_TARGET, { window: CRASH_WINDOW, seeds: SEEDS })
    expect(r.direction).toBe('rise')
    expect(r.result.exemptSeeds).toEqual([])
  })
})

/** R6 ceiling for this case: 1000 consecutive seeds; only faulted runs are needed. */
const R6_SEEDS = Array.from({ length: R6_MIN_SEEDS }, (_, i) => `multi-r6-${i}`)
const R6_TIMEOUT_MS = 300_000

describe('R6 — share of seeds in which payment serves no request in the window <= 2% (1000 consecutive seeds, this F-6 case, PRD Emenda 3)', () => {
  it(
    `${POOL} on ${POOL_TARGET} + ${CRASH} on ${CRASH_TARGET}`,
    () => {
      const flags = R6_SEEDS.map((seed) => exercised(run(seed), POOL_TARGET, POOL_WINDOW))
      const r = unexercisedShare(R6_SEEDS, flags)
      assertPass(r, 'R6 unexercised share')
      expect(r.seeds).toBe(1000)
    },
    R6_TIMEOUT_MS,
  )
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
