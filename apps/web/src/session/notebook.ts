/**
 * Notebook core (T2.23; PR-9, PR-10, DET; ADR-015 §5, ADR-016).
 *
 * Plain TypeScript, no DOM, no React, no clock, no randomness. Every function is pure: it reads
 * the session steps so far and returns either the validated payload of the next step or a
 * rejection with a code. It never throws and never mutates its inputs; the session core
 * (session.ts) turns a rejection into a SessionError and appends the payload as a step with
 * `tickCost: 0` (writing, discarding and reading cost no ticks, ADR-015 §5).
 *
 * The notebook never judges a hypothesis (SPEC §3 via the Eng. UI brief): it only checks the
 * shape PR-9 and PR-10 require. Comparing with the reference path is the review's job (PR-11).
 */
import type { ComponentName, SystemDefinition } from '@whodeployed/engine'
import type { FinalHypothesis, HypothesisState, SessionStep } from './types'

export type NotebookErrorCode =
  /** The session already has an `end` step: after the end only review and export remain (PR-10). */
  | 'session_ended'
  /** The component is not one of the scenario system's 9 components (PR-9). */
  | 'unknown_component'
  /** Hypothesis or new final hypothesis text is empty after trim (PR-9, PR-10). */
  | 'empty_text'
  /** The seq is not the seq of a hypothesis step of this session. */
  | 'unknown_hypothesis'
  /** The hypothesis was already discarded (it cannot be discarded twice nor chosen as final). */
  | 'hypothesis_discarded'
  /** A discard cites no answer (PR-9: "Descartar sem citar resposta não é possível"). */
  | 'no_citation'
  /** A cited seq is not a previous `ask` step (not an integer, a future step, a non-ask step, or repeated). */
  | 'invalid_citation'

export type NotebookRejection = { readonly ok: false; readonly code: NotebookErrorCode; readonly message: string }
export type NotebookResult<T> = { readonly ok: true; readonly value: T } | NotebookRejection

type StepBaseKey = 'seq' | 'tickBefore' | 'tickCost' | 'impactAfter' | 'wallMs'
type PayloadOf<S> = S extends SessionStep ? Omit<S, StepBaseKey> : never

/** The type-specific fields of a notebook step; session.ts adds seq, ticks, impact and wallMs. */
export type HypothesisPayload = PayloadOf<Extract<SessionStep, { type: 'hypothesis' }>>
export type DiscardPayload = PayloadOf<Extract<SessionStep, { type: 'discard' }>>
/** `reason` is fixed to 'player': the tick-limit end (`unknown`, ADR-015 §5) is the session's. */
export type EndPayload = PayloadOf<Extract<SessionStep, { type: 'end' }>>

function reject(code: NotebookErrorCode, message: string): NotebookRejection {
  return { ok: false, code, message }
}

/** The components a hypothesis may name: services then dependencies, in system order (the 9 of SPEC §4). */
export function systemComponents(system: SystemDefinition): readonly ComponentName[] {
  return [...system.services.map((s) => s.name), ...system.deps.map((d) => d.name)]
}

/** Hypotheses of the session in log order, each with `discardedBy` when a discard step targets it. */
export function hypothesesOf(steps: readonly SessionStep[]): HypothesisState[] {
  const list: HypothesisState[] = []
  const bySeq = new Map<number, HypothesisState>()
  for (const step of steps) {
    if (step.type === 'hypothesis') {
      const h: HypothesisState = { seq: step.seq, component: step.component, text: step.text }
      list.push(h)
      bySeq.set(step.seq, h)
    } else if (step.type === 'discard') {
      const h = bySeq.get(step.hypothesisSeq)
      if (h !== undefined && h.discardedBy === undefined) h.discardedBy = step.seq
    }
  }
  return list
}

/** Hypotheses not discarded: the "active" choices of the end screen (PR-10). */
export function activeHypotheses(steps: readonly SessionStep[]): HypothesisState[] {
  return hypothesesOf(steps).filter((h) => h.discardedBy === undefined)
}

function endedRejection(steps: readonly SessionStep[]): NotebookRejection | undefined {
  return steps.some((s) => s.type === 'end')
    ? reject('session_ended', 'The session has ended: only the review and the export are available.')
    : undefined
}

function checkComponentAndText(
  components: readonly ComponentName[],
  component: ComponentName,
  text: string,
): NotebookResult<{ component: ComponentName; text: string }> {
  if (!components.includes(component)) {
    return reject('unknown_component', `'${component}' is not a component of this system (${components.join(', ')}).`)
  }
  const trimmed = text.trim()
  if (trimmed === '') return reject('empty_text', 'The hypothesis text must not be empty.')
  return { ok: true, value: { component, text: trimmed } }
}

function findActive(steps: readonly SessionStep[], hypothesisSeq: number): NotebookRejection | undefined {
  const h = hypothesesOf(steps).find((x) => x.seq === hypothesisSeq)
  if (h === undefined) return reject('unknown_hypothesis', `Step ${hypothesisSeq} is not a hypothesis.`)
  if (h.discardedBy !== undefined) {
    return reject('hypothesis_discarded', `Hypothesis ${hypothesisSeq} was discarded at step ${h.discardedBy}.`)
  }
  return undefined
}

/**
 * PR-9: a hypothesis names one of the system's components and has non-empty free text.
 * The stored text is trimmed.
 */
export function checkHypothesis(
  steps: readonly SessionStep[],
  components: readonly ComponentName[],
  component: ComponentName,
  text: string,
): NotebookResult<HypothesisPayload> {
  const ended = endedRejection(steps)
  if (ended) return ended
  const checked = checkComponentAndText(components, component, text)
  if (!checked.ok) return checked
  return { ok: true, value: { type: 'hypothesis', component: checked.value.component, text: checked.value.text } }
}

/**
 * PR-9: a discard targets an active hypothesis and cites >= 1 previous `ask` step by seq
 * (every step already in `steps` is previous to the discard being written). Optional text is
 * trimmed and omitted when empty (ADR-016). `citedSeqs` keeps the player's order.
 */
export function checkDiscard(
  steps: readonly SessionStep[],
  hypothesisSeq: number,
  citedSeqs: readonly number[],
  text?: string,
): NotebookResult<DiscardPayload> {
  const ended = endedRejection(steps)
  if (ended) return ended
  const notActive = findActive(steps, hypothesisSeq)
  if (notActive) return notActive
  if (citedSeqs.length === 0) {
    return reject('no_citation', 'A discard must cite at least one previous answer by its step number.')
  }
  const askSeqs = new Set(steps.filter((s) => s.type === 'ask').map((s) => s.seq))
  const seen = new Set<number>()
  for (const seq of citedSeqs) {
    if (seen.has(seq)) return reject('invalid_citation', `Step ${seq} is cited more than once.`)
    seen.add(seq)
    if (!askSeqs.has(seq)) {
      return reject('invalid_citation', `Step ${seq} is not a previous answer (only earlier questions can be cited).`)
    }
  }
  const trimmed = text?.trim() ?? ''
  const payload: DiscardPayload =
    trimmed === ''
      ? { type: 'discard', hypothesisSeq, citedSeqs: [...citedSeqs] }
      : { type: 'discard', hypothesisSeq, citedSeqs: [...citedSeqs], text: trimmed }
  return { ok: true, value: payload }
}

/**
 * PR-10: the player ends the incident with an active hypothesis, a new one (component + non-empty
 * text, trimmed) or `unknown`.
 */
export function checkEnd(
  steps: readonly SessionStep[],
  components: readonly ComponentName[],
  final: FinalHypothesis,
): NotebookResult<EndPayload> {
  const ended = endedRejection(steps)
  if (ended) return ended
  switch (final.kind) {
    case 'unknown':
      return { ok: true, value: { type: 'end', final: { kind: 'unknown' }, reason: 'player' } }
    case 'active': {
      const notActive = findActive(steps, final.hypothesisSeq)
      if (notActive) return notActive
      return {
        ok: true,
        value: { type: 'end', final: { kind: 'active', hypothesisSeq: final.hypothesisSeq }, reason: 'player' },
      }
    }
    case 'new': {
      const checked = checkComponentAndText(components, final.component, final.text)
      if (!checked.ok) return checked
      return {
        ok: true,
        value: {
          type: 'end',
          final: { kind: 'new', component: checked.value.component, text: checked.value.text },
          reason: 'player',
        },
      }
    }
  }
}
