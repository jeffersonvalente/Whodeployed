/**
 * T1.33 — tests of the R1–R5 / E1–E4 helper (PRD FASE-1 Emenda 2) on synthetic series and
 * synthetic telemetry. DET: the helper is pure; the last block checks that.
 */
import { describe, expect, it } from 'vitest'
import type { MetricName, MetricRecord, TelemetryRecord } from '../../src/types.js'
import {
  ELIGIBILITY_FLOORS,
  QA_SEEDS_ENV,
  assertEligibleF4,
  assertPass,
  ceiling,
  effect,
  everySeed,
  signatureSeeds,
  signatureWindow,
  windowMean,
} from './signature.js'

const SEEDS10 = Array.from({ length: 10 }, (_, i) => `s-${i}`)

/**
 * Runs `fn` with ENGINE_QA_SEEDS set to `value` (deleted when undefined) and restores the
 * caller's value afterwards, so these tests pass whatever list QA exported (#60, R1).
 */
function withQaSeeds<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env[QA_SEEDS_ENV]
  try {
    if (value === undefined) delete process.env[QA_SEEDS_ENV]
    else process.env[QA_SEEDS_ENV] = value
    return fn()
  } finally {
    if (saved === undefined) delete process.env[QA_SEEDS_ENV]
    else process.env[QA_SEEDS_ENV] = saved
  }
}
const ones = (n: number, v = 1) => Array.from({ length: n }, () => v)

describe('signatureWindow', () => {
  it('is startTick+6 .. startTick+11', () => {
    expect(signatureWindow(10)).toEqual([16, 17, 18, 19, 20, 21])
    expect(signatureWindow(0)).toEqual([6, 7, 8, 9, 10, 11])
  })
})

describe('signatureSeeds (R1)', () => {
  it('without ENGINE_QA_SEEDS: 12 fixed seeds prefix-0..11', () => {
    // An explicit `undefined` falls back to the default parameter (process.env), so the variable
    // is cleared for this case (#60).
    withQaSeeds(undefined, () => {
      expect(signatureSeeds('pool', undefined)).toEqual(Array.from({ length: 12 }, (_, i) => `pool-${i}`))
      expect(signatureSeeds('pool')).toEqual(Array.from({ length: 12 }, (_, i) => `pool-${i}`))
    })
  })

  it('ENGINE_QA_SEEDS replaces the list: comma-separated, trimmed, empty entries dropped', () => {
    const list = ' a, b,c,d,e,f,g,h,i,j ,,k'
    expect(signatureSeeds('pool', list)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'])
    // The prefix is irrelevant once the QA list is set: every test uses the same list.
    expect(signatureSeeds('disk', list)).toEqual(signatureSeeds('pool', list))
  })

  it('fewer than 10 distinct seeds throws, naming the variable', () => {
    expect(() => signatureSeeds('p', 'a,b,c,d,e,f,g,h,i')).toThrow(QA_SEEDS_ENV)
    // Duplicates do not count: 10 entries, 9 distinct.
    expect(() => signatureSeeds('p', 'a,b,c,d,e,f,g,h,i,a')).toThrow(/>= 10 distinct/)
    expect(() => signatureSeeds('p', '')).toThrow(QA_SEEDS_ENV)
    expect(signatureSeeds('p', 'a,b,c,d,e,f,g,h,i,a,j')).toHaveLength(10)
  })

  it('reads process.env.ENGINE_QA_SEEDS by default', () => {
    withQaSeeds(SEEDS10.join(','), () => {
      expect(signatureSeeds('x')).toEqual(SEEDS10)
      // An explicit undefined also reads the variable (default parameter).
      expect(signatureSeeds('x', undefined)).toEqual(SEEDS10)
    })
    withQaSeeds(undefined, () => expect(signatureSeeds('x')).toEqual(Array.from({ length: 12 }, (_, i) => `x-${i}`)))
    withQaSeeds('a,b', () => expect(() => signatureSeeds('x')).toThrow(QA_SEEDS_ENV))
  })

  it('restores the caller value of ENGINE_QA_SEEDS (the suite passes with and without it, #60)', () => {
    const before = process.env[QA_SEEDS_ENV]
    withQaSeeds(SEEDS10.join(','), () => undefined)
    withQaSeeds(undefined, () => undefined)
    expect(process.env[QA_SEEDS_ENV]).toBe(before)
  })
})

const metric = (component: string, tick: number, values: Partial<Record<MetricName, number>>, instance?: string): MetricRecord => ({
  type: 'metric',
  tick,
  component,
  ...(instance === undefined ? {} : { instance }),
  rps: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  errorPct: 0,
  cpu: 0,
  mem: 0,
  connections: 0,
  ...values,
})

describe('windowMean', () => {
  const records: TelemetryRecord[] = [
    metric('a', 1, { p95: 10 }),
    metric('a', 2, { p95: 20 }),
    metric('a', 3, { p95: 90 }),
    metric('a', 1, { p95: 100 }, 'a-0'),
    metric('a', 2, { p95: 200 }, 'a-0'),
    metric('b', 1, { p95: 1000 }),
    { type: 'event', tick: 1, kind: 'deploy', target: 'a' },
  ]

  it('averages the aggregate over the window when instance is absent', () => {
    expect(windowMean(records, 'a', 'p95', [1, 2])).toBe(15)
    expect(windowMean(records, 'a', 'p95', [3])).toBe(90)
  })

  it('reads the instance record when instance is given', () => {
    expect(windowMean(records, 'a', 'p95', [1, 2], 'a-0')).toBe(150)
  })

  it('a tick of the window without a record throws; an empty window throws', () => {
    expect(() => windowMean(records, 'a', 'p95', [1, 4])).toThrow(/tick 4/)
    expect(() => windowMean(records, 'a', 'p95', [3], 'a-0')).toThrow(/a\/a-0/)
    expect(() => windowMean(records, 'a', 'p95', [])).toThrow(/empty window/)
  })
})

describe('effect — R2 (mean) and R3 (75% floor per seed)', () => {
  it('ratioAtLeast k: mean >= k, every seed >= 1 + 0.75 (k - 1)', () => {
    const base = ones(10, 10)
    // Mean 3.06x, seed s-0 at 2.4x (< 2.5): passes on the mean, fails per seed.
    const f = [24, ...ones(9, 31.33)]
    const r = effect(f, base, { ratioAtLeast: 3 }, SEEDS10)
    expect(r.mean).toBeGreaterThanOrEqual(3)
    expect(r.floor).toBe(2.5)
    expect(r.pass).toBe(false)
    expect(r.failingSeeds).toEqual([{ seed: 's-0', value: 2.4 }])
    expect(r.message).toContain('s-0=2.4')
    // Every seed 2.9x: passes per seed (>= 2.5), fails on the mean (< 3).
    const r2 = effect(ones(10, 29), base, { ratioAtLeast: 3 }, SEEDS10)
    expect(r2.failingSeeds).toEqual([])
    expect(r2.pass).toBe(false)
    expect(r2.message).toContain('FAILS')
    // Exactly at the thresholds passes.
    expect(effect([25, ...ones(9, 31)], base, { ratioAtLeast: 3 }).pass).toBe(true)
    // 2x -> 1.75x per seed.
    expect(effect([17.5, ...ones(9, 21)], base, { ratioAtLeast: 2 }).pass).toBe(true)
    expect(effect([17.4, ...ones(9, 21)], base, { ratioAtLeast: 2 }).pass).toBe(false)
  })

  it('ppAtLeast x: mean difference >= x, every seed >= 0.75 x', () => {
    const base = ones(10, 1)
    const r = effect([4, ...ones(9, 7)], base, { ppAtLeast: 5 }, SEEDS10)
    expect(r.mean).toBeCloseTo(5.7, 10)
    expect(r.floor).toBe(3.75)
    expect(r.pass).toBe(false)
    expect(r.failingSeeds.map((s) => s.seed)).toEqual(['s-0'])
    expect(effect(ones(10, 5.5), base, { ppAtLeast: 5 }).pass).toBe(false)
    expect(effect(ones(10, 5.5), base, { ppAtLeast: 5 }).failingSeeds).toEqual([])
    expect(effect([4.75, ...ones(9, 6.5)], base, { ppAtLeast: 5 }).pass).toBe(true)
    // A drop is the wrong direction: never passes.
    expect(effect(ones(10, 0), base, { ppAtLeast: 5 }).failingSeeds).toHaveLength(10)
    // p.p. needs no non-zero baseline.
    expect(effect(ones(10, 6), ones(10, 0), { ppAtLeast: 5 }).pass).toBe(true)
  })

  it('riseAtLeast y (fraction): mean rise >= y, every seed >= 0.75 y', () => {
    const base = ones(10, 100)
    const r = effect([118, ...ones(9, 128)], base, { riseAtLeast: 0.25 }, SEEDS10)
    expect(r.mean).toBeCloseTo(0.27, 10)
    expect(r.floor).toBe(0.1875)
    expect(r.failingSeeds.map((s) => s.seed)).toEqual(['s-0'])
    expect(r.pass).toBe(false)
    expect(effect(ones(10, 124), base, { riseAtLeast: 0.25 }).pass).toBe(false)
    expect(effect([118.75, ...ones(9, 128)], base, { riseAtLeast: 0.25 }).pass).toBe(true)
  })

  it('ratioAtMost r (a drop): mean <= r, every seed <= 1 - 0.75 (1 - r)', () => {
    const base = ones(10, 100)
    // RPS <= 50% -> <= 62.5% per seed.
    const r = effect([63, ...ones(9, 45)], base, { ratioAtMost: 0.5 }, SEEDS10)
    expect(r.mean).toBeLessThanOrEqual(0.5)
    expect(r.floor).toBe(0.625)
    expect(r.failingSeeds).toEqual([{ seed: 's-0', value: 0.63 }])
    expect(r.pass).toBe(false)
    expect(effect(ones(10, 55), base, { ratioAtMost: 0.5 }).failingSeeds).toEqual([])
    expect(effect(ones(10, 55), base, { ratioAtMost: 0.5 }).pass).toBe(false)
    expect(effect([62.5, ...ones(9, 48)], base, { ratioAtMost: 0.5 }).pass).toBe(true)
  })

  it('a ratio condition with a zero baseline throws (mean or any seed)', () => {
    expect(() => effect(ones(10, 1), ones(10, 0), { ratioAtLeast: 2 })).toThrow(/baseline 0/)
    expect(() => effect(ones(10, 1), [0, ...ones(9, 1)], { ratioAtLeast: 2 }, SEEDS10)).toThrow(/seed s-0/)
    expect(() => effect(ones(10, 1), ones(10, 0), { riseAtLeast: 0.25 })).toThrow(/baseline 0/)
    expect(() => effect(ones(10, 1), ones(10, 0), { ratioAtMost: 0.5 })).toThrow(/baseline 0/)
  })

  it('series of different length, empty series or wrong label count throw', () => {
    expect(() => effect([1, 2], [1], { ppAtLeast: 1 })).toThrow(/different length/)
    expect(() => effect([], [], { ppAtLeast: 1 })).toThrow(/empty/)
    expect(() => effect([1, 2], [1, 1], { ppAtLeast: 1 }, ['a'])).toThrow(/seed labels/)
  })

  it('without labels, seeds are named by index', () => {
    expect(effect([0, 9], [0, 0], { ppAtLeast: 5 }).failingSeeds).toEqual([{ seed: '#0', value: 0 }])
  })
})

describe('ceiling — R5 (mean only)', () => {
  it('ratioAtMost: a seed above the ceiling does not fail when the mean is below', () => {
    const base = ones(10, 100)
    const r = ceiling([180, ...ones(9, 130)], base, { ratioAtMost: 1.5 }, SEEDS10)
    expect(r.perSeed[0]).toEqual({ seed: 's-0', value: 1.8 })
    expect(r.failingSeeds).toEqual([])
    expect(r.pass).toBe(true)
    const bad = ceiling(ones(10, 151), base, { ratioAtMost: 1.5 })
    expect(bad.pass).toBe(false)
    expect(bad.message).toContain('FAILS')
    expect(() => ceiling(ones(10, 1), ones(10, 0), { ratioAtMost: 1.5 })).toThrow(/baseline 0/)
  })

  it('ppAtMost and ppWithin', () => {
    expect(ceiling(ones(10, 3), ones(10, 1), { ppAtMost: 2 }).pass).toBe(true)
    expect(ceiling(ones(10, 3.1), ones(10, 1), { ppAtMost: 2 }).pass).toBe(false)
    // ppWithin is two-sided.
    expect(ceiling(ones(10, 0), ones(10, 2), { ppWithin: 2 }).pass).toBe(true)
    expect(ceiling(ones(10, 0), ones(10, 2.5), { ppWithin: 2 }).pass).toBe(false)
    expect(ceiling([10, ...ones(9, 1)], ones(10, 1), { ppWithin: 2 }).pass).toBe(true)
  })

  it('compares two faulted series (aggregate <= half of the affected instance)', () => {
    expect(ceiling(ones(10, 30), ones(10, 90), { ratioAtMost: 0.5 }).pass).toBe(true)
    expect(ceiling(ones(10, 46), ones(10, 90), { ratioAtMost: 0.5 }).pass).toBe(false)
  })
})

describe('everySeed — R4 (no tolerance)', () => {
  it('passes only when the predicate holds in every seed, and names the failures', () => {
    expect(everySeed(SEEDS10, () => true)).toEqual({ pass: true, failingSeeds: [], message: 'holds in all 10 seeds' })
    const r = everySeed(SEEDS10, (seed, i) => (i === 3 ? 'no error log at tick 17' : i !== 7))
    expect(r.pass).toBe(false)
    expect(r.failingSeeds).toEqual(['s-3', 's-7'])
    expect(r.message).toContain('s-3 (no error log at tick 17)')
    expect(r.message).toContain('s-7 (condition does not hold)')
    expect(() => everySeed([], () => true)).toThrow(/no seeds/)
  })

  it('assertPass throws the message of a failing result', () => {
    expect(() => assertPass(everySeed(['a'], () => false), 'R4 event')).toThrow('R4 event: fails in 1/1 seeds: a (condition does not hold)')
    expect(() => assertPass(effect([3], [0], { ppAtLeast: 5 }, ['z']))).toThrow(/z=3/)
    expect(() => assertPass(effect([6], [0], { ppAtLeast: 5 }))).not.toThrow()
  })
})

/** One run with a constant aggregate `value` of `metric` on `component` over `window`. */
const run = (component: string, metricName: MetricName, value: number, window: readonly number[]): TelemetryRecord[] =>
  window.map((tick) => metric(component, tick, { [metricName]: value }))
const runs = (component: string, metricName: MetricName, values: readonly number[], window: readonly number[]) =>
  values.map((v) => run(component, metricName, v, window))

describe('assertEligibleF4 — E1–E4', () => {
  const window = signatureWindow(10)
  const opts = { window, seeds: SEEDS10 }

  it('E2: floors on the baseline mean, at the limit and just below', () => {
    const cases: [MetricName, number][] = [
      ['rps', 1],
      ['p50', 5],
      ['p95', 5],
      ['p99', 5],
      ['connections', 2],
      ['cpu', 5],
      ['mem', 100],
    ]
    for (const [m, floor] of cases) {
      expect(ELIGIBILITY_FLOORS[m]).toBe(floor)
      const base = runs('x', m, ones(10, floor), window)
      const up = runs('x', m, ones(10, floor * 1.3), window)
      expect(assertEligibleF4({ component: 'x', metric: m }, base, up, 't', opts).direction).toBe('rise')
      const below = floor * 0.999
      expect(() =>
        assertEligibleF4({ component: 'x', metric: m }, runs('x', m, ones(10, below), window), runs('x', m, ones(10, below * 2), window), 't', opts),
      ).toThrow(/E2/)
    }
  })

  it('E2 applies to the mean of the baseline, not to each seed', () => {
    const base = runs('x', 'rps', [0.5, ...ones(9, 1.1)], window)
    const f = runs('x', 'rps', [1, ...ones(9, 1.5)], window)
    expect(assertEligibleF4({ component: 'x', metric: 'rps' }, base, f, 't', opts).baselineMean).toBeCloseTo(1.04, 10)
  })

  it('E3: errorPct in p.p. (>= +5 mean, >= +3.75 per seed), with no floor and only upwards', () => {
    const base = runs('x', 'errorPct', ones(10, 0), window)
    const ok = assertEligibleF4({ component: 'x', metric: 'errorPct' }, base, runs('x', 'errorPct', [3.75, ...ones(9, 6)], window), 't', opts)
    expect(ok.direction).toBe('rise')
    expect(ok.result.floor).toBe(3.75)
    expect(() => assertEligibleF4({ component: 'x', metric: 'errorPct' }, base, runs('x', 'errorPct', [3.7, ...ones(9, 6)], window), 't', opts)).toThrow(
      /s-0=3\.7/,
    )
    // A relative rise of a tiny error % is noise: +0.4 p.p. from 0.1 is +400% but fails.
    expect(() =>
      assertEligibleF4({ component: 'x', metric: 'errorPct' }, runs('x', 'errorPct', ones(10, 0.1), window), runs('x', 'errorPct', ones(10, 0.5), window), 't', opts),
    ).toThrow(/E3/)
    expect(() =>
      assertEligibleF4({ component: 'x', metric: 'errorPct' }, runs('x', 'errorPct', ones(10, 10), window), runs('x', 'errorPct', ones(10, 0), window), 't', opts),
    ).toThrow(/E3/)
  })

  it('E3: other metrics deviate >= 25% on the mean and >= 18.75% per seed, in the direction of the mean', () => {
    const base = runs('x', 'p95', ones(10, 100), window)
    expect(() => assertEligibleF4({ component: 'x', metric: 'p95' }, base, runs('x', 'p95', [118, ...ones(9, 130)], window), 't', opts)).toThrow(/s-0/)
    expect(assertEligibleF4({ component: 'x', metric: 'p95' }, base, runs('x', 'p95', [118.75, ...ones(9, 130)], window), 't', opts).result.pass).toBe(true)
    // A drop: <= 0.75x on the mean, <= 0.8125x per seed.
    const drop = assertEligibleF4({ component: 'x', metric: 'p95' }, base, runs('x', 'p95', [81.25, ...ones(9, 70)], window), 't', opts)
    expect(drop.direction).toBe('drop')
    expect(drop.result.floor).toBe(0.8125)
    expect(() => assertEligibleF4({ component: 'x', metric: 'p95' }, base, runs('x', 'p95', [82, ...ones(9, 70)], window), 't', opts)).toThrow(/s-0/)
    // A seed going the other way fails the floor.
    expect(() => assertEligibleF4({ component: 'x', metric: 'p95' }, base, runs('x', 'p95', [90, ...ones(9, 140)], window), 't', opts)).toThrow(/s-0/)
  })

  it('E4: the same pair in every seed — a seed where only another metric moves fails', () => {
    const base = SEEDS10.map(() => window.map((tick) => metric('x', tick, { p95: 100, rps: 10 })))
    // Seed s-0: p95 flat, rps doubled. Every other seed: p95 up 50%.
    const f = SEEDS10.map((_, i) => window.map((tick) => metric('x', tick, i === 0 ? { p95: 100, rps: 20 } : { p95: 150, rps: 10 })))
    expect(() => assertEligibleF4({ component: 'x', metric: 'p95' }, base, f, 't', opts)).toThrow(/s-0=0/)
    expect(() => assertEligibleF4({ component: 'x', metric: 'rps' }, base, f, 't', opts)).toThrow(/E3\/E4/)
  })

  it('E1: reads the aggregate, not an instance; rejects names outside S-1', () => {
    const base = SEEDS10.map(() => window.flatMap((tick) => [metric('x', tick, { p95: 100 }), metric('x', tick, { p95: 100 }, 'x-0')]))
    // Only the instance moves: the aggregate does not, so F-4 fails.
    const f = SEEDS10.map(() => window.flatMap((tick) => [metric('x', tick, { p95: 100 }), metric('x', tick, { p95: 900 }, 'x-0')]))
    expect(() => assertEligibleF4({ component: 'x', metric: 'p95' }, base, f, 't', opts)).toThrow(/F-4 \(x, p95\)/)
    expect(() => assertEligibleF4({ component: 'x', metric: 'hitRate' as MetricName }, base, f, 't', opts)).toThrow(/E1/)
  })

  it('the component must differ from the target; runs and seeds must line up', () => {
    const base = runs('x', 'p95', ones(10, 100), window)
    const f = runs('x', 'p95', ones(10, 200), window)
    expect(() => assertEligibleF4({ component: 'x', metric: 'p95' }, base, f, 'x', opts)).toThrow(/target/)
    expect(() => assertEligibleF4({ component: 'x', metric: 'p95' }, base.slice(1), f, 't', opts)).toThrow(/differ in length/)
    expect(() => assertEligibleF4({ component: 'y', metric: 'p95' }, base, f, 't', opts)).toThrow(/no metric for y/)
  })
})

describe('DET — pure functions', () => {
  it('same input => same result, and the inputs are not mutated', () => {
    const f = [24, 31, 33, 29, 30, 35, 31, 30, 32, 34]
    const b = ones(10, 10)
    const copy = [...f]
    expect(effect(f, b, { ratioAtLeast: 3 }, SEEDS10)).toStrictEqual(effect(f, b, { ratioAtLeast: 3 }, SEEDS10))
    expect(ceiling(f, b, { ratioAtMost: 4 })).toStrictEqual(ceiling(f, b, { ratioAtMost: 4 }))
    expect(f).toEqual(copy)
    expect(signatureSeeds('d', 'a,b,c,d,e,f,g,h,i,j')).toStrictEqual(signatureSeeds('d', 'a,b,c,d,e,f,g,h,i,j'))
    withQaSeeds(undefined, () => expect(signatureSeeds('d')).toStrictEqual(signatureSeeds('d')))
  })
})
