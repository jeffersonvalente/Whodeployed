/**
 * Post-incident review: the 3 sentences of PR-11 (SPEC §5), built from the log of an ended
 * session, the scenario's `review` block and the reference impact. Pure and deterministic (DET):
 * no clock, no randomness, no DOM; the same input gives the same sentences.
 *
 * The rule of effective mitigation lives in one place, `checkMitigations` of
 * @whodeployed/scenarios (ADR-013 §4, ADR-014 §3.1), and the question patterns in its
 * `matchesPattern`. Both are injected (`ReviewDeps`), so this module adds no simulation logic and
 * runs against mocks until T2.10/T2.13 ship the real functions.
 *
 * Every English text of the review is in `REVIEW_TEXT` below, the single place to rewrite when the
 * Director decides the narrative tone (SPEC §12, open). The current wording is neutral and factual.
 * No grade, star, percentage or ranking (PR-11), no hint or explanation of a practice (PR-18).
 */
import type { Action, ComponentName, Question } from '@whodeployed/engine'
import type {
  CheckMitigations,
  EngineRuntime,
  MatchesPattern,
  PlayStep,
  QuestionPattern,
  Scenario,
} from '@whodeployed/scenarios'
import type { BuildReview, ReviewSentences, SessionLogV1, SessionStep } from './types'

// ---------------------------------------------------------------------------
// Texts (the only place; see the module comment)
// ---------------------------------------------------------------------------

export const REVIEW_TEXT = {
  /** Sentence 1, no redundant question (PR-11 wording). */
  noRedundant: (): string => 'No redundant questions.',
  /** Sentence 1, `items` already formatted with `redundantItem`. */
  redundant: (items: readonly string[]): string => `Redundant questions: ${items.join(', ')}.`,
  redundantItem: (question: string, tick: number, repeat: boolean): string =>
    `${question} at tick ${tick}${repeat ? ' (identical repeat)' : ''}`,
  /** Sentence 2, the player asked the question whose answer held the key signal. */
  keySignalAsked: (pattern: string, tick: number, keySignal: string): string =>
    `You asked ${pattern} at tick ${tick}; its answer contained the key signal: ${keySignal}.`,
  keySignalNotAsked: (pattern: string, keySignal: string): string =>
    `You did not ask ${pattern}; its answer contained the key signal: ${keySignal}.`,
  /** Sentence 3, with an effective mitigation of the player. */
  impactMitigated: (action: string, tick: number, impact: number, reference: number): string =>
    `Accumulated impact at your effective mitigation (${action} at tick ${tick}): ${impact}; at the reference path's mitigation: ${reference}.`,
  /** Sentence 3, without one: impact at the end of the session. */
  impactNotMitigated: (tick: number, impact: number, reference: number): string =>
    `No effective mitigation; accumulated impact at the end (tick ${tick}): ${impact}; at the reference path's mitigation: ${reference}.`,
} as const

// ---------------------------------------------------------------------------
// Injected scenario functions
// ---------------------------------------------------------------------------

export interface ReviewDeps {
  /** `checkMitigations` of @whodeployed/scenarios (T2.13), or a mock in tests. */
  checkMitigations: CheckMitigations
  /** `matchesPattern` of @whodeployed/scenarios (T2.10/T2.11), or a mock in tests. */
  matchesPattern: MatchesPattern
  engine: EngineRuntime
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AskStep = Extract<SessionStep, { type: 'ask' }>

/** JSON with object keys sorted, so two questions compare by value whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Same syntax as the YAML patterns (ADR-014): `<kind> <service>` plus the other parameters. */
export function formatQuestion(question: Question): string {
  switch (question.kind) {
    case 'dashboard':
      return `dashboard ${question.service}`
    case 'logs': {
      const filter = Object.entries(question.filter ?? {})
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
      return filter.length === 0 ? `logs ${question.service}` : `logs ${question.service} filter ${filter.join(' ')}`
    }
    case 'trace':
      return `trace ${question.service} p${question.percentile}`
    case 'whatChanged':
      return 'whatChanged'
    case 'compare':
      return `compare ${question.service} ${question.metric} by ${question.by}`
    case 'askNpc':
      return `askNpc ${question.role}`
  }
}

export function formatPattern(pattern: QuestionPattern): string {
  return pattern.service === undefined ? pattern.kind : `${pattern.kind} ${pattern.service}`
}

function formatAction(action: Action): string {
  const target: ComponentName | undefined = action.target
  return target === undefined ? action.kind : `${action.kind} ${target}`
}

function withoutFinalPeriod(text: string): string {
  return text.trim().replace(/\.+$/, '')
}

/**
 * The steps that move the clock, in order, as `checkMitigations` replays them: questions, actions
 * and waits (hypothesis, discard and end cost 0). `seqs[i]` is the log seq of `steps[i]`.
 */
export function playStepsOf(log: SessionLogV1): { steps: PlayStep[]; seqs: number[] } {
  const steps: PlayStep[] = []
  const seqs: number[] = []
  for (const step of log.steps) {
    if (step.type === 'ask') steps.push({ type: 'ask', question: step.question })
    else if (step.type === 'act') steps.push({ type: 'act', action: step.action })
    else if (step.type === 'wait') steps.push({ type: 'wait' })
    else continue
    seqs.push(step.seq)
  }
  return { steps, seqs }
}

/**
 * Accumulated impact at the first effective mitigation of the scenario's referencePath replayed
 * from alert.tick (the `referenceImpact` of BuildReview). Throws when the path has none, which the
 * content tests (CN-3) rule out for every scenario.
 */
export function referenceImpactOf(scenario: Scenario, deps: ReviewDeps): number {
  const check = deps.checkMitigations(scenario, scenario.referencePath, deps.engine).find((c) => c.effective)
  if (check === undefined) throw new Error(`scenario ${scenario.id}: referencePath has no effective mitigation`)
  return check.impactAtAction
}

// ---------------------------------------------------------------------------
// The 3 sentences
// ---------------------------------------------------------------------------

function redundantSentence(asks: readonly AskStep[], scenario: Scenario, matches: MatchesPattern): string {
  const seen = new Set<string>()
  const items: string[] = []
  for (const step of asks) {
    const key = canonical(step.question)
    const repeat = seen.has(key)
    seen.add(key)
    const listed = scenario.review.redundant.some((pattern) => matches(pattern, step.question))
    if (repeat || listed) items.push(REVIEW_TEXT.redundantItem(formatQuestion(step.question), step.tickBefore, repeat))
  }
  return items.length === 0 ? REVIEW_TEXT.noRedundant() : REVIEW_TEXT.redundant(items)
}

function keySignalSentence(asks: readonly AskStep[], scenario: Scenario, matches: MatchesPattern): string {
  const { keySignalAsk, keySignal } = scenario.review
  const pattern = formatPattern(keySignalAsk)
  const signal = withoutFinalPeriod(keySignal)
  const first = asks.find((step) => matches(keySignalAsk, step.question))
  return first === undefined
    ? REVIEW_TEXT.keySignalNotAsked(pattern, signal)
    : REVIEW_TEXT.keySignalAsked(pattern, first.tickBefore, signal)
}

function impactSentence(log: SessionLogV1, scenario: Scenario, referenceImpact: number, deps: ReviewDeps): string {
  const { steps, seqs } = playStepsOf(log)
  const checks = deps.checkMitigations(scenario, steps, deps.engine)
  const effective = checks.find((c) => c.effective)
  if (effective !== undefined) {
    const seq = seqs[effective.step]
    const step = log.steps.find((s) => s.seq === seq)
    if (step === undefined || step.type !== 'act') {
      throw new Error(`checkMitigations returned step ${effective.step}, which is not an action of the log`)
    }
    return REVIEW_TEXT.impactMitigated(formatAction(step.action), effective.tick, effective.impactAtAction, referenceImpact)
  }
  const last = log.steps[log.steps.length - 1] as SessionStep
  return REVIEW_TEXT.impactNotMitigated(last.tickBefore + last.tickCost, last.impactAfter, referenceImpact)
}

/**
 * Binds the injected scenario functions and returns the pure BuildReview of the contract
 * (src/session/types.ts). The log must be of an ended session (last step `end`).
 */
export function createBuildReview(deps: ReviewDeps): BuildReview {
  return (log, scenario, referenceImpact): ReviewSentences => {
    const last = log.steps[log.steps.length - 1]
    if (last === undefined || last.type !== 'end') throw new Error('buildReview needs the log of an ended session')
    if (log.scenario.id !== scenario.id) {
      throw new Error(`log of scenario ${log.scenario.id} reviewed against scenario ${scenario.id}`)
    }
    const asks = log.steps.filter((step): step is AskStep => step.type === 'ask')
    return [
      redundantSentence(asks, scenario, deps.matchesPattern),
      keySignalSentence(asks, scenario, deps.matchesPattern),
      impactSentence(log, scenario, referenceImpact, deps),
    ]
  }
}
