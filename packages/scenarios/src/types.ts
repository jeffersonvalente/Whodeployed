/**
 * Whodeployed scenarios — shared contract (types only, no runtime code).
 *
 * Owner: Architect (ADR-014). Content and UI engineers implement against this file and never
 * edit it; a needed change is an issue for the Architect.
 *
 * Why here and not in packages/engine/src/types.ts: the engine must not know scenario concepts
 * (FASE-2 EN-5: no referencePath, rootCause, teaches or trap in packages/engine/src; SPEC §6
 * "the UI does not know YAML"). The engine types used below are imported from its public entry.
 *
 * Sections:
 *   1. Scenario as loaded from YAML (SPEC §7, ADR-014).
 *   2. Question patterns used by `review` (ADR-014).
 *   3. Repertoire per level (FASE-2 "Repertório do nível", ADR-014).
 *   4. Loader and errors (FASE-2 CN-4, ADR-014).
 *   4b. Effective mitigation check (ADR-013 §4, ADR-014).
 *   5. Data bundle consumed by the prototype (ADR-014, ADR-015).
 */
import type {
  Action,
  EngineErrorInfo,
  Fault,
  NoiseEvent,
  Question,
  QuestionKind,
  SimulationConfig,
  SupportedActionKind,
} from '@whodeployed/engine'

// ---------------------------------------------------------------------------
// 1. Scenario (SPEC §7)
// ---------------------------------------------------------------------------

/** SPEC §5 levels. Phase 2 has a repertoire only for 'junior' and 'pleno' (section 3). */
export type Level = 'junior' | 'pleno' | 'senior'

export interface AlertSpec {
  /** Tick at which the alert fires; the session starts here (FASE-2 PR-5). Integer >= 0. */
  tick: number
  /** Monitoring-style English text shown to the player at the start of the session. */
  text: string
}

/**
 * One step of `referencePath`, as written in YAML (`{ ask: <kind>, ...params }` or
 * `{ act: <kind>, target? }`) and normalized by the loader. Used only by the review and by
 * tests (SPEC §12 glossary: never shown before the end).
 */
export type ReferenceStep =
  | { readonly type: 'ask'; readonly question: Question }
  | { readonly type: 'act'; readonly action: Action }

export interface ReviewSpec {
  /** Questions that are redundant in this incident (FASE-2 PR-11 sentence 1). */
  redundant: readonly QuestionPattern[]
  /** Free English text naming the signal that already contained the answer. */
  keySignal: string
  /**
   * The question whose answer contains `keySignal` (FASE-2 PR-11 sentence 2). YAML field
   * `review.keySignalAsk`, same pattern syntax as `redundant` (ADR-014). Required in phase 2.
   */
  keySignalAsk: QuestionPattern
}

export interface Scenario {
  /** `NN-kebab-slug` for campaign scenarios; `test-<slug>` for test incidents (FASE-2 CN-3). */
  id: string
  title: string
  level: Level
  teaches: string
  trap: string
  seed: string
  /** Name of the system; phase 2 knows only 'default-shop' (engine `defaultShop`). */
  system: string
  /** Resolved by the engine's resolveFaults (catalog defaults filled in). Exactly 1 in phase 2 (CN-2). */
  faults: readonly Fault[]
  noise: readonly NoiseEvent[]
  alert: AlertSpec
  /** Accumulated impact (ADR-013) at which the incident becomes severe. Integer >= 1. */
  impactBudget: number
  referencePath: readonly ReferenceStep[]
  rootCause: string
  review: ReviewSpec
  /** true for test incidents (id starts with 'test-'); they never appear in the scenario list (PR-4). */
  testIncident: boolean
}

// ---------------------------------------------------------------------------
// 2. Question patterns (ADR-014)
// ---------------------------------------------------------------------------

/**
 * Matches every question of `kind` (and, when present, of `service`), whatever its other
 * parameters. YAML syntax: a string `"<kind>"` or `"<kind> <service>"`, e.g. `"dashboard gateway"`,
 * `"whatChanged"`. The loader rejects a pattern with an unknown kind or component (CN-4).
 */
export interface QuestionPattern {
  kind: QuestionKind
  service?: string
}

/** Pure: does `question` match `pattern`? */
export type MatchesPattern = (pattern: QuestionPattern, question: Question) => boolean

// ---------------------------------------------------------------------------
// 3. Repertoire (FASE-2 "Repertório do nível"; the single place required by PR-6 is
//    packages/scenarios/src/repertoire.ts, ADR-014)
// ---------------------------------------------------------------------------

/** Levels with a repertoire in phase 2. */
export type PlayableLevel = Extract<Level, 'junior' | 'pleno'>

export interface Repertoire {
  /** `dashboard` of any component. */
  readonly dashboard: boolean
  /** `logs` of any component. `window`: fixed number of ticks, or 'free' (integer >= 1 chosen by the player). */
  readonly logs: { readonly window: number | 'free'; readonly filter: boolean }
  /** `trace` with these percentiles (empty = not offered). */
  readonly tracePercentiles: readonly (50 | 95 | 99)[]
  /** `whatChanged`, window chosen by the player (integer >= 1), when true. */
  readonly whatChanged: boolean
  /** `compare` with these `by` values (empty = not offered). Phase 2 never offers 'lastWeek'. */
  readonly compareBy: readonly 'instance'[]
  /** Actions offered, all with a target among the 9 components. */
  readonly actions: readonly SupportedActionKind[]
}

export type RepertoireTable = { readonly [L in PlayableLevel]: Repertoire }

/** Pure: is this question or action inside the repertoire of `level`? (CN-5, PR-6). */
export type InRepertoire = (level: PlayableLevel, step: ReferenceStep) => boolean

// ---------------------------------------------------------------------------
// 4. Loader and errors (CN-4)
// ---------------------------------------------------------------------------

export interface ScenarioErrorInfo {
  name: 'ScenarioError'
  /** File name as given to the loader, e.g. 'scenarios/03-pool.yaml'. */
  file: string
  /** Path of the offending field, e.g. 'alert.tick', 'faults[0].params.poolSize', 'referencePath[2]'. */
  field: string
  /** English; names `file` and `field`. When `engine` is set, it contains engine.message verbatim. */
  message: string
  /** The EngineError that caused it (invalid kind, target, param, noise...), propagated as is (F-7). */
  engine?: EngineErrorInfo
}

/** Parses one YAML document. Throws ScenarioError (class in src/errors.ts implementing ScenarioErrorInfo). */
export type ParseScenario = (source: string, file: string) => Scenario

/** Builds the engine input of a scenario: system by name, seed, faults, noise (no scenario text). */
export type ToSimulationConfig = (scenario: Scenario) => SimulationConfig

// ---------------------------------------------------------------------------
// 4b. Effective mitigation (ADR-013 §4) — one implementation, shared by the content tests
//     (CN-3, CN-5, CN-9f) and by the prototype (PR-11 sentence 3, PR-15 R-4)
// ---------------------------------------------------------------------------

/** A step that moves the clock: a question or action of a path, or a player's wait (1 tick). */
export type PlayStep = ReferenceStep | { readonly type: 'wait' }

export interface MitigationCheck {
  /** Index of the action in `steps`. */
  step: number
  /** world.tick when the action was applied (its effect starts at tick + 1, ADR-012). */
  tick: number
  /** No impacted tick in [tick + 4, tick + 33] when simulating on with no other action (ADR-013 §4). */
  effective: boolean
  /** Accumulated impact in [0, tick] (ADR-013 §4). */
  impactAtAction: number
}

/**
 * Replays `steps` on a fresh simulation of `scenario`, starting at `alert.tick`: a question
 * advances by its tickCost, an action by its tickCost, a wait by 1, never past tick 360. Returns
 * one MitigationCheck per action, in order. Pure and deterministic (same input => same output).
 */
export type CheckMitigations = (scenario: Scenario, steps: readonly PlayStep[]) => readonly MitigationCheck[]

// ---------------------------------------------------------------------------
// 5. Data bundle (`@whodeployed/scenarios/data`, generated at build time from the YAML files)
// ---------------------------------------------------------------------------

export interface ScenarioBundle {
  /** Campaign scenarios of this phase, ordered by id ('01-…', '03-…', '05-…'). */
  readonly campaign: readonly Scenario[]
  /** Test incidents (TA, TB), ordered by id. Opened only through the prototype's test mode. */
  readonly testIncidents: readonly Scenario[]
}
