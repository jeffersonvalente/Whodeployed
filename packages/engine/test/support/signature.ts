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
 * - R6 (PRD Emenda 3, PR #68; ADR-004 Emenda 3; T1.37): a seed in which the fault target serves
 *   no request in the window of the faulted run (`exercised` is false) is exempt from the per-seed
 *   floor, and only there. Closed scope: F-3 row 3 (`connection_pool_exhaustion`, alone or in any
 *   F-6 combination) and only three conditions, `R6_CONDITIONS`: p95 of the target (ratio >= 3x),
 *   p95 of the gateway (rise >= 25%) and the fixed F-4 pair of row 3 (gateway, p95). The only way
 *   to exempt a seed is an `R6Exemption` built by `r6Exemption`, which refuses any other kind;
 *   `effect` and `assertEligibleF4` check that the exemption names the condition they measure.
 *   Exempt seeds still enter the means (R2, R5). Existence conditions (R4, `everySeed`) and
 *   ceilings (R5, `ceiling`) take no exemption. The share of unexercised seeds over >= 1000
 *   consecutive seeds is capped at 2%, per case (`unexercisedShare`).
 */
import type { FaultKind, MetricName, MetricRecord, TelemetryRecord } from '../../src/types.js'

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

/** R6: maximum share of unexercised seeds (target serves no request in the window). */
export const R6_MAX_UNEXERCISED_SHARE = 0.02
/** R6: minimum number of consecutive seeds over which the share is measured. */
export const R6_MIN_SEEDS = 1000

/**
 * R6: number of `server` spans of `target` whose tick is in `window`, in one run. A trace is
 * stamped with the tick in which it started, and a request served by the target is exactly one
 * server span of the target.
 */
export function servedRequests(records: readonly TelemetryRecord[], target: string, window: readonly number[]): number {
  if (window.length === 0) throw new Error('servedRequests: empty window')
  const ticks = new Set(window)
  let n = 0
  for (const r of records) if (r.type === 'span' && r.kind === 'server' && r.component === target && ticks.has(r.tick)) n += 1
  return n
}

/**
 * R6: true when the target serves >= 1 request in the window of this run (>= 1 `server` span of
 * the target with its tick in the window). Called on the faulted run of each seed.
 */
export function exercised(records: readonly TelemetryRecord[], target: string, window: readonly number[]): boolean {
  return servedRequests(records, target, window) > 0
}

/** R6 (PRD Emenda 3): the only fault kinds the exemption applies to (F-3 row 3). */
export const R6_KINDS: readonly FaultKind[] = ['connection_pool_exhaustion']

/** R6 (PRD Emenda 3): the only conditions of row 3 that can be exempted. */
export type R6Condition = 'targetP95' | 'gatewayP95' | 'f4Pair'
export const R6_CONDITIONS: readonly R6Condition[] = ['targetP95', 'gatewayP95', 'f4Pair']

/** The condition each R6Condition stands for, checked where the exemption is used. */
const R6_EFFECT_CONDS: { readonly [C in Exclude<R6Condition, 'f4Pair'>]: string } = {
  targetP95: JSON.stringify({ ratioAtLeast: 3 }),
  gatewayP95: JSON.stringify({ riseAtLeast: 0.25 }),
}
/** The fixed F-4 pair of row 3 (ADR-004 Emenda 2; PRD Emenda 3). */
export const R6_F4_PAIR: Readonly<F4Pair> = { component: 'gateway', metric: 'p95' }

declare const r6Brand: unique symbol
/**
 * An R6 exemption: one flag per seed (true = target not exercised in the faulted run), for one
 * kind of `R6_KINDS` and one condition of `R6_CONDITIONS`. Only `r6Exemption` builds one.
 */
export interface R6Exemption {
  readonly [r6Brand]: true
  readonly kind: FaultKind
  readonly condition: R6Condition
  readonly flags: readonly boolean[]
}

/**
 * Builds the R6 exemption of `condition` for a fault of `kind` on `target`, from the faulted run
 * of each seed (`faulted[i]` belongs to seed i). Throws for a kind outside `R6_KINDS` or a
 * condition outside `R6_CONDITIONS`: extending R6 needs a new PRD amendment.
 */
export function r6Exemption(
  kind: FaultKind,
  condition: R6Condition,
  faulted: readonly (readonly TelemetryRecord[])[],
  target: string,
  window: readonly number[],
): R6Exemption {
  if (!R6_KINDS.includes(kind)) throw new Error(`R6 does not apply to ${kind}: only ${R6_KINDS.join(', ')} (PRD Emenda 3)`)
  if (!R6_CONDITIONS.includes(condition)) throw new Error(`R6 does not apply to condition ${String(condition)}: only ${R6_CONDITIONS.join(', ')} (PRD Emenda 3)`)
  return { kind, condition, flags: faulted.map((records) => !exercised(records, target, window)) } as unknown as R6Exemption
}

export interface UnexercisedShareResult {
  /** Number of seeds measured. */
  seeds: number
  /** Seeds in which the target is not exercised, in order. */
  unexercised: string[]
  /** unexercised / seeds. */
  share: number
  pass: boolean
  message: string
}

/**
 * R6 ceiling: over >= 1000 consecutive seeds (`seeds[i]` labels `isExercised[i]`), the share of
 * seeds in which the target is not exercised must be <= 2%; above it the fault is badly
 * parameterised and the criterion fails. Fewer than 1000 seeds, or lists of different length, throw.
 */
export function unexercisedShare(seeds: readonly string[], isExercised: readonly boolean[]): UnexercisedShareResult {
  if (seeds.length !== isExercised.length) throw new Error(`unexercisedShare: ${seeds.length} seeds, ${isExercised.length} flags`)
  if (seeds.length < R6_MIN_SEEDS) throw new Error(`unexercisedShare: R6 needs >= ${R6_MIN_SEEDS} seeds; got ${seeds.length}`)
  const unexercised = seeds.filter((_, i) => !isExercised[i])
  const share = unexercised.length / seeds.length
  const pass = share <= R6_MAX_UNEXERCISED_SHARE
  const list = unexercised.length === 0 ? '' : `: ${unexercised.slice(0, 20).join(', ')}${unexercised.length > 20 ? ', ...' : ''}`
  return {
    seeds: seeds.length,
    unexercised,
    share,
    pass,
    message: `${unexercised.length}/${seeds.length} seeds unexercised (${(share * 100).toFixed(3)}%, need <= ${R6_MAX_UNEXERCISED_SHARE * 100}%)${pass ? '' : ' FAILS'}${list}`,
  }
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
  /** Seeds that miss `floor`, with their value; never an exempt seed (R6). */
  failingSeeds: SeedValue[]
  /** Seeds exempt from `floor` (R6), in seed order; they still enter `mean`. */
  exemptSeeds: string[]
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

function exemptFlags(n: number, exempt: R6Exemption | undefined): readonly boolean[] {
  if (exempt === undefined) return Array.from({ length: n }, () => false)
  if (!R6_KINDS.includes(exempt.kind) || !R6_CONDITIONS.includes(exempt.condition)) {
    throw new Error(`exempt (R6): ${exempt.kind}/${exempt.condition} is outside the scope of PRD Emenda 3`)
  }
  if (exempt.flags.length !== n) throw new Error(`exempt (R6): expected ${n} flags, got ${exempt.flags.length}`)
  return exempt.flags
}

function verdict(name: string, r: Omit<EffectResult, 'message' | 'pass'>, atMost: boolean, perSeed: boolean): EffectResult {
  const meets = (v: number, t: number) => (atMost ? v <= t : v >= t)
  const op = atMost ? '<=' : '>='
  const meanOk = meets(r.mean, r.required)
  const pass = meanOk && r.failingSeeds.length === 0
  const parts = [`${name}: mean ${fmt(r.mean)} (need ${op} ${fmt(r.required)})${meanOk ? '' : ' FAILS'}`]
  if (perSeed) {
    const every = r.exemptSeeds.length === 0 ? 'every seed' : 'every non-exempt seed'
    parts.push(
      r.failingSeeds.length === 0
        ? `${every} ${op} ${fmt(r.floor)}`
        : `seeds below the per-seed floor ${op} ${fmt(r.floor)}: ${r.failingSeeds.map((s) => `${s.seed}=${fmt(s.value)}`).join(', ')}`,
    )
    if (r.exemptSeeds.length > 0) parts.push(`exempt (R6, target not exercised): ${r.exemptSeeds.join(', ')}`)
  }
  return { ...r, pass, message: parts.join('; ') }
}

/**
 * Size-of-effect condition read with R2 (threshold on the mean over seeds) and R3 (75% floor in
 * every seed). `faulted[i]` and `base[i]` belong to the same seed (`seeds[i]`, used in messages).
 * A ratio condition with a baseline of 0 (mean or any non-exempt seed) throws.
 *
 * `exempt` (R6, PRD Emenda 3): built by `r6Exemption` for `targetP95` (cond must be ratio >= 3x)
 * or `gatewayP95` (cond must be rise >= 25%); any other use throws. An exempt seed is left out of
 * the per-seed floor but still enters the mean. Its per-seed value is reported for information
 * (NaN when a ratio has a zero baseline in that seed, which is what an unexercised target gives).
 */
export function effect(
  faulted: readonly number[],
  base: readonly number[],
  cond: EffectCond,
  seeds?: readonly string[],
  exempt?: R6Exemption,
): EffectResult {
  return effectWith(faulted, base, cond, seeds, exempt, false)
}

function effectWith(
  faulted: readonly number[],
  base: readonly number[],
  cond: EffectCond,
  seeds: readonly string[] | undefined,
  exempt: R6Exemption | undefined,
  fromF4: boolean,
): EffectResult {
  checkSeries(faulted, base)
  const names = labels(faulted.length, seeds)
  if (exempt !== undefined) {
    if (exempt.condition === 'f4Pair') {
      if (!fromF4) throw new Error('exempt (R6): f4Pair is only accepted by assertEligibleF4')
    } else if (fromF4 || R6_EFFECT_CONDS[exempt.condition] !== JSON.stringify(cond)) {
      throw new Error(`exempt (R6): ${exempt.condition} stands for ${R6_EFFECT_CONDS[exempt.condition]}, not ${JSON.stringify(cond)}${fromF4 ? ' in F-4' : ''}`)
    }
  }
  const isExempt = exemptFlags(faulted.length, exempt)
  const mf = mean(faulted)
  const mb = mean(base)
  let name: string
  let atMost = false
  let measure: (f: number, b: number, what: string) => number
  let required: number
  let floor: number
  /** Ratio-based (needs a non-zero baseline); false only for p.p. */
  const relative = !('ppAtLeast' in cond)
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
  const perSeed = faulted.map((f, i) => {
    const b = base[i]!
    const value = isExempt[i] && relative && !(b > 0) ? Number.NaN : measure(f, b, `seed ${names[i]!}`)
    return { seed: names[i]!, value }
  })
  const failingSeeds = perSeed.filter((s, i) => !isExempt[i] && (atMost ? !(s.value <= floor) : !(s.value >= floor)))
  const exemptSeeds = names.filter((_, i) => isExempt[i])
  return verdict(name, { mean: measure(mf, mb, 'mean over seeds'), required, perSeed, floor, failingSeeds, exemptSeeds }, atMost, true)
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
  const result = { mean: measure(mean(faulted), mean(reference), 'mean over seeds'), required, perSeed, floor: required, failingSeeds: [], exemptSeeds: [] }
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
  /**
   * R6 (PRD Emenda 3): built by `r6Exemption` with condition `f4Pair`, only for the fixed pair
   * of row 3 (`R6_F4_PAIR`). An exempt seed is left out of the per-seed floor of E3/E4 but still
   * enters the means (E2 and the mean of E3).
   */
  exempt?: R6Exemption
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
  const ex = options.exempt
  if (ex !== undefined) {
    if (ex.condition !== 'f4Pair') throw new Error(`${tag}: exempt (R6) must be built for f4Pair, got ${ex.condition}`)
    if (component !== R6_F4_PAIR.component || metric !== R6_F4_PAIR.metric) {
      throw new Error(`${tag}: exempt (R6) only applies to the F-4 pair of row 3 (${R6_F4_PAIR.component}, ${R6_F4_PAIR.metric})`)
    }
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
    result = effectWith(f, b, { ppAtLeast: F4_ERROR_PP }, options.seeds, ex, true)
  } else if (mean(f) >= baselineMean) {
    direction = 'rise'
    result = effectWith(f, b, { riseAtLeast: F4_DEVIATION }, options.seeds, ex, true)
  } else {
    direction = 'drop'
    result = effectWith(f, b, { ratioAtMost: 1 - F4_DEVIATION }, options.seeds, ex, true)
  }
  if (!result.pass) throw new Error(`${tag}: E3/E4, ${result.message}`)
  return { pair, baselineMean, direction, result }
}
