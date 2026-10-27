/**
 * T2.6 — impact function (ADR-013 §1–3; PRD FASE-2 EN-6 (a), EN-6 (c), EN-8, DET).
 *
 * Part 1, hand-built views: the rule of ADR-013 §1 term by term (loss at the edge, error root,
 * slow root, non-root and client spans ignored, threshold boundary, several entry services, world
 * without ingress) and the 'invalid_ticks' guard for ticks outside [0, now].
 *
 * Part 2, calibration on the real simulation with the seed lists of test/support/signature.ts
 * (`signatureSeeds('imp')`, ENGINE_QA_SEEDS replaces it):
 * - EN-6 (a): baseline, 360 ticks per seed, impacted in <= 1% of the ticks of each seed.
 * - EN-6 (c): baseline + 4 noise events (deploy/config on 4 different components) gives the same
 *   impact series as the baseline, tick by tick.
 * - Sanity per kind (ADR-013 §3 item 3): catalog defaults, >= 1 impacted tick in
 *   startTick..startTick+49 in every seed, for every kind except cache_cold_start (0, documented
 *   in ADR-013 "Consequências"). The fault is never on the entry service only: disk_full and
 *   slow_dependency hit postgres, and the impact still shows at the ingress (SPEC §3.4).
 * The measured numbers are printed and recorded in ADR-013 "Emenda 1 — calibração".
 *
 * DET: the same view gives the same series, and two simulations with the same seed give the same
 * series.
 */
import { describe, expect, it } from 'vitest'
import { isEngineError } from '../../src/errors.js'
import { faultKinds } from '../../src/faults/catalog.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { SLOW_MS, THETA, accumulatedImpact, impactOfTick } from '../../src/sim/impact.js'
import { createSimulation } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type {
  FaultKind,
  ImpactTick,
  NoiseEvent,
  Service,
  SpanRecord,
  SpanStatus,
  TelemetryView,
  World,
} from '../../src/types.js'
import { signatureSeeds } from '../support/signature.js'

// ---------------------------------------------------------------------------
// Part 1 — hand-built views
// ---------------------------------------------------------------------------

function service(name: string, ratePerTick?: number): Service {
  return {
    name,
    replicas: 1,
    instances: [`${name}-0`],
    latencyP50Ms: 5,
    latencyP99Ms: 20,
    cpuBasePct: 1,
    cpuPerRequestPct: 0.1,
    memBaseMb: 100,
    ...(ratePerTick === undefined ? {} : { ingress: { ratePerTick, operation: 'http.request' } }),
    calls: [],
    dbPoolSize: 10,
  }
}

interface SpanSpec {
  status?: SpanStatus
  durationMs?: number
  /** Non-root span (has a parent). */
  child?: boolean
  kind?: SpanRecord['kind']
}

let spanSeq = 0
function span(tick: number, component: string, spec: SpanSpec = {}): SpanRecord {
  spanSeq += 1
  return {
    type: 'span',
    tick,
    traceId: `t${spanSeq}`,
    spanId: `s${spanSeq}`,
    ...(spec.child === true ? { parentId: 'p' } : {}),
    component,
    instance: `${component}-0`,
    operation: 'op',
    kind: spec.kind ?? 'server',
    startMs: 0,
    durationMs: spec.durationMs ?? 50,
    status: spec.status ?? 'ok',
  }
}

/** A view with only what impact reads: world and spansOf. `spans[tick]` = spans of that tick. */
function view(services: Service[], spans: SpanRecord[][]): TelemetryView {
  const now = Math.max(0, spans.length - 1)
  const world: World = { services, deps: [], tick: now, seed: 'hand' }
  const unused = () => {
    throw new Error('impact must read only world and spansOf')
  }
  return {
    world,
    now,
    spansOf: (component, tick) => (spans[tick] ?? []).filter((s) => s.component === component),
    metricsOf: unused,
    logsOf: unused,
    traceOf: unused,
    eventsIn: unused,
    all: unused,
  }
}

const ok = (n: number, tick: number, component = 'gw') => Array.from({ length: n }, () => span(tick, component))

describe('ADR-013 §1 — impactOfTick on hand-built views', () => {
  it('a full tick of healthy roots is not impacted', () => {
    const v = view([service('gw', 20)], [ok(20, 0)])
    expect(impactOfTick(v, 0)).toStrictEqual({ tick: 0, expected: 20, bad: 0, impacted: false })
  })

  it('loss at the edge: missing roots count as bad', () => {
    const v = view([service('gw', 20)], [ok(18, 0)])
    expect(impactOfTick(v, 0)).toStrictEqual({ tick: 0, expected: 20, bad: 2, impacted: true })
  })

  it('a tick with no roots at all (crashed entry service) loses every request', () => {
    const v = view([service('gw', 20)], [[]])
    expect(impactOfTick(v, 0)).toStrictEqual({ tick: 0, expected: 20, bad: 20, impacted: true })
  })

  it('error root counts as bad', () => {
    const v = view([service('gw', 20)], [[...ok(19, 0), span(0, 'gw', { status: 'error' })]])
    expect(impactOfTick(v, 0)).toMatchObject({ bad: 1, impacted: true })
  })

  it(`slow root: durationMs > ${SLOW_MS} is bad, exactly ${SLOW_MS} is not`, () => {
    const slow = view([service('gw', 20)], [[...ok(19, 0), span(0, 'gw', { durationMs: SLOW_MS + 1 })]])
    expect(impactOfTick(slow, 0)).toMatchObject({ bad: 1, impacted: true })
    const edge = view([service('gw', 20)], [[...ok(19, 0), span(0, 'gw', { durationMs: SLOW_MS })]])
    expect(impactOfTick(edge, 0)).toMatchObject({ bad: 0, impacted: false })
  })

  it('a root that is both slow and failed counts once', () => {
    const v = view([service('gw', 20)], [[...ok(19, 0), span(0, 'gw', { status: 'error', durationMs: SLOW_MS * 5 })]])
    expect(impactOfTick(v, 0).bad).toBe(1)
  })

  it('non-root spans and non-server spans are not roots (they neither count nor fill a lost slot)', () => {
    const extra = [
      span(0, 'gw', { child: true, status: 'error', durationMs: SLOW_MS * 2 }),
      span(0, 'gw', { kind: 'client', status: 'error' }),
    ]
    const v = view([service('gw', 20)], [[...ok(20, 0), ...extra]])
    expect(impactOfTick(v, 0)).toMatchObject({ expected: 20, bad: 0, impacted: false })
    const short = view([service('gw', 20)], [[...ok(19, 0), ...extra, ...extra]])
    expect(impactOfTick(short, 0).bad).toBe(1)
  })

  it(`threshold: bad / expected >= THETA (${THETA}) is impacted, below is not`, () => {
    // 100 expected: 5 bad = 5% (impacted), 4 bad = 4% (not).
    const at = view([service('gw', 100)], [ok(95, 0)])
    expect(impactOfTick(at, 0)).toMatchObject({ expected: 100, bad: 5, impacted: true })
    const below = view([service('gw', 100)], [ok(96, 0)])
    expect(impactOfTick(below, 0)).toMatchObject({ expected: 100, bad: 4, impacted: false })
  })

  it('sums every entry service and ignores services without ingress', () => {
    const services = [service('gw', 12), service('worker', 2), service('inner')]
    const spans = [[...ok(12, 0, 'gw'), ...ok(1, 0, 'worker'), span(0, 'inner', { status: 'error' })]]
    // 1 of 14 lost at the worker = 7.1% >= 5%; the failed root of 'inner' (no ingress) is ignored.
    expect(impactOfTick(view(services, spans), 0)).toStrictEqual({ tick: 0, expected: 14, bad: 1, impacted: true })
  })

  it('more roots than the rate never makes bad negative', () => {
    const v = view([service('gw', 2)], [ok(5, 0)])
    expect(impactOfTick(v, 0)).toStrictEqual({ tick: 0, expected: 2, bad: 0, impacted: false })
  })

  it('world without ingress: expected 0, never impacted', () => {
    const v = view([service('a'), service('b')], [[span(0, 'a', { status: 'error' })], []])
    expect(impactOfTick(v, 0)).toStrictEqual({ tick: 0, expected: 0, bad: 0, impacted: false })
    expect(accumulatedImpact(v, 1)).toBe(0)
  })

  it('ingress with ratePerTick 0 and no other entry: expected 0, not impacted', () => {
    const v = view([service('gw', 0)], [[]])
    expect(impactOfTick(v, 0)).toStrictEqual({ tick: 0, expected: 0, bad: 0, impacted: false })
  })
})

describe('ADR-013 §1 — accumulatedImpact', () => {
  // ticks: 0 ok, 1 lost, 2 ok, 3 error, 4 ok
  const v = view(
    [service('gw', 10)],
    [ok(10, 0), ok(9, 1), ok(10, 2), [...ok(9, 3), span(3, 'gw', { status: 'error' })], ok(10, 4)],
  )

  it('counts impacted ticks in [0, upTo], inclusive', () => {
    expect([0, 1, 2, 3, 4].map((u) => accumulatedImpact(v, u))).toStrictEqual([0, 1, 1, 2, 2])
  })

  it('equals the sum of impactOfTick(...).impacted', () => {
    const sum = [0, 1, 2, 3, 4].filter((t) => impactOfTick(v, t).impacted).length
    expect(accumulatedImpact(v, 4)).toBe(sum)
  })
})

describe('ADR-013 §2 — tick outside [0, now] => EngineError invalid_ticks', () => {
  const v = view([service('gw', 10)], [ok(10, 0), ok(10, 1), ok(10, 2)])
  const bad: unknown[] = [-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', undefined, null]

  it.each(bad.map((x) => [String(x), x] as const))('impactOfTick(view, %s)', (_label, tick) => {
    try {
      impactOfTick(v, tick as number)
      expect.unreachable()
    } catch (error) {
      expect(isEngineError(error)).toBe(true)
      expect(error).toMatchObject({ code: 'invalid_ticks', field: 'tick', received: tick, validValues: ['0..2'] })
    }
  })

  it.each(bad.map((x) => [String(x), x] as const))('accumulatedImpact(view, %s)', (_label, upTo) => {
    try {
      accumulatedImpact(v, upTo as number)
      expect.unreachable()
    } catch (error) {
      expect(isEngineError(error)).toBe(true)
      expect(error).toMatchObject({ code: 'invalid_ticks', field: 'upTo', received: upTo, validValues: ['0..2'] })
    }
  })

  it('both ends of [0, now] are valid', () => {
    expect(impactOfTick(v, 0).tick).toBe(0)
    expect(impactOfTick(v, 2).tick).toBe(2)
    expect(accumulatedImpact(v, 0)).toBe(0)
    expect(accumulatedImpact(v, 2)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Part 2 — calibration on the real simulation (ADR-013 §3)
// ---------------------------------------------------------------------------

const SESSION_TICKS = 360
const SEEDS = signatureSeeds('imp')
/** EN-6 (c): >= 3 deploy/config events on different components (here 4, spread over the run). */
const NOISE: readonly NoiseEvent[] = [
  { kind: 'deploy', target: 'catalog', tick: 20, note: 'harmless frontend copy change' },
  { kind: 'config', target: 'auth', tick: 40 },
  { kind: 'deploy', target: 'cart', tick: 90, instance: 'cart-1' },
  { kind: 'config', target: 'redis', tick: 200 },
]
const SANITY_WINDOW = 50
/** Each calibration case simulates up to 2 × 360 ticks; generous against a loaded CI runner. */
const CALIBRATION_TIMEOUT_MS = 60_000

function series(v: TelemetryView, from = 0, to = v.now): ImpactTick[] {
  const out: ImpactTick[] = []
  for (let t = from; t <= to; t += 1) out.push(impactOfTick(v, t))
  return out
}

function run(seed: string, opts: { kinds?: readonly FaultKind[]; noise?: readonly NoiseEvent[]; ticks: number }): TelemetryView {
  const faults = resolveFaults((opts.kinds ?? []).map((kind) => ({ kind })), buildWorld(defaultShop, seed))
  const sim = createSimulation({ system: defaultShop, seed, faults, noise: opts.noise ?? [] })
  sim.advance(opts.ticks - 1)
  return sim.telemetry()
}

describe('EN-6 (a) and (c) — baseline and noise, 360 ticks per seed', () => {
  const measured: string[] = []

  it.each(SEEDS)('%s: baseline impacted <= 1% of ticks; baseline + noise = same series', (seed) => {
    const base = run(seed, { ticks: SESSION_TICKS })
    expect(base.now).toBe(SESSION_TICKS - 1)
    const baseSeries = series(base)
    const impacted = baseSeries.filter((i) => i.impacted).length
    measured.push(`${seed}=${impacted}`)
    expect(impacted / SESSION_TICKS).toBeLessThanOrEqual(0.01)
    // Every tick expects the full ingress of default-shop (gateway 12 + orders-worker 2).
    expect(baseSeries.every((i) => i.expected === 14)).toBe(true)
    expect(accumulatedImpact(base, base.now)).toBe(impacted)

    const noisy = run(seed, { ticks: SESSION_TICKS, noise: NOISE })
    expect(noisy.eventsIn(0, noisy.now).length).toBeGreaterThanOrEqual(3)
    expect(series(noisy)).toStrictEqual(baseSeries)
  }, CALIBRATION_TIMEOUT_MS)

  it('prints the baseline measurement (ADR-013 Emenda 1)', () => {
    console.log(`[T2.6] SLOW_MS=${SLOW_MS} THETA=${THETA} baseline impacted/360: ${measured.join(' ')}`)
    expect(measured).toHaveLength(SEEDS.length)
  })
})

describe('ADR-013 §3 item 3 — sanity per kind (defaults, startTick..startTick+49)', () => {
  const kindsWithImpact = faultKinds.filter((k) => k !== 'cache_cold_start')

  function windowImpact(seed: string, kind: FaultKind): number {
    const [fault] = resolveFaults([{ kind }], buildWorld(defaultShop, seed))
    const v = run(seed, { kinds: [kind], ticks: fault!.startTick + SANITY_WINDOW })
    return series(v, fault!.startTick, fault!.startTick + SANITY_WINDOW - 1).filter((i) => i.impacted).length
  }

  it.each(kindsWithImpact)('%s: >= 1 impacted tick in every seed', (kind) => {
    const counts = SEEDS.map((seed) => windowImpact(seed, kind))
    console.log(`[T2.6] ${kind}: impacted/${SANITY_WINDOW} min ${Math.min(...counts)} max ${Math.max(...counts)} [${counts.join(',')}]`)
    for (const [i, n] of counts.entries()) expect(n, SEEDS[i]).toBeGreaterThanOrEqual(1)
  }, CALIBRATION_TIMEOUT_MS)

  // Not a requirement (ADR-013 §3 item 3 excludes this kind); measured and printed for Emenda 1.
  it('cache_cold_start: measured only (ADR-013 Consequências)', () => {
    const counts = SEEDS.map((seed) => windowImpact(seed, 'cache_cold_start'))
    console.log(`[T2.6] cache_cold_start: impacted/${SANITY_WINDOW} min ${Math.min(...counts)} max ${Math.max(...counts)} [${counts.join(',')}]`)
    expect(counts).toHaveLength(SEEDS.length)
  }, CALIBRATION_TIMEOUT_MS)
})

describe('DET — same view => same series; same seed => same series', () => {
  it('two reads of one view and two simulations of one seed agree', () => {
    const a = run('imp-det', { kinds: ['connection_pool_exhaustion'], ticks: 80 })
    const b = run('imp-det', { kinds: ['connection_pool_exhaustion'], ticks: 80 })
    const sa = series(a)
    expect(series(a)).toStrictEqual(sa)
    expect(series(b)).toStrictEqual(sa)
    expect(JSON.stringify(series(b))).toBe(JSON.stringify(sa))
    expect(accumulatedImpact(a, 79)).toBe(accumulatedImpact(b, 79))
    expect(accumulatedImpact(a, 79)).toBeGreaterThan(0)
  })
})
