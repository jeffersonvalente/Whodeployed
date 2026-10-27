/**
 * Prototype session core — shared contract (types only, no runtime code).
 *
 * Owner: Architect (ADR-015, ADR-016). UI engineers implement against this file and never edit
 * it; a needed change is an issue for the Architect. The session core is plain TypeScript (no DOM,
 * no React): the same code runs in the browser and in the Node scripts (replay PR-14, results PR-15).
 *
 * Sections:
 *   1. Session log v1 — the exported JSON (ADR-016, PR-13).
 *   2. Session core API (ADR-015; PR-5, PR-8, PR-9, PR-10, PR-12).
 *   3. Review, replay and results (PR-11, PR-14, PR-15).
 */
import type {
  AccumulatedImpact,
  Action,
  ActionResult,
  Answer,
  ComponentName,
  CreateSimulation,
  Question,
} from '@whodeployed/engine'
import type { PlayableLevel, Scenario, ToSimulationConfig } from '@whodeployed/scenarios'

// ---------------------------------------------------------------------------
// 1. Session log v1 (ADR-016)
// ---------------------------------------------------------------------------

/** Last tick of a session: reaching it ends the session (PR-8). */
export type SessionTickLimit = 360

export type FinalHypothesis =
  | { kind: 'active'; hypothesisSeq: number }
  | { kind: 'new'; component: ComponentName; text: string }
  | { kind: 'unknown' }

interface StepBase {
  /** 1-based, consecutive. Discards cite answers by this number (PR-9). */
  seq: number
  /** World tick before the step. */
  tickBefore: number
  /** Ticks the step advanced the clock: Answer.tickCost, ActionResult.tickCost, 1 for wait, 0 otherwise. */
  tickCost: number
  /** Accumulated impact (ADR-013) after the step, i.e. at tick tickBefore + tickCost. */
  impactAfter: number
  /** Wall-clock ms since the session started. The only non-deterministic field (ignored by PR-12 and replay). */
  wallMs: number
}

export type SessionStep =
  | (StepBase & { type: 'ask'; question: Question; answer: Answer })
  | (StepBase & { type: 'act'; action: Action; result: ActionResult })
  | (StepBase & { type: 'wait' })
  | (StepBase & { type: 'hypothesis'; component: ComponentName; text: string })
  | (StepBase & { type: 'discard'; hypothesisSeq: number; citedSeqs: number[]; text?: string })
  | (StepBase & { type: 'end'; final: FinalHypothesis; reason: 'player' | 'tickLimit' })

export type SessionStepType = SessionStep['type']

/** The 3 review sentences (PR-11). */
export type ReviewSentences = readonly [string, string, string]

/**
 * Exported JSON (PR-13). Keys are serialized in the order declared here; no player name, id,
 * absolute date or user agent. `finalHypothesis` and `review` are null until the session ends
 * (export is allowed at any time).
 */
export interface SessionLogV1 {
  format: 'whodeployed-session-log'
  version: 1
  scenario: { id: string; seed: string }
  /** `version` of packages/engine/package.json at build time. */
  engine: { version: string }
  /** Git commit SHA of the prototype build (40 hex chars, or 'unknown' in a local build without git). */
  build: { sha: string }
  steps: SessionStep[]
  finalHypothesis: FinalHypothesis | null
  review: ReviewSentences | null
}

// ---------------------------------------------------------------------------
// 2. Session core API (ADR-015)
// ---------------------------------------------------------------------------

export interface SessionDeps {
  createSimulation: CreateSimulation
  accumulatedImpact: AccumulatedImpact
  toSimulationConfig: ToSimulationConfig
  /** Wall clock in ms (performance.now in the browser, a fake in tests). Only feeds `wallMs`. */
  wallClock: () => number
  engineVersion: string
  buildSha: string
}

export interface HypothesisState {
  seq: number
  component: ComponentName
  text: string
  /** seq of the discard step, when discarded. */
  discardedBy?: number
}

export interface SessionState {
  readonly scenarioId: string
  readonly level: PlayableLevel
  readonly tick: number
  readonly impact: number
  readonly impactBudget: number
  /** impact >= impactBudget (PR-8, shown as SEVERE). */
  readonly severe: boolean
  readonly ended: boolean
  readonly steps: readonly SessionStep[]
  readonly hypotheses: readonly HypothesisState[]
}

/**
 * One session = one play of one scenario, from the alert to the review. Every method throws
 * SessionError (a plain Error subclass in src/session/) when the session has ended, when a
 * question or action is outside the repertoire of the scenario's level (PR-6), or when a discard
 * cites no previous answer (PR-9). Engine errors (EngineError) are rethrown unchanged.
 */
export interface Session {
  readonly state: SessionState
  ask(question: Question): Answer
  act(action: Action): ActionResult
  /** Advances 1 tick (PR-8). */
  wait(): void
  /** Returns the seq of the new hypothesis. `text` must be non-empty after trim. */
  hypothesis(component: ComponentName, text: string): number
  discard(hypothesisSeq: number, citedSeqs: readonly number[], text?: string): void
  end(final: FinalHypothesis): void
  /** Snapshot of the log at this moment (PR-13). */
  log(): SessionLogV1
}

/** Advances the simulation to `scenario.alert.tick` before returning (PR-5). */
export type CreateSession = (scenario: Scenario, deps: SessionDeps) => Session

// ---------------------------------------------------------------------------
// 3. Review, replay and results
// ---------------------------------------------------------------------------

/**
 * Builds the 3 sentences of PR-11 from the log of an ended session and the scenario. Pure.
 * `referenceImpact` = accumulated impact at the effective mitigation of the scenario's
 * referencePath replayed from alert.tick (computed by the caller with the engine).
 */
export type BuildReview = (log: SessionLogV1, scenario: Scenario, referenceImpact: number) => ReviewSentences

/** Result of replaying a log against its scenario (PR-14). */
export type ReplayResult =
  | { ok: true; steps: number }
  | { ok: false; seq: number; field: 'answer' | 'tickCost' | 'impactAfter' | 'tickBefore' | 'review' | 'format'; message: string }

/** The 4 outcomes of SPEC §2, as defined in the FASE-2 Roteiro (R-1..R-4). */
export type OutcomeId = 'R-1' | 'R-2' | 'R-3' | 'R-4'

export interface OutcomeReport {
  id: OutcomeId
  pre: boolean
  post: boolean
  /** pre === false && post === true. */
  changed: boolean
  /** R-2 only: true when the log has no notebook text before the 2nd signal question ("justification: check research note"). */
  needsResearchNote?: boolean
}
