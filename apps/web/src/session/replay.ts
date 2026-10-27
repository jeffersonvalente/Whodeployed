/**
 * Replay of a session log against its scenario (FASE-2 PR-14, PR-17, I24-6; ADR-016 §3).
 *
 * The replay trusts only the log, the scenario and the engine (H9): it opens a new session of the
 * scenario with the session core, feeds it the inputs of the log one step at a time and checks
 * that each step the core records is the step the log holds: `tickBefore`, the answer (or action
 * result), `tickCost` (already capped at tick 360 by the core) and `impactAfter`. The first
 * divergence is returned as `{ ok: false, seq, field, message }`.
 *
 * Equality is always on the canonical JSON of ADR-016 §2 (`serializeLog`): `undefined` is the same
 * as an absent key (I24-6), and every recorded step is serialized the moment it is recorded, so
 * no later mutation of a step object can change what is compared (QA note on PR #95). Identity is
 * never compared. `wallMs` is the only field ignored.
 *
 * Pure apart from the engine: no clock (`wallClock` is a constant), no randomness, no DOM, no
 * Node API. The CLI is `scripts/replay.ts`.
 *
 * Session binding: the contract's `createSession` binding in session.ts is being decided by the
 * Architect; until then this module builds it with `makeCreateSession` and the real
 * `inRepertoire` / `toSimulationConfig` of @whodeployed/scenarios, which is the same one line.
 */
import { inRepertoire, toSimulationConfig } from '@whodeployed/scenarios'
import type { EngineRuntime, Scenario } from '@whodeployed/scenarios'
import { LOG_FORMAT, LOG_VERSION, logsEqual, serializeLog } from './log'
import { makeCreateSession } from './session'
import type { ReplayResult, ReviewSentences, Session, SessionLogV1, SessionStep } from './types'

/** What a replay needs besides the log and the scenario. */
export interface ReplayDeps {
  /** Built from @whodeployed/engine's public entry (src/engine-runtime.ts). */
  engine: EngineRuntime
  /**
   * Recomputes the 3 review sentences from the replayed log of an ended session (ADR-016 §3).
   * Bound by the caller to `createBuildReview` with the real `checkMitigations` (T2.13). When it
   * is absent and the log carries a `review`, the replay fails on `review` (it never passes what
   * it did not check).
   */
  review?: (log: SessionLogV1, scenario: Scenario) => ReviewSentences
}

type Field = Extract<ReplayResult, { ok: false }>['field']
type Plain = { [key: string]: unknown }

const createSession = makeCreateSession({ inRepertoire, toSimulationConfig })

function fail(seq: number, field: Field, message: string): ReplayResult {
  return { ok: false, seq, field, message }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Canonical object of one step (ADR-016 §2), with `wallMs` zeroed, taken through `serializeLog` so
 * the replay uses the exact serialization of the exported file.
 */
function canonicalStep(log: SessionLogV1, step: SessionStep): Plain {
  const single: SessionLogV1 = { ...log, steps: [{ ...step, wallMs: 0 }], finalHypothesis: null, review: null }
  const parsed = JSON.parse(serializeLog(single)) as { steps: Plain[] }
  return parsed.steps[0] as Plain
}

function json(value: unknown): string {
  return value === undefined ? 'absent' : JSON.stringify(value)
}

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Feeds one input step of the log to the session (wait/ask/act/notebook). */
function feed(session: Session, step: SessionStep): void {
  switch (step.type) {
    case 'ask':
      session.ask(step.question)
      return
    case 'act':
      session.act(step.action)
      return
    case 'wait':
      session.wait()
      return
    case 'hypothesis':
      session.hypothesis(step.component, step.text)
      return
    case 'discard':
      session.discard(step.hypothesisSeq, step.citedSeqs, step.text)
      return
    case 'end':
      session.end(step.final)
      return
    default:
      throw new Error(`unknown step type ${json((step as { type?: unknown }).type)}`)
  }
}

/**
 * Compares the step the core recorded with the step of the log, field by field in the order of
 * PR-14, then as a whole (any other field, e.g. a hypothesis text or the end reason).
 */
function compareStep(expected: Plain, actual: Plain, seq: number): ReplayResult | null {
  if (json(expected['tickBefore']) !== json(actual['tickBefore'])) {
    return fail(seq, 'tickBefore', `log has tickBefore ${json(expected['tickBefore'])}, replay is at tick ${json(actual['tickBefore'])}`)
  }
  if (expected['type'] === 'ask') {
    if (json(expected['question']) !== json(actual['question'])) {
      return fail(seq, 'answer', `question differs: log ${json(expected['question'])}, engine ${json(actual['question'])}`)
    }
    if (json(expected['answer']) !== json(actual['answer'])) {
      return fail(seq, 'answer', 'the engine answer differs from the answer in the log (canonical JSON)')
    }
  }
  if (expected['type'] === 'act') {
    if (json(expected['action']) !== json(actual['action'])) {
      return fail(seq, 'answer', `action differs: log ${json(expected['action'])}, engine ${json(actual['action'])}`)
    }
    if (json(expected['result']) !== json(actual['result'])) {
      return fail(seq, 'answer', `action result differs: log ${json(expected['result'])}, engine ${json(actual['result'])}`)
    }
  }
  if (json(expected['tickCost']) !== json(actual['tickCost'])) {
    return fail(seq, 'tickCost', `log has tickCost ${json(expected['tickCost'])}, replay paid ${json(actual['tickCost'])}`)
  }
  if (json(expected['impactAfter']) !== json(actual['impactAfter'])) {
    return fail(seq, 'impactAfter', `log has impactAfter ${json(expected['impactAfter'])}, replay has ${json(actual['impactAfter'])}`)
  }
  if (json(expected) !== json(actual)) {
    return fail(seq, 'format', `step differs from the replayed step: log ${json(expected)}, replay ${json(actual)}`)
  }
  return null
}

/**
 * Replays `log` against `scenario` (ADR-016 §3). Returns `{ ok: true, steps }` when every step,
 * the final hypothesis and the review match; otherwise the first divergence. `seq` 0 means the
 * envelope (format, version, scenario).
 */
export function replayLog(log: SessionLogV1, scenario: Scenario, deps: ReplayDeps): ReplayResult {
  const envelope = log as unknown as Plain
  if (envelope['format'] !== LOG_FORMAT || envelope['version'] !== LOG_VERSION) {
    return fail(0, 'format', `unknown log format/version: ${json(envelope['format'])} v${json(envelope['version'])}`)
  }
  if (!isPlain(log.scenario) || log.scenario.id !== scenario.id || log.scenario.seed !== scenario.seed) {
    return fail(0, 'format', `log of scenario ${json(log.scenario)} replayed against ${json({ id: scenario.id, seed: scenario.seed })}`)
  }
  if (!isPlain(log.engine) || typeof log.engine.version !== 'string' || !isPlain(log.build) || typeof log.build.sha !== 'string') {
    return fail(0, 'format', 'engine must be { version } and build must be { sha }')
  }
  if (!Array.isArray(log.steps) || !log.steps.every(isPlain)) return fail(0, 'format', 'steps must be an array of objects')

  let session: Session
  try {
    session = createSession(scenario, {
      engine: deps.engine,
      wallClock: () => 0,
      engineVersion: log.engine.version,
      buildSha: log.build.sha,
    })
  } catch (error) {
    return fail(0, 'format', `cannot open a session of ${scenario.id}: ${errorMessage(error)}`)
  }

  for (let i = 0; i < log.steps.length; i += 1) {
    const step = log.steps[i] as SessionStep
    const seq = i + 1
    if (step.seq !== seq) return fail(seq, 'format', `step ${seq} has seq ${json(step.seq)}`)

    // The core records the tick-360 `end` by itself, right after the step that reached tick 360;
    // that `end` step of the log is compared, never fed.
    const recordedBefore = session.state.steps.length
    if (recordedBefore < seq) {
      try {
        feed(session, step)
      } catch (error) {
        const field: Field = step.type === 'ask' || step.type === 'act' ? 'answer' : 'format'
        return fail(seq, field, `the session refused the ${json(step.type)} step: ${errorMessage(error)}`)
      }
    }
    const recorded = session.state.steps[i]
    if (recorded === undefined) return fail(seq, 'format', `the session recorded no step for ${json(step.type)}`)
    const divergence = compareStep(canonicalStep(log, step), canonicalStep(log, recorded), seq)
    if (divergence !== null) return divergence
  }

  const state = session.state
  if (state.steps.length > log.steps.length) {
    const extra = state.steps[log.steps.length] as SessionStep
    return fail(extra.seq, 'format', `the log ends before the replayed ${json(extra.type)} step at tick ${extra.tickBefore}`)
  }

  const replayed = session.log()
  const lastSeq = log.steps.length
  if (json(log.finalHypothesis) !== json(replayed.finalHypothesis)) {
    // Compared on the canonical serialization of the whole log right below; reported here with
    // a precise message.
    return fail(lastSeq, 'format', `finalHypothesis differs: log ${json(log.finalHypothesis)}, replay ${json(replayed.finalHypothesis)}`)
  }

  let review: ReviewSentences | null = null
  if (log.review !== null) {
    if (!state.ended) return fail(lastSeq, 'review', 'the log has a review but the session has not ended')
    if (deps.review === undefined) {
      return fail(lastSeq, 'review', 'the log has a review and no review builder was given, so it cannot be checked')
    }
    try {
      review = deps.review(replayed, scenario)
    } catch (error) {
      return fail(lastSeq, 'review', `cannot rebuild the review: ${errorMessage(error)}`)
    }
    if (json(log.review) !== json(review)) {
      return fail(lastSeq, 'review', `review differs: log ${json(log.review)}, replay ${json(review)}`)
    }
  }

  // Safety net: the whole log, on the canonical JSON without wallMs (ADR-016 §2).
  if (!logsEqual(log, { ...replayed, review })) {
    return fail(0, 'format', 'the log differs from the replayed log outside the steps (canonical JSON)')
  }
  return { ok: true, steps: log.steps.length }
}
