/**
 * T1.33 — test helper for the seed aggregation rule R1–R5 and the F-4 eligibility rules E1–E4
 * (PRD FASE-1, Emenda 2; ADR-003 §8; ADR-004 Emenda 2).
 *
 * Test-only module: from src/ it imports types only. Every function is pure (same input, same
 * result) and nothing here draws random numbers.
 *
 * Vocabulary:
 * - "window" = signature window, ticks startTick+6 .. startTick+11 (PRD conventions).
 * - A "series" is one number per seed, in the order of the seed list: usually `windowMean` of the
 *   faulted run and of the baseline run of each seed.
 * - R2: the threshold applies to the mean over seeds of the faulted series against the same mean
 *   of the baseline series.
 * - R3: in every seed the effect goes in the same direction and has >= 75% of the required size.
 * - R4: existence conditions hold in every seed (`everySeed`).
 * - R5: ceilings and comparisons hold only on the mean (`ceiling`).
 */
import type { MetricName, MetricRecord, TelemetryRecord } from '../../src/types.js'

/** R3: per-seed share of the required effect size. */
export const PER_SEED_SHARE = 0.75
/** R1: minimum number of distinct seeds. */
export const MIN_SEEDS = 10
/** Size of the fixed default seed list of `signatureSeeds`. */
export const DEFAULT_SEED_COUNT = 12
/** Environment variable with a comma-separated seed list that replaces every default list (R1). */
export const QA_SEEDS_ENV = 'ENGINE_QA_SEEDS'

/** The 8 metrics of S-1 (E1). */
export const METRIC_NAMES: readonly MetricName[] = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']

/** E2: absolute floor on the mean of the baseline for the relative deviation to count. errorPct has none (E3). */
export const ELIGIBILITY_FLOORS: { readonly [M in MetricName]: number } = {
  rps: 1,
  p50: 5,
  p95: 5,
  p99: 5,
  errorPct: 0,
  cpu: 5,
  mem: 100,
  connections: 2,
}

/** F-4: error % deviation in percentage points (E3), mean. */
export const F4_ERROR_PP = 5
/** F-4: relative deviation of every other metric, mean. */
export const F4_DEVIATION = 0.25

/** Signature window of a fault that starts at `startTick`: ticks startTick+6 .. startTick+11. */
export function signatureWindow(startTick: number): number[] {
  return Array.from({ length: 6 }, (_, i) => startTick + 6 + i)
}

/**
 * The seeds of a signature test (R1): a fixed list `${prefix}-0 .. ${prefix}-11`, unless
 * `ENGINE_QA_SEEDS` is set, in which case its comma-separated list replaces it for every test, so
 * QA can repeat a run with another list without editing the test. The list must have >= 10
 * distinct seeds (duplicates are dropped, keeping the first occurrence); otherwise this throws.
 */
export function signatureSeeds(prefix: string, env: string | undefined = process.env[QA_SEEDS_ENV]): string[] {
  if (env === undefined) return Array.from({ length: DEFAULT_SEED_COUNT }, (_, i) => `${prefix}-${i}`)
  const seeds = [...new Set(env.split(',').map((s) => s.trim()).filter((s) => s !== ''))]
  if (seeds.length < MIN_SEEDS) {
    throw new Error(`${QA_SEEDS_ENV} must list >= ${MIN_SEEDS} distinct comma-separated seeds (R1); got ${seeds.length}: ${JSON.stringify(env)}`)
  }
  return seeds
}

/**
 * Mean of `metric` of `component` over the ticks of `window`, in one run (one seed). Reads the
 * component aggregate record when `instance` is absent (P-2), the instance record otherwise.
 * Throws when a tick of the window has no record.
 */
export function windowMean(
  records: readonly TelemetryRecord[],
  component: string,
  metric: MetricName,
  window: readonly number[],
  instance?: string,
): number {
  if (window.length === 0) throw new Error('windowMean: empty window')
  const byTick = new Map<number, MetricRecord>()
  for (const r of records) {
    if (r.type === 'metric' && r.component === component && r.instance === instance) byTick.set(r.tick, r)
  }
  let total = 0
  for (const tick of window) {
    const m = byTick.get(tick)
    if (m === undefined) throw new Error(`windowMean: no metric for ${component}/${instance ?? '*'} at tick ${tick}`)
    total += m[metric]
  }
  return total / window.length
}

/** Size-of-effect conditions (R2 on the mean, R3 per seed). */
export type EffectCond =
  /** faulted >= k x baseline; per seed >= 1 + 0.75 (k - 1). */
  | { ratioAtLeast: number }
  /** faulted >= baseline + x p.p.; per seed >= +0.75 x. */
  | { ppAtLeast: number }
  /** faulted rises >= y (fraction, 0.25 = 25%); per seed >= 0.75 y. */
  | { riseAtLeast: number }
  /** faulted <= r x baseline (a drop, r < 1); per seed <= 1 - 0.75 (1 - r). */
  | { ratioAtMost: number }

/** Ceiling and comparison conditions (R5: only on the mean). */
export type CeilingCond =
  /** faulted <= r x reference. */
  | { ratioAtMost: number }
  /** faulted <= reference + x p.p. */
  | { ppAtMost: number }
  /** |faulted - reference| <= x p.p. */
  | { ppWithin: number }

export interface SeedValue {
  seed: string
  value: number
}

export interface EffectResult {
  /** The effect on the means (ratio, difference in p.p., or rise as a fraction). */
  mean: number
  /** Threshold the mean must meet (R2). */
  required: number
  /** The same effect in every seed, in seed order. */
  perSeed: SeedValue[]
  /** Threshold every seed must meet (R3); equal to `required` for ceilings. */
  floor: number
  /** Seeds that miss `floor`, with their value. */
  failingSeeds: SeedValue[]
  pass: boolean
  /** Human-readable verdict citing the seeds and values that fail. */
  message: string
}

const labels = (n: number, seeds: readonly string[] | undefined): string[] => {
  if (seeds !== undefined && seeds.length !== n) throw new Error(`seed labels: expected ${n}, got ${seeds.length}`)
  return seeds !== undefined ? [...seeds] : Array.from({ length: n }, (_, i) => `#${i}`)
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

function checkSeries(faulted: readonly number[], base: readonly number[]): void {
  if (faulted.length === 0) throw new Error('empty series')
  if (faulted.length !== base.length) throw new Error(`series of different length: faulted ${faulted.length}, baseline ${base.length}`)
}

function ratio(f: number, b: number, what: string): number {
  if (!(b > 0)) throw new Error(`ratio condition with baseline ${b} (${what}): the ratio is undefined`)
  return f / b
}

const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(4))

function verdict(name: string, r: Omit<EffectResult, 'message' | 'pass'>, atMost: boolean, perSeed: boolean): EffectResult {
  const meets = (v: number, t: number) => (atMost ? v <= t : v >= t)
  const op = atMost ? '<=' : '>='
  const meanOk = meets(r.mean, r.required)
  const pass = meanOk && r.failingSeeds.length === 0
  const parts = [`${name}: mean ${fmt(r.mean)} (need ${op} ${fmt(r.required)})${meanOk ? '' : ' FAILS'}`]
  if (perSeed) {
    parts.push(
      r.failingSeeds.length === 0
        ? `every seed ${op} ${fmt(r.floor)}`
        : `seeds below the per-seed floor ${op} ${fmt(r.floor)}: ${r.failingSeeds.map((s) => `${s.seed}=${fmt(s.value)}`).join(', ')}`,
    )
  }
  return { ...r, pass, message: parts.join('; ') }
}

/**
 * Size-of-effect condition read with R2 (threshold on the mean over seeds) and R3 (75% floor in
 * every seed). `faulted[i]` and `base[i]` belong to the same seed (`seeds[i]`, used in messages).
 * A ratio condition with a baseline of 0 (mean or any seed) throws.
 */
export function effect(faulted: readonly number[], base: readonly number[], cond: EffectCond, seeds?: readonly string[]): EffectResult {
  checkSeries(faulted, base)
  const names = labels(faulted.length, seeds)
  const mf = mean(faulted)
  const mb = mean(base)
  let name: string
  let atMost = false
  let measure: (f: number, b: number, what: string) => number
  let required: number
  let floor: number
  if ('ratioAtLeast' in cond) {
    const k = cond.ratioAtLeast
    name = `ratio >= ${k}x`
    measure = ratio
    required = k
    floor = 1 + PER_SEED_SHARE * (k - 1)
  } else if ('ppAtLeast' in cond) {
    const x = cond.ppAtLeast
    name = `rise >= +${x} p.p.`
    measure = (f, b) => f - b
    required = x
    floor = PER_SEED_SHARE * x
  } else if ('riseAtLeast' in cond) {
    const y = cond.riseAtLeast
    name = `rise >= ${y * 100}%`
    measure = (f, b, what) => ratio(f, b, what) - 1
    required = y
    floor = PER_SEED_SHARE * y
  } else {
    const r = cond.ratioAtMost
    name = `ratio <= ${r}x`
    atMost = true
    measure = ratio
    required = r
    floor = 1 - PER_SEED_SHARE * (1 - r)
  }
  const perSeed = faulted.map((f, i) => ({ seed: names[i]!, value: measure(f, base[i]!, `seed ${names[i]!}`) }))
  const failingSeeds = perSeed.filter((s) => (atMost ? !(s.value <= floor) : !(s.value >= floor)))
  return verdict(name, { mean: measure(mf, mb, 'mean over seeds'), required, perSeed, floor, failingSeeds }, atMost, true)
}

/**
 * Ceiling or comparison condition read with R5: only on the mean over seeds (R2). `reference` is
 * usually the baseline series, but can be any series of the same seeds (e.g. "the aggregate is at
 * most half of the affected instance": `ceiling(aggregate, affected, { ratioAtMost: 0.5 })`).
 * `perSeed` is reported for information only; `failingSeeds` is always empty.
 */
export function ceiling(faulted: readonly number[], reference: readonly number[], cond: CeilingCond, seeds?: readonly string[]): EffectResult {
  checkSeries(faulted, reference)
  const names = labels(faulted.length, seeds)
  let name: string
  let measure: (f: number, b: number, what: string) => number
  let required: number
  if ('ratioAtMost' in cond) {
    name = `ratio <= ${cond.ratioAtMost}x (mean only)`
    measure = ratio
    required = cond.ratioAtMost
  } else if ('ppAtMost' in cond) {
    name = `rise <= +${cond.ppAtMost} p.p. (mean only)`
    measure = (f, b) => f - b
    required = cond.ppAtMost
  } else {
    name = `|difference| <= ${cond.ppWithin} p.p. (mean only)`
    measure = (f, b) => Math.abs(f - b)
    required = cond.ppWithin
  }
  const perSeed = faulted.map((f, i) => ({ seed: names[i]!, value: measure(f, reference[i]!, `seed ${names[i]!}`) }))
  const result = { mean: measure(mean(faulted), mean(reference), 'mean over seeds'), required, perSeed, floor: required, failingSeeds: [] }
  return verdict(name, result, true, false)
}

export interface EverySeedResult {
  pass: boolean
  failingSeeds: string[]
  message: string
}

/**
 * Existence condition read with R4: `predicate` must hold in every seed, with no tolerance. The
 * predicate returns true, or false / a string explaining what is missing in that seed.
 */
export function everySeed(seeds: readonly string[], predicate: (seed: string, index: number) => boolean | string): EverySeedResult {
  if (seeds.length === 0) throw new Error('everySeed: no seeds')
  const failures: { seed: string; why: string }[] = []
  seeds.forEach((seed, i) => {
    const ok = predicate(seed, i)
    if (ok !== true) failures.push({ seed, why: typeof ok === 'string' ? ok : 'condition does not hold' })
  })
  return {
    pass: failures.length === 0,
    failingSeeds: failures.map((f) => f.seed),
    message:
      failures.length === 0 ? `holds in all ${seeds.length} seeds` : `fails in ${failures.length}/${seeds.length} seeds: ${failures.map((f) => `${f.seed} (${f.why})`).join(', ')}`,
  }
}

/** Throws an Error with the result message when an `effect` / `ceiling` / `everySeed` result fails. */
export function assertPass(result: { pass: boolean; message: string }, what = 'condition'): void {
  if (!result.pass) throw new Error(`${what}: ${result.message}`)
}

export interface F4Pair {
  component: string
  metric: MetricName
}

export interface F4Options {
  /** Signature window (`signatureWindow(startTick)`). */
  window: readonly number[]
  /** Seed labels, in the order of the runs. */
  seeds: readonly string[]
}

export interface F4Result {
  pair: F4Pair
  /** Mean over seeds of the baseline window means (E2 floor applies to it). */
  baselineMean: number
  direction: 'rise' | 'drop'
  result: EffectResult
}

/**
 * F-4 with the eligibility rules: asserts that the fixed pair (component, metric) is an eligible
 * indirect signal of a fault on `target`, in every seed (E4). Reads the component aggregate (E1)
 * from each run over `window`, then:
 * - `component !== target`;
 * - E1: `metric` is one of the 8 metrics of S-1;
 * - E2: the mean of the baseline is at or above the floor of the metric (not for errorPct);
 * - E3: errorPct rises >= +5 p.p. on the mean and >= +3.75 p.p. in every seed; every other metric
 *   deviates >= 25% on the mean and >= 18.75% in every seed, in the direction of the deviation of
 *   the mean (a rise, or a drop to <= 0.75x / 0.8125x).
 * `base[i]` and `faulted[i]` are the baseline and faulted runs of `seeds[i]`. Throws an Error
 * citing the seed and the value when anything fails; returns the measurement otherwise.
 */
export function assertEligibleF4(
  pair: F4Pair,
  base: readonly (readonly TelemetryRecord[])[],
  faulted: readonly (readonly TelemetryRecord[])[],
  target: string,
  options: F4Options,
): F4Result {
  const { component, metric } = pair
  const tag = `F-4 (${component}, ${metric})`
  if (component === target) throw new Error(`${tag}: the component is the fault target ${target}; F-4 needs a different component`)
  if (!METRIC_NAMES.includes(metric)) throw new Error(`${tag}: E1, not a metric of S-1; valid: ${METRIC_NAMES.join(', ')}`)
  if (base.length !== faulted.length || base.length !== options.seeds.length) {
    throw new Error(`${tag}: runs and seeds differ in length (baseline ${base.length}, faulted ${faulted.length}, seeds ${options.seeds.length})`)
  }
  const b = base.map((records) => windowMean(records, component, metric, options.window))
  const f = faulted.map((records) => windowMean(records, component, metric, options.window))
  const baselineMean = mean(b)
  const floorE2 = ELIGIBILITY_FLOORS[metric]
  if (metric !== 'errorPct' && !(baselineMean >= floorE2)) {
    throw new Error(`${tag}: E2, baseline mean ${fmt(baselineMean)} is below the floor ${floorE2}; a relative deviation does not count`)
  }
  let direction: 'rise' | 'drop'
  let result: EffectResult
  if (metric === 'errorPct') {
    direction = 'rise'
    result = effect(f, b, { ppAtLeast: F4_ERROR_PP }, options.seeds)
  } else if (mean(f) >= baselineMean) {
    direction = 'rise'
    result = effect(f, b, { riseAtLeast: F4_DEVIATION }, options.seeds)
  } else {
    direction = 'drop'
    result = effect(f, b, { ratioAtMost: 1 - F4_DEVIATION }, options.seeds)
  }
  if (!result.pass) throw new Error(`${tag}: E3/E4, ${result.message}`)
  return { pair, baselineMean, direction, result }
}
