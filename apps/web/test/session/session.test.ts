// @vitest-environment node
/**
 * Session core (T2.22; ADR-015 §5, ADR-016 §1; FASE-2 PR-5, PR-6, PR-8, PR-12, DET).
 *
 * Runs on fixture scenarios (test/fixtures/scenarios.ts) and the real engine, through its public
 * entry only (src/engine-runtime.ts). Expected ticks are the ADR-006/ADR-012 costs written out;
 * expected impacts are recomputed on an independent simulation driven with the same inputs.
 *
 * `inRepertoire` (T2.11) and `toSimulationConfig` (T2.10) are not on main yet: they are injected
 * as SessionRules. Here `inRepertoire` is a spy that accepts everything unless a test says
 * otherwise (the repertoire table is not copied into apps/web, PR-6); `toSimulationConfig` is the
 * contract's mapping (system by name, seed, faults, noise).
 */
import { isEngineError } from '@whodeployed/engine'
import type { Action, Question, Simulation } from '@whodeployed/engine'
import type { InRepertoire, ReferenceStep, Scenario, ToSimulationConfig } from '@whodeployed/scenarios'
import { describe, expect, it, vi } from 'vitest'
import { engineRuntime } from '../../src/engine-runtime'
import { SessionError, isSessionError } from '../../src/session/errors'
import { SESSION_TICK_LIMIT, makeCreateSession } from '../../src/session/session'
import type { SessionRules } from '../../src/session/session'
import type { Session, SessionDeps, SessionLogV1, SessionState } from '../../src/session/types'
import { juniorFixture, plenoFixture } from '../fixtures/scenarios'

const toSimulationConfig: ToSimulationConfig = (scenario, engine) => {
  const system = engine.systems[scenario.system]
  if (system === undefined) throw new Error(`fixture: unknown system ${scenario.system}`)
  return { system, seed: scenario.seed, faults: scenario.faults, noise: scenario.noise }
}

function rulesWith(inRepertoire: InRepertoire = () => true): SessionRules {
  return { inRepertoire, toSimulationConfig }
}

/** A wall clock that moves 7 ms per read, starting at `origin`. */
function fakeClock(origin = 1000, step = 7): () => number {
  let t = origin - step
  return () => (t += step)
}

function depsWith(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return { engine: engineRuntime, wallClock: fakeClock(), engineVersion: '9.9.9-test', buildSha: 'unknown', ...overrides }
}

function open(scenario: Scenario, rules: SessionRules = rulesWith(), deps: SessionDeps = depsWith()): Session {
  return makeCreateSession(rules)(scenario, deps)
}

/** An independent simulation of `scenario`, at alert.tick, to recompute impact (ADR-013). */
function reference(scenario: Scenario): { sim: Simulation; impact: () => number } {
  const sim = engineRuntime.createSimulation(toSimulationConfig(scenario, engineRuntime))
  sim.advance(scenario.alert.tick)
  return { sim, impact: () => engineRuntime.accumulatedImpact(sim.telemetry(), sim.world.tick) }
}

function withoutWallMs(log: SessionLogV1): string {
  return JSON.stringify({ ...log, steps: log.steps.map((step) => ({ ...step, wallMs: 0 })) })
}

function catchError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

function waitUntil(session: Session, done: (state: SessionState) => boolean): void {
  while (!session.state.ended && !done(session.state)) session.wait()
}

describe('PR-5 start of the session', () => {
  it.each([juniorFixture, plenoFixture])('$id starts at alert.tick with the accumulated impact up to it', (scenario) => {
    const session = open(scenario)
    const ref = reference(scenario)
    const { state } = session
    expect(state.tick).toBe(scenario.alert.tick)
    expect(state.impact).toBe(ref.impact())
    expect(state.impactBudget).toBe(scenario.impactBudget)
    expect(state.severe).toBe(ref.impact() >= scenario.impactBudget)
    expect(state.scenarioId).toBe(scenario.id)
    expect(state.level).toBe(scenario.level)
    expect(state.ended).toBe(false)
    // No signal without a question: the session starts with no step.
    expect(state.steps).toEqual([])
    expect(state.hypotheses).toEqual([])
  })

  it('refuses a level with no phase-2 repertoire (senior)', () => {
    const error = catchError(() => open({ ...juniorFixture, level: 'senior' }))
    expect(error).toBeInstanceOf(SessionError)
    expect((error as SessionError).code).toBe('no_repertoire')
  })

  it.each([SESSION_TICK_LIMIT, 400, -1, 2.5])('refuses alert.tick %s (a session needs a tick before 360)', (tick) => {
    const error = catchError(() => open({ ...juniorFixture, alert: { ...juniorFixture.alert, tick } }))
    expect(isSessionError(error)).toBe(true)
    expect((error as SessionError).code).toBe('invalid_scenario')
  })

  it('propagates an EngineError of the scenario config unchanged', () => {
    const bad: Scenario = { ...juniorFixture, seed: '' }
    const error = catchError(() => open(bad))
    expect(isEngineError(error)).toBe(true)
  })
})

describe('PR-8 clock: fixed sequence, tick and impact after each step', () => {
  it('junior: dashboard (1), logs (1), restart (2), wait (1), wait (1)', () => {
    const scenario = juniorFixture // alert.tick 14
    const session = open(scenario)
    const ref = reference(scenario)

    const sequence: { run: (s: Session) => void; mirror: () => void; tickAfter: number; cost: number }[] = [
      {
        run: (s) => s.ask({ kind: 'dashboard', service: 'catalog' }),
        mirror: () => ref.sim.advance(1),
        tickAfter: 15,
        cost: 1,
      },
      {
        run: (s) => s.ask({ kind: 'logs', service: 'catalog', window: 30 }),
        mirror: () => ref.sim.advance(1),
        tickAfter: 16,
        cost: 1,
      },
      {
        run: (s) => s.act({ kind: 'restart', target: 'catalog' }),
        mirror: () => {
          ref.sim.act({ kind: 'restart', target: 'catalog' })
          ref.sim.advance(2)
        },
        tickAfter: 18,
        cost: 2,
      },
      { run: (s) => s.wait(), mirror: () => ref.sim.advance(1), tickAfter: 19, cost: 1 },
      { run: (s) => s.wait(), mirror: () => ref.sim.advance(1), tickAfter: 20, cost: 1 },
    ]

    let tickBefore = scenario.alert.tick
    sequence.forEach((entry, index) => {
      entry.run(session)
      entry.mirror()
      const { state } = session
      const step = state.steps[index]
      expect(state.tick).toBe(entry.tickAfter)
      expect(state.impact).toBe(ref.impact())
      expect(state.severe).toBe(state.impact >= scenario.impactBudget)
      expect(step).toMatchObject({ seq: index + 1, tickBefore, tickCost: entry.cost, impactAfter: state.impact })
      tickBefore = entry.tickAfter
    })
    expect(session.state.steps.map((s) => s.type)).toEqual(['ask', 'ask', 'act', 'wait', 'wait'])
  })

  it('pleno: whatChanged (1), compare (2), trace (2), rollback (3)', () => {
    const scenario = plenoFixture // alert.tick 18
    const session = open(scenario)
    const ref = reference(scenario)

    const whatChanged = session.ask({ kind: 'whatChanged', window: 30 })
    ref.sim.advance(1)
    expect([session.state.tick, whatChanged.tickCost, session.state.impact]).toEqual([19, 1, ref.impact()])

    const compare = session.ask({ kind: 'compare', service: 'cart', metric: 'errorPct', by: 'instance' })
    ref.sim.advance(2)
    expect([session.state.tick, compare.tickCost, session.state.impact]).toEqual([21, 2, ref.impact()])

    const trace = session.ask({ kind: 'trace', service: 'cart', percentile: 95 })
    ref.sim.advance(2)
    expect([session.state.tick, trace.tickCost, session.state.impact]).toEqual([23, 2, ref.impact()])

    const rollback = session.act({ kind: 'rollback', target: 'cart' })
    ref.sim.act({ kind: 'rollback', target: 'cart' })
    ref.sim.advance(3)
    expect([session.state.tick, rollback.tickCost, session.state.impact]).toEqual([26, 3, ref.impact()])
    expect(rollback).toEqual({ action: { kind: 'rollback', target: 'cart' }, tick: 23, tickCost: 3 })
  })

  it('returns the engine Answer and logs it with the validated question (ADR-016 key order)', () => {
    const session = open(juniorFixture)
    const ref = reference(juniorFixture)
    const answer = session.ask({ kind: 'logs', service: 'catalog', window: 30 })
    expect(answer).toEqual(ref.sim.ask({ kind: 'logs', service: 'catalog', window: 30 }))
    session.act({ kind: 'restart', target: 'catalog' })
    session.wait()
    const [ask, act, wait] = session.state.steps
    expect(Object.keys(ask ?? {})).toEqual(['seq', 'tickBefore', 'type', 'question', 'answer', 'tickCost', 'impactAfter', 'wallMs'])
    expect(Object.keys(act ?? {})).toEqual(['seq', 'tickBefore', 'type', 'action', 'result', 'tickCost', 'impactAfter', 'wallMs'])
    expect(Object.keys(wait ?? {})).toEqual(['seq', 'tickBefore', 'type', 'tickCost', 'impactAfter', 'wallMs'])
    expect(ask).toMatchObject({ type: 'ask', question: answer.question, answer })
  })

  it('reading the state costs nothing and never changes the clock', () => {
    const session = open(juniorFixture)
    const before = session.state
    for (let i = 0; i < 5; i += 1) void session.state
    expect(session.state).toEqual(before)
  })

  it('memoizes the accumulated impact by tick', () => {
    const accumulatedImpact = vi.fn(engineRuntime.accumulatedImpact)
    const session = open(juniorFixture, rulesWith(), depsWith({ engine: { ...engineRuntime, accumulatedImpact } }))
    session.wait()
    session.wait()
    for (let i = 0; i < 10; i += 1) void session.state
    session.log()
    // One computation per distinct tick: 14 (start), 15, 16.
    expect(accumulatedImpact.mock.calls.map(([, upTo]) => upTo)).toEqual([14, 15, 16])
  })
})

describe('PR-8 SEVERE when impact >= budget', () => {
  it('severe flips exactly when the accumulated impact reaches the budget, and stays', () => {
    // No action: the crash loop keeps impacting; a small budget is reached well before tick 360.
    const scenario: Scenario = { ...juniorFixture, impactBudget: 5 }
    const session = open(scenario)
    let seenSevere = false
    waitUntil(session, (state) => {
      expect(state.severe).toBe(state.impact >= scenario.impactBudget)
      if (seenSevere) expect(state.severe).toBe(true)
      seenSevere ||= state.severe
      return state.tick > 60
    })
    expect(seenSevere).toBe(true)
    expect(session.state.impact).toBeGreaterThanOrEqual(scenario.impactBudget)
  })
})

describe('PR-8 tick limit 360', () => {
  it('wait up to 360 ends the session by itself (reason tickLimit, final unknown)', () => {
    const session = open(juniorFixture)
    waitUntil(session, () => false)
    const { state } = session
    expect(state.tick).toBe(SESSION_TICK_LIMIT)
    expect(state.ended).toBe(true)
    const last = state.steps[state.steps.length - 1]
    expect(last).toMatchObject({
      type: 'end',
      final: { kind: 'unknown' },
      reason: 'tickLimit',
      tickBefore: 360,
      tickCost: 0,
      impactAfter: state.impact,
    })
    expect(state.steps.filter((s) => s.type === 'wait')).toHaveLength(SESSION_TICK_LIMIT - juniorFixture.alert.tick)
    expect(session.log().finalHypothesis).toEqual({ kind: 'unknown' })
  })

  it('a cost that would pass 360 is paid only up to 360 (act restart at 359 costs 1)', () => {
    const session = open(juniorFixture)
    waitUntil(session, (state) => state.tick === SESSION_TICK_LIMIT - 1)
    const result = session.act({ kind: 'restart', target: 'catalog' })
    expect(result.tickCost).toBe(2)
    const { state } = session
    expect(state.tick).toBe(SESSION_TICK_LIMIT)
    expect(state.steps.at(-2)).toMatchObject({ type: 'act', tickBefore: 359, tickCost: 1 })
    expect(state.steps.at(-1)).toMatchObject({ type: 'end', reason: 'tickLimit' })
  })

  it('a question that would pass 360 is paid only up to 360 (trace at 359 costs 1)', () => {
    const session = open(plenoFixture)
    waitUntil(session, (state) => state.tick === SESSION_TICK_LIMIT - 1)
    session.ask({ kind: 'trace', service: 'cart', percentile: 99 })
    expect(session.state.steps.at(-2)).toMatchObject({ type: 'ask', tickBefore: 359, tickCost: 1 })
    expect(session.state.tick).toBe(SESSION_TICK_LIMIT)
    expect(session.state.ended).toBe(true)
  })

  it('after the end, ask, act and wait throw SessionError and change nothing', () => {
    const session = open(juniorFixture)
    waitUntil(session, () => false)
    const before = session.state
    for (const call of [
      () => session.ask({ kind: 'dashboard', service: 'catalog' }),
      () => session.act({ kind: 'restart', target: 'catalog' }),
      () => session.wait(),
    ]) {
      const error = catchError(call)
      expect(error).toBeInstanceOf(SessionError)
      expect((error as SessionError).code).toBe('session_ended')
    }
    expect(session.state).toEqual(before)
  })
})

describe('PR-6 repertoire through inRepertoire (single table in @whodeployed/scenarios)', () => {
  it('asks inRepertoire with (scenario level, step) before every question and action', () => {
    const inRepertoire = vi.fn<InRepertoire>(() => true)
    const session = open(plenoFixture, rulesWith(inRepertoire))
    const question: Question = { kind: 'dashboard', service: 'cart' }
    const action: Action = { kind: 'restart', target: 'cart' }
    session.ask(question)
    session.act(action)
    session.wait()
    expect(inRepertoire.mock.calls).toEqual([
      ['pleno', { type: 'ask', question }],
      ['pleno', { type: 'act', action }],
    ])
  })

  it('a question or action outside the repertoire throws SessionError and changes nothing', () => {
    // Fake rule for this test only: refuses traces and rollbacks.
    const refuses = (step: ReferenceStep): boolean =>
      (step.type === 'ask' && step.question.kind === 'trace') || (step.type === 'act' && step.action.kind === 'rollback')
    const session = open(juniorFixture, rulesWith((_level, step) => !refuses(step)))
    session.ask({ kind: 'dashboard', service: 'catalog' })
    const before = session.state
    const beforeLog = session.log()
    for (const call of [
      () => session.ask({ kind: 'trace', service: 'catalog', percentile: 95 }),
      () => session.act({ kind: 'rollback', target: 'catalog' }),
    ]) {
      const error = catchError(call)
      expect(error).toBeInstanceOf(SessionError)
      expect((error as SessionError).code).toBe('out_of_repertoire')
      expect((error as SessionError).message).toContain('junior')
    }
    expect(session.state).toEqual(before)
    expect(session.log()).toEqual(beforeLog)
  })
})

describe('EngineError of a question or action: no tick, no step, rethrown unchanged', () => {
  it('invalid_filter on logs (pleno) costs nothing', () => {
    const session = open(plenoFixture)
    const before = session.state
    const question = { kind: 'logs', service: 'cart', window: 30, filter: { level: 5 } } as unknown as Question
    const error = catchError(() => session.ask(question))
    expect(isEngineError(error)).toBe(true)
    expect(error).toMatchObject({ name: 'EngineError', code: 'invalid_filter', field: 'question.filter.level' })
    expect(session.state).toEqual(before)
  })

  it('unknown_target on an action costs nothing', () => {
    const session = open(juniorFixture)
    const before = session.state
    const error = catchError(() => session.act({ kind: 'restart', target: 'nowhere' }))
    expect(isEngineError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'unknown_target' })
    expect(session.state).toEqual(before)
    // The session goes on normally after the error.
    session.act({ kind: 'restart', target: 'catalog' })
    expect(session.state.tick).toBe(before.tick + 2)
  })
})

describe('PR-13 log snapshot (format fields; serialization is T2.24)', () => {
  it('carries scenario id and seed, engine version, build sha; null final and review before the end', () => {
    const session = open(juniorFixture, rulesWith(), depsWith({ buildSha: 'a'.repeat(40) }))
    session.wait()
    const log = session.log()
    expect(Object.keys(log)).toEqual(['format', 'version', 'scenario', 'engine', 'build', 'steps', 'finalHypothesis', 'review'])
    expect(log).toMatchObject({
      format: 'whodeployed-session-log',
      version: 1,
      scenario: { id: juniorFixture.id, seed: juniorFixture.seed },
      engine: { version: '9.9.9-test' },
      build: { sha: 'a'.repeat(40) },
      finalHypothesis: null,
      review: null,
    })
    expect(log.steps).toHaveLength(1)
  })

  it('wallMs = integer ms of the injected wall clock since the session started', () => {
    const session = open(juniorFixture, rulesWith(), depsWith({ wallClock: fakeClock(5000, 250.4) }))
    session.wait()
    session.wait()
    // Reads: 5000 at start, then one read per step.
    expect(session.state.steps.map((s) => s.wallMs)).toEqual([250, 501])
  })

  it('the log is a snapshot: later steps do not change an earlier log', () => {
    const session = open(juniorFixture)
    const first = session.log()
    session.wait()
    expect(first.steps).toHaveLength(0)
  })
})

describe('PR-12 / DET determinism of the session', () => {
  function play(scenario: Scenario, wallClock: () => number): SessionLogV1 {
    const session = open(scenario, rulesWith(), depsWith({ wallClock }))
    session.ask({ kind: 'whatChanged', window: 30 })
    session.ask({ kind: 'logs', service: 'cart', window: 30, filter: { level: 'error' } })
    session.ask({ kind: 'compare', service: 'cart', metric: 'errorPct', by: 'instance' })
    session.ask({ kind: 'trace', service: 'cart', percentile: 99 })
    session.act({ kind: 'rollback', target: 'cart' })
    session.ask({ kind: 'dashboard', service: 'cart' })
    for (let i = 0; i < 12; i += 1) session.wait()
    session.act({ kind: 'restart', target: 'cart' })
    return session.log()
  }

  it('same scenario and same inputs twice => same log without wallMs', () => {
    const a = play(plenoFixture, fakeClock(0, 3))
    const b = play(plenoFixture, fakeClock(123456, 41))
    expect(withoutWallMs(a)).toBe(withoutWallMs(b))
    // The only difference allowed is wallMs.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('a different seed gives a different log (the comparison is not vacuous)', () => {
    const a = play(plenoFixture, fakeClock())
    const b = play({ ...plenoFixture, seed: 'fixture-pleno-02' }, fakeClock())
    expect(withoutWallMs(a)).not.toBe(withoutWallMs(b))
  })
})
