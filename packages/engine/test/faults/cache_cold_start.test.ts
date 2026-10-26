/**
 * T1.22 / T1.35 — fault `cache_cold_start` (ADR-004 and its Emenda 2; PRD F-1, F-2, F-3 row 7
 * with Emenda 1, F-4, S-4; SPEC §3.3, §3.4; DET).
 *
 * The module only restarts the cache (event + down on startTick) and forces misses while it warms
 * up. The extra load on the backing store, its connections and the latency of the cache users
 * emerge from the miss path of the traffic generator (onMiss calls, ADR-002 §5).
 *
 * Signature assertions follow the seed aggregation rule R1–R5 and the F-4 eligibility rules E1–E4
 * (PRD Emenda 2) through test/support/signature.ts, over the seeds of `signatureSeeds`
 * (replaceable with ENGINE_QA_SEEDS), never trace-by-trace equality against the baseline while the
 * fault is active (ADR-003 §8). Row 7 fixes its own ticks for the backing-store RPS (each of the 3
 * ticks after startTick; startTick + warmup); everything else uses the signature window
 * startTick+6..+11.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cacheColdStart } from '../../src/faults/cache_cold_start.js'
import { faultCatalog } from '../../src/faults/catalog.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { whatChanged } from '../../src/questions/whatChanged.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { toNdjson } from '../../src/sim/serialize.js'
import { createSimulation, simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import { assertEligibleF4, assertPass, ceiling, effect, everySeed, signatureSeeds, signatureWindow, windowMean } from '../support/signature.js'
import type { EventRecord, Fault, FaultInput, MetricName, TelemetryRecord } from '../../src/types.js'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')

/** R1: fixed list `cold-start-0..11`, replaced by ENGINE_QA_SEEDS when set. */
const SEEDS = signatureSeeds('cold-start')
const world = buildWorld(defaultShop, 'resolve')
const resolve = (input: Omit<FaultInput, 'kind'> = {}): Fault[] => resolveFaults([{ kind: 'cache_cold_start', ...input }], world)

const [DEFAULT] = resolve()
const START = DEFAULT!.startTick
const TARGET = DEFAULT!.target
const WARMUP = DEFAULT!.params['warmupTicks']!
const TICKS = START + WARMUP + 3
const WINDOW = signatureWindow(START)
/** Services that call the cache directly (default-shop: auth, catalog, cart). */
const CACHE_USERS = world.services.filter((s) => s.calls.some((c) => c.target === TARGET)).map((s) => s.name)
const BACKING = 'postgres'
/** The fixed cache user of the p50 condition of F-3 row 7 (the same in every seed, E4). */
const P50_USER = 'auth'
/**
 * Fixed F-4 pair (tasks T1.35, recommended). The RPS of postgres is not eligible for F-4: its
 * baseline mean (~0.55 req/s) is below the E2 floor of 1 req/s; it stays an F-3 condition.
 */
const F4_PAIR = { component: P50_USER, metric: 'p50' } as const

const run = (seed: string, faults: readonly Fault[] = []) => simulate({ system: defaultShop, seed, faults }, TICKS)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
/** Ticks [from, to], inclusive. */
const ticks = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** Mean of one aggregate metric of a component over ticks [from, to] (one run). */
const meanOver = (records: readonly TelemetryRecord[], component: string, metric: MetricName, from: number, to: number) =>
  windowMean(records, component, metric, ticks(from, to))

const runs = SEEDS.map((seed) => ({ seed, base: run(seed), fault: run(seed, [DEFAULT!]) }))
/** Per-seed means of one aggregate metric over [from, to], in seed order (R2/R3 input). */
const series = (component: string, metric: MetricName, from: number, to: number) => ({
  fault: runs.map((r) => meanOver(r.fault, component, metric, from, to)),
  base: runs.map((r) => meanOver(r.base, component, metric, from, to)),
})
/** Seed-mean ratio fault/baseline of one metric over [from, to] (R2 reading). */
const ratio = (component: string, metric: MetricName, from: number, to: number) => {
  const { fault, base } = series(component, metric, from, to)
  return mean(fault) / mean(base)
}

describe('cache_cold_start — defaults (ADR-004)', () => {
  it('restarts redis at tick 10 and warms up over 30 ticks', () => {
    expect(DEFAULT).toEqual({ kind: 'cache_cold_start', target: 'redis', startTick: 10, params: { warmupTicks: 30 } })
    expect(faultCatalog.cache_cold_start.defaultTarget).toBe('redis')
    expect(CACHE_USERS).toEqual(['auth', 'catalog', 'cart'])
    expect(CACHE_USERS).toContain(P50_USER)
  })

  it('R1: the seed list has >= 10 distinct seeds', () => {
    expect(new Set(SEEDS).size).toBe(SEEDS.length)
    expect(SEEDS.length).toBeGreaterThanOrEqual(10)
  })
})

describe('F-3 row 7 — cold cache after a restart (R1–R5)', () => {
  it('R4: in every seed, one config event with restart: true for the cache instance at startTick, and no other event (S-4)', () => {
    const expected: EventRecord[] = [{ type: 'event', tick: START, kind: 'config', target: TARGET, instance: `${TARGET}-0`, restart: true }]
    const result = everySeed(SEEDS, (_, i) => {
      const events = runs[i]!.fault.filter((r): r is EventRecord => r.type === 'event')
      return JSON.stringify(events) === JSON.stringify(expected) || `events ${JSON.stringify(events)}`
    })
    assertPass(result, 'restart event at startTick')
  })

  it.each([1, 2, 3])(`R2/R3: ${BACKING} RPS >= 2x baseline at startTick + %i on the mean and >= 1.75x in every seed`, (offset) => {
    const { fault, base } = series(BACKING, 'rps', START + offset, START + offset)
    assertPass(effect(fault, base, { ratioAtLeast: 2 }, SEEDS), `${BACKING} RPS at startTick + ${offset}`)
  })

  it(`R5: ${BACKING} RPS is back to <= 1.2x baseline at startTick + warmup (and stays there), on the mean`, () => {
    const at = series(BACKING, 'rps', START + WARMUP, START + WARMUP)
    assertPass(ceiling(at.fault, at.base, { ratioAtMost: 1.2 }, SEEDS), `${BACKING} RPS at startTick + warmup`)
    const after = series(BACKING, 'rps', START + WARMUP, TICKS - 1)
    assertPass(ceiling(after.fault, after.base, { ratioAtMost: 1.2 }, SEEDS), `${BACKING} RPS from startTick + warmup on`)
  })

  it('the backing-store RPS decays as the cache warms up (cold early, warm late)', () => {
    const early = ratio(BACKING, 'rps', START + 1, START + 3)
    const mid = ratio(BACKING, 'rps', START + 6, START + 11)
    const late = ratio(BACKING, 'rps', START + WARMUP - 6, START + WARMUP - 1)
    expect(early).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(late)
  })

  // PRD F-3 row 7, Emenda 1 (issue #39): p50 of >= 1 service that uses the cache rises >= 25% in
  // the signature window. Every request of a cache user pays the miss (one onMiss call), so the
  // median moves; p95 is dominated by the own-latency tail and is only pinned as "goes up".
  it(`R2/R3: p50 of ${P50_USER} (a cache user, fixed) rises >= 25% on the mean and >= 18.75% in every seed, in the signature window`, () => {
    const fault = runs.map((r) => windowMean(r.fault, P50_USER, 'p50', WINDOW))
    const base = runs.map((r) => windowMean(r.base, P50_USER, 'p50', WINDOW))
    assertPass(effect(fault, base, { riseAtLeast: 0.25 }, SEEDS), `p50 of ${P50_USER}`)
  })

  it('p95 of every cache user also goes up in the window (on the mean)', () => {
    for (const c of CACHE_USERS) expect(ratio(c, 'p95', START + 6, START + 11)).toBeGreaterThan(1)
  })
})

describe('F-4 — the fault shows outside the target (E1–E4, fixed pair)', () => {
  it(`(${F4_PAIR.component}, ${F4_PAIR.metric}) is an eligible indirect signal in every seed`, () => {
    const result = assertEligibleF4(
      F4_PAIR,
      runs.map((r) => r.base),
      runs.map((r) => r.fault),
      TARGET,
      { window: WINDOW, seeds: SEEDS },
    )
    expect(result.direction).toBe('rise')
    expect(result.result.pass).toBe(true)
  })

  it(`E2: the RPS of ${BACKING} is below the eligibility floor (1 req/s) on the baseline, so it is not the F-4 pair`, () => {
    expect(() =>
      assertEligibleF4({ component: BACKING, metric: 'rps' }, runs.map((r) => r.base), runs.map((r) => r.fault), TARGET, { window: WINDOW, seeds: SEEDS }),
    ).toThrow(/E2/)
  })
})

describe('the cache itself looks fine after the restart (SPEC §3.4)', () => {
  it('down on startTick only: zero RPS that tick, callers get connection refused; then it serves as usual', () => {
    for (const { base, fault } of runs.slice(0, 4)) {
      expect(meanOver(fault, TARGET, 'rps', START, START)).toBe(0)
      expect(fault.some((r) => r.type === 'log' && r.tick === START && r.message === 'connection refused' && r.attrs?.['peerInstance'] === `${TARGET}-0`)).toBe(true)
      expect(fault.some((r) => r.type === 'log' && r.tick > START && r.message === 'connection refused')).toBe(false)
      expect(windowMean(fault, TARGET, 'rps', WINDOW)).toBeGreaterThanOrEqual(windowMean(base, TARGET, 'rps', WINDOW) * 0.9)
      expect(windowMean(fault, TARGET, 'errorPct', WINDOW)).toBe(0)
    }
  })

  it('cache errors never reach the users: no server error on the cache users or the gateway', () => {
    for (const { fault } of runs.slice(0, 4)) {
      const errors = fault.filter((r) => r.type === 'span' && r.kind === 'server' && r.status === 'error')
      expect(errors).toEqual([])
    }
  })
})

describe('F-2 — invisible before startTick', () => {
  it.each(SEEDS.slice(0, 4))('records with tick < startTick are byte-identical to the baseline (seed %s)', (seed) => {
    const { base, fault } = runs.find((r) => r.seed === seed)!
    const before = (records: readonly TelemetryRecord[]) => toNdjson(records.filter((r) => r.tick < START))
    expect(before(fault)).toBe(before(base))
    expect(toNdjson(fault)).not.toBe(toNdjson(base))
  })
})

describe('parameters', () => {
  it('warmupTicks = 1: only the restart tick is cold; afterwards the backing store is back to baseline', () => {
    const faults = resolve({ params: { warmupTicks: 1 } })
    const fault = SEEDS.slice(0, 6).map((s) => meanOver(run(s, faults), BACKING, 'rps', START + 1, START + 11))
    const base = SEEDS.slice(0, 6).map((s) => meanOver(run(s), BACKING, 'rps', START + 1, START + 11))
    expect(mean(fault) / mean(base)).toBeLessThanOrEqual(1.2)
    const atStart = SEEDS.slice(0, 6).map((s) => meanOver(run(s, faults), BACKING, 'rps', START, START))
    expect(mean(atStart)).toBeGreaterThanOrEqual(2 * mean(SEEDS.slice(0, 6).map((s) => meanOver(run(s), BACKING, 'rps', START, START))))
  })

  it('whatChanged sees the restart', () => {
    const sim = createSimulation({ system: defaultShop, seed: 'wc', faults: [DEFAULT!] })
    sim.advance(START + 3)
    const view = sim.telemetry()
    const signal = whatChanged({ kind: 'whatChanged', window: 5 }, { view, lastWeek: () => view })
    expect(signal.events).toEqual([{ type: 'event', tick: START, kind: 'config', target: TARGET, instance: `${TARGET}-0`, restart: true }])
  })
})

describe('module', () => {
  it('activate rejects a target that is not a dependency (internal invariant)', () => {
    const fault: Fault = { kind: 'cache_cold_start', target: 'auth', startTick: 0, params: { warmupTicks: 2 } }
    expect(() => cacheColdStart.activate(fault, world, createRngFactory('x'))).toThrow(/not a dependency/)
  })

  it('onTick acts only on startTick; onCall ignores other targets and the warm phase', () => {
    const fault: Fault = { kind: 'cache_cold_start', target: 'redis', startTick: 5, params: { warmupTicks: 4 } }
    const hooks = cacheColdStart.activate(fault, world, createRngFactory('unit'))
    expect(hooks.onTick!({ tick: 6, world })).toBeUndefined()
    expect(hooks.onTick!({ tick: 5, world })).toEqual({
      down: ['redis-0'],
      events: [{ kind: 'config', target: 'redis', instance: 'redis-0', restart: true }],
    })
    const ctx = { caller: 'auth', callerInstance: 'auth-0', operation: 'session.get', attempt: 0, traceId: 't' }
    expect(hooks.onCall!({ ...ctx, tick: 5, target: 'postgres' })).toBeUndefined()
    expect(hooks.onCall!({ ...ctx, tick: 5, target: 'redis' })).toEqual({ forceCacheMiss: true })
    expect(hooks.onCall!({ ...ctx, tick: 9, target: 'redis' })).toBeUndefined()
  })

  it('the forced-miss ratio decreases linearly with s (1 − s / warmupTicks)', () => {
    const fault: Fault = { kind: 'cache_cold_start', target: 'redis', startTick: 0, params: { warmupTicks: 4 } }
    const hooks = cacheColdStart.activate(fault, world, createRngFactory('ratio'))
    const missRate = (tick: number) => {
      let misses = 0
      const n = 2000
      for (let i = 0; i < n; i++) {
        const e = hooks.onCall!({ tick, caller: 'auth', callerInstance: 'auth-0', target: 'redis', operation: 'op', attempt: 0, traceId: `t${tick}r${i}` })
        if (e?.forceCacheMiss === true) misses++
      }
      return misses / n
    }
    expect(missRate(0)).toBe(1)
    expect(missRate(1)).toBeCloseTo(0.75, 1)
    expect(missRate(2)).toBeCloseTo(0.5, 1)
    expect(missRate(3)).toBeCloseTo(0.25, 1)
    expect(missRate(4)).toBe(0)
  })
})

describe('coherence and determinism with the fault active', () => {
  it('verify-coherence.mjs accepts the NDJSON (P-1/P-2/P-3/S-3)', () => {
    for (const seed of ['coh-0', 'coh-1']) {
      const r = spawnSync(process.execPath, [verifier], {
        input: toNdjson(simulate({ system: defaultShop, seed, faults: [DEFAULT!] }, 60)),
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      })
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    }
  })

  it('DET: two runs with the same seed give the same NDJSON hash; different seeds differ', () => {
    const a = sha(toNdjson(run('det', [DEFAULT!])))
    expect(sha(toNdjson(run('det', [DEFAULT!])))).toBe(a)
    expect(sha(toNdjson(run('det-2', [DEFAULT!])))).not.toBe(a)
  })
})
