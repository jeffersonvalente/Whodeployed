/**
 * Session core: the clock, ask/act/wait, impact and the tick-360 end of one play of one scenario
 * (contract: ./types.ts; ADR-015 §5, ADR-016 §1; FASE-2 PR-5, PR-6, PR-8, PR-12).
 *
 * Plain TypeScript, no DOM and no React: the same code runs in the browser and in the Node
 * scripts (replay, results). Zero simulation logic here: every answer, cost and impact comes from
 * the engine (through the injected EngineRuntime and the engine's Simulation); the repertoire comes
 * from @whodeployed/scenarios (`inRepertoire`, the single table of PR-6). No randomness and no
 * clock (D-4): the only wall-clock read is the injected `deps.wallClock`, which feeds `wallMs` only.
 *
 * Why a factory (`makeCreateSession`) and not a bare `createSession`: `inRepertoire` (T2.11) and
 * `toSimulationConfig` (T2.10) are runtime values of @whodeployed/scenarios that are not on main
 * yet. They are injected as `SessionRules`; once they are exported, the binding is one line:
 *
 *   export const createSession: CreateSession = makeCreateSession({ inRepertoire, toSimulationConfig })
 *
 * Extension points for T2.23 (notebook): `hypothesis`, `discard` and `end` below are the only
 * bodies to fill. Each zero-cost notebook step is appended with `recordFreeStep` (tickCost 0,
 * impactAfter = impact now); `end` calls `finish(final, 'player')`; the hypothesis list is
 * `hypotheses` (exposed in `state`). Nothing else in this file needs to change.
 */
import type { Action, ActionResult, Answer, ComponentName, Question, Simulation } from '@whodeployed/engine'
import type { InRepertoire, PlayableLevel, ReferenceStep, Scenario, ToSimulationConfig } from '@whodeployed/scenarios'
import { SessionError } from './errors'
import type {
  CreateSession,
  FinalHypothesis,
  HypothesisState,
  Session,
  SessionDeps,
  SessionLogV1,
  SessionState,
  SessionStep,
  SessionTickLimit,
} from './types'

/** Last tick of a session; reaching it ends the session (PR-8, ADR-015 §5). */
export const SESSION_TICK_LIMIT: SessionTickLimit = 360

/** The scenario rules the session needs at runtime, from @whodeployed/scenarios (ADR-014). */
export interface SessionRules {
  /** The single repertoire table of PR-6 (packages/scenarios/src/repertoire.ts, T2.11). */
  inRepertoire: InRepertoire
  /** Scenario -> engine input (T2.10). */
  toSimulationConfig: ToSimulationConfig
}

/** Distributes Omit over the step union, so each variant keeps its own fields. */
type StepFields<S> = S extends SessionStep ? Omit<S, 'seq' | 'tickBefore' | 'tickCost' | 'impactAfter' | 'wallMs'> : never

function playableLevel(scenario: Scenario): PlayableLevel {
  const { level } = scenario
  if (level === 'junior' || level === 'pleno') return level
  throw new SessionError(
    'no_repertoire',
    `scenario ${scenario.id} has level '${level}', which has no repertoire in this phase (junior, pleno)`,
  )
}

function startTick(scenario: Scenario): number {
  const { tick } = scenario.alert
  if (Number.isInteger(tick) && tick >= 0 && tick < SESSION_TICK_LIMIT) return tick
  throw new SessionError(
    'invalid_scenario',
    `scenario ${scenario.id}: alert.tick must be an integer in 0..${SESSION_TICK_LIMIT - 1}, got ${String(tick)}`,
  )
}

function describeStep(step: ReferenceStep): string {
  if (step.type === 'ask') return `question '${step.question.kind}'`
  return `action '${step.action.kind}'`
}

function openSession(scenario: Scenario, deps: SessionDeps, rules: SessionRules): Session {
  const level = playableLevel(scenario)
  const alertTick = startTick(scenario)
  const { engine } = deps

  const startedAt = deps.wallClock()
  const sim: Simulation = engine.createSimulation(rules.toSimulationConfig(scenario, engine))
  // createSimulation simulates tick 0; advancing alert.tick more lands exactly on alert.tick (PR-5).
  sim.advance(alertTick)

  const steps: SessionStep[] = []
  const hypotheses: HypothesisState[] = []
  let finalHypothesis: FinalHypothesis | null = null
  let ended = false

  // Impact of each simulated tick never changes (an action takes effect at tick + 1, ADR-012),
  // so the accumulated impact is memoized by tick (ADR-015 §5).
  const impactByTick = new Map<number, number>()
  function impactAt(tick: number): number {
    const known = impactByTick.get(tick)
    if (known !== undefined) return known
    const value = engine.accumulatedImpact(sim.telemetry(), tick)
    impactByTick.set(tick, value)
    return value
  }
  impactAt(alertTick)

  function now(): number {
    return sim.world.tick
  }

  function wallMs(): number {
    return Math.max(0, Math.round(deps.wallClock() - startedAt))
  }

  function assertOpen(): void {
    if (ended) throw new SessionError('session_ended', 'the session has ended; only the review and the export remain')
  }

  function assertInRepertoire(step: ReferenceStep): void {
    if (!rules.inRepertoire(level, step)) {
      throw new SessionError('out_of_repertoire', `${describeStep(step)} is not in the ${level} repertoire`)
    }
  }

  /** Advances the clock by `cost`, never past tick 360 (PR-8). Returns the ticks actually paid. */
  function advanceBy(cost: number): number {
    const paid = Math.min(cost, SESSION_TICK_LIMIT - now())
    sim.advance(paid)
    return paid
  }

  /** Appends a step with the ADR-016 key order: seq, tickBefore, type, fields, tickCost, impactAfter, wallMs. */
  function record(tickBefore: number, tickCost: number, fields: StepFields<SessionStep>): void {
    const step = {
      seq: steps.length + 1,
      tickBefore,
      ...fields,
      tickCost,
      impactAfter: impactAt(tickBefore + tickCost),
      wallMs: wallMs(),
    } as SessionStep
    steps.push(step)
  }

  /** Notebook steps cost 0 ticks (PR-8). Extension point for T2.23. */
  function recordFreeStep(fields: StepFields<SessionStep>): void {
    record(now(), 0, fields)
  }

  /** Ends the session with an `end` step. `reason: 'player'` is wired by T2.23 (`end`). */
  function finish(final: FinalHypothesis, reason: 'player' | 'tickLimit'): void {
    recordFreeStep({ type: 'end', final, reason })
    finalHypothesis = final
    ended = true
  }

  /** The tick 360 ends the session by itself, with no hypothesis (PR-8, ADR-015 §5). */
  function endAtTickLimit(): void {
    if (now() >= SESSION_TICK_LIMIT) finish({ kind: 'unknown' }, 'tickLimit')
  }

  function notImplemented(method: string): never {
    throw new SessionError('not_implemented', `${method} is not available yet`)
  }

  const session: Session = {
    get state(): SessionState {
      const tick = now()
      const impact = impactAt(tick)
      return Object.freeze({
        scenarioId: scenario.id,
        level,
        tick,
        impact,
        impactBudget: scenario.impactBudget,
        severe: impact >= scenario.impactBudget,
        ended,
        steps: Object.freeze([...steps]),
        hypotheses: Object.freeze(hypotheses.map((h) => Object.freeze({ ...h }))),
      })
    },

    ask(question: Question): Answer {
      assertOpen()
      assertInRepertoire({ type: 'ask', question })
      const tickBefore = now()
      // An EngineError (e.g. invalid_filter) propagates unchanged: no tick, no step (ADR-015 §5).
      const answer = sim.ask(question)
      const paid = advanceBy(answer.tickCost)
      // The engine's validated copy, in contract key order (ADR-016 §2).
      record(tickBefore, paid, { type: 'ask', question: answer.question, answer })
      endAtTickLimit()
      return answer
    },

    act(action: Action): ActionResult {
      assertOpen()
      assertInRepertoire({ type: 'act', action })
      const tickBefore = now()
      // EngineError (invalid_action, unknown_target, unsupported_action) propagates unchanged.
      const result = sim.act(action)
      const paid = advanceBy(result.tickCost)
      record(tickBefore, paid, { type: 'act', action: result.action, result })
      endAtTickLimit()
      return result
    },

    wait(): void {
      assertOpen()
      const tickBefore = now()
      const paid = advanceBy(1)
      record(tickBefore, paid, { type: 'wait' })
      endAtTickLimit()
    },

    // T2.23: validate (component among the 9, non-empty text), recordFreeStep({ type: 'hypothesis', ... }),
    // push to `hypotheses`, return the step's seq.
    hypothesis(component: ComponentName, text: string): number {
      assertOpen()
      void component
      void text
      return notImplemented('hypothesis')
    },

    // T2.23: validate (active hypothesis, >= 1 previous `ask` seq), recordFreeStep({ type: 'discard', ... }),
    // set `discardedBy` on the hypothesis.
    discard(hypothesisSeq: number, citedSeqs: readonly number[], text?: string): void {
      assertOpen()
      void hypothesisSeq
      void citedSeqs
      void text
      notImplemented('discard')
    },

    // T2.23: validate `final`, then finish(final, 'player').
    end(final: FinalHypothesis): void {
      assertOpen()
      void final
      notImplemented('end')
    },

    log(): SessionLogV1 {
      return {
        format: 'whodeployed-session-log',
        version: 1,
        scenario: { id: scenario.id, seed: scenario.seed },
        engine: { version: deps.engineVersion },
        build: { sha: deps.buildSha },
        steps: [...steps],
        finalHypothesis,
        // The 3 sentences are built by buildReview (T2.25) and attached at the end by the caller.
        review: null,
      }
    },
  }
  return session
}

/** Builds the contract's `createSession` (ADR-015 §5) from the scenario rules (see the header). */
export function makeCreateSession(rules: SessionRules): CreateSession {
  return (scenario, deps) => openSession(scenario, deps, rules)
}
