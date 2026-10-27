// @vitest-environment node
/**
 * T2.25 — buildReview (PR-11 logic, DET). Synthetic session logs, one per branch of each of the
 * 3 sentences; `checkMitigations` (T2.13) and `matchesPattern` (T2.10/T2.11) are mocks, so these
 * tests exercise only the review and never the simulation.
 */
import type { Action, Answer, Question, Signal } from '@whodeployed/engine'
import type {
  CheckMitigations,
  EngineRuntime,
  MatchesPattern,
  MitigationCheck,
  PlayStep,
  Scenario,
} from '@whodeployed/scenarios'
import { describe, expect, it, vi } from 'vitest'
import {
  REVIEW_TEXT,
  createBuildReview,
  formatQuestion,
  playStepsOf,
  referenceImpactOf,
  type ReviewDeps,
} from '../../src/session/review'
import type { FinalHypothesis, SessionLogV1, SessionStep } from '../../src/session/types'
import { juniorFixture, plenoFixture } from '../fixtures/scenarios'

// ---------------------------------------------------------------------------
// Synthetic logs
// ---------------------------------------------------------------------------

/** Tick costs used only to build plausible logs; the review reads them from the log. */
const COST: Record<Question['kind'], number> = { dashboard: 1, logs: 2, trace: 2, whatChanged: 1, compare: 2, askNpc: 3 }

type Input =
  | { ask: Question }
  | { act: Action }
  | { wait: true }
  | { hypothesis: string }
  | { end: FinalHypothesis }

/** Builds an ended log from `alert.tick`; impact grows by `impactPerTick` per tick (only for sentence 3's end branch). */
function makeLog(scenario: Scenario, inputs: readonly Input[], impactPerTick = 1): SessionLogV1 {
  let tick = scenario.alert.tick
  let impact = 0
  const steps: SessionStep[] = []
  const push = (cost: number, rest: Record<string, unknown>): void => {
    const tickBefore = tick
    tick += cost
    impact += cost * impactPerTick
    const base = { seq: steps.length + 1, tickBefore, tickCost: cost, impactAfter: impact, wallMs: 0 }
    steps.push({ ...base, ...rest } as SessionStep)
  }
  for (const input of [...inputs, { end: { kind: 'unknown' } } as Input]) {
    if ('ask' in input) {
      const cost = COST[input.ask.kind]
      const answer: Answer = { question: input.ask, data: {} as Signal, tickCost: cost }
      push(cost, { type: 'ask', question: input.ask, answer })
    } else if ('act' in input) {
      push(1, { type: 'act', action: input.act, result: { action: input.act, tick, tickCost: 1 } })
    } else if ('wait' in input) {
      push(1, { type: 'wait' })
    } else if ('hypothesis' in input) {
      push(0, { type: 'hypothesis', component: 'catalog', text: input.hypothesis })
    } else {
      push(0, { type: 'end', final: input.end, reason: 'player' })
    }
  }
  return {
    format: 'whodeployed-session-log',
    version: 1,
    scenario: { id: scenario.id, seed: scenario.seed },
    engine: { version: '0.0.0' },
    build: { sha: 'unknown' },
    steps,
    finalHypothesis: { kind: 'unknown' },
    review: null,
  }
}

// ---------------------------------------------------------------------------
// Mocks of the injected scenario functions
// ---------------------------------------------------------------------------

/** The documented semantics of MatchesPattern (scenarios types §2): same kind and, when set, same service. */
const matchesPattern: MatchesPattern = (pattern, question) =>
  pattern.kind === question.kind &&
  (pattern.service === undefined || ('service' in question && question.service === pattern.service))

const engine = { sentinel: 'engine' } as unknown as EngineRuntime

/**
 * Mock checkMitigations: one MitigationCheck per action of `steps`, with `tick` and
 * `impactAtAction` given per action index and `effective` when the action is in `effectiveActions`.
 */
function mockCheck(
  effectiveActions: readonly number[],
  values: (actionIndex: number) => { tick: number; impactAtAction: number },
): CheckMitigations {
  return vi.fn((_scenario: Scenario, steps: readonly PlayStep[]): readonly MitigationCheck[] => {
    const checks: MitigationCheck[] = []
    steps.forEach((step, index) => {
      if (step.type !== 'act') return
      const n = checks.length
      checks.push({ step: index, ...values(n), effective: effectiveActions.includes(n) })
    })
    return checks
  })
}

function deps(check: CheckMitigations): ReviewDeps {
  return { checkMitigations: check, matchesPattern, engine }
}

const noMitigation = mockCheck([], () => ({ tick: 0, impactAtAction: 0 }))

// Questions reused across tests (junior fixture: redundant = dashboard gateway; key = logs catalog).
const dashGateway: Question = { kind: 'dashboard', service: 'gateway' }
const dashCatalog: Question = { kind: 'dashboard', service: 'catalog' }
const logsCatalog: Question = { kind: 'logs', service: 'catalog', window: 30 }
const logsCart: Question = { kind: 'logs', service: 'cart', window: 30 }
const restartCatalog: Action = { kind: 'restart', target: 'catalog' }
const restartCart: Action = { kind: 'restart', target: 'cart' }

// ---------------------------------------------------------------------------
// Sentence 1 — redundant questions
// ---------------------------------------------------------------------------

describe('sentence 1: redundant questions (PR-11)', () => {
  const review = createBuildReview(deps(noMitigation))

  it('says "no redundant questions" when nothing is repeated or listed', () => {
    const log = makeLog(juniorFixture, [{ ask: dashCatalog }, { ask: logsCatalog }])
    expect(review(log, juniorFixture, 3)[0]).toBe('No redundant questions.')
  })

  it('lists an identical repeat with its tick', () => {
    // ticks: alert 14; dashboard catalog @14 (cost 1); logs cart @15 (2); dashboard catalog @17.
    const log = makeLog(juniorFixture, [{ ask: dashCatalog }, { ask: logsCart }, { ask: dashCatalog }])
    expect(review(log, juniorFixture, 3)[0]).toBe('Redundant questions: dashboard catalog at tick 17 (identical repeat).')
  })

  it('treats a repeat with the keys in another order as identical', () => {
    const reordered = { window: 30, service: 'cart', kind: 'logs' } as unknown as Question
    const log = makeLog(juniorFixture, [{ ask: logsCart }, { ask: reordered }])
    expect(review(log, juniorFixture, 3)[0]).toBe('Redundant questions: logs cart at tick 16 (identical repeat).')
  })

  it('does not treat the same kind and service with another filter as an identical repeat', () => {
    const filtered: Question = { kind: 'logs', service: 'cart', window: 30, filter: { level: 'error' } }
    const log = makeLog(plenoFixture, [{ ask: logsCart }, { ask: filtered }])
    expect(review(log, plenoFixture, 3)[0]).toBe('No redundant questions.')
  })

  it('lists a question that matches review.redundant, even when asked once', () => {
    const log = makeLog(juniorFixture, [{ ask: logsCatalog }, { ask: dashGateway }])
    expect(review(log, juniorFixture, 3)[0]).toBe('Redundant questions: dashboard gateway at tick 16.')
  })

  it('lists both kinds in log order, each occurrence once', () => {
    // dashboard gateway @14 (listed), @15 (listed and repeat); dashboard catalog @16, @17 (repeat).
    const log = makeLog(juniorFixture, [{ ask: dashGateway }, { ask: dashGateway }, { ask: dashCatalog }, { ask: dashCatalog }])
    expect(review(log, juniorFixture, 3)[0]).toBe(
      'Redundant questions: dashboard gateway at tick 14, dashboard gateway at tick 15 (identical repeat), dashboard catalog at tick 17 (identical repeat).',
    )
  })
})

// ---------------------------------------------------------------------------
// Sentence 2 — key signal
// ---------------------------------------------------------------------------

describe('sentence 2: key signal (PR-11)', () => {
  const review = createBuildReview(deps(noMitigation))

  it('cites the tick of the first question matching review.keySignalAsk', () => {
    // dashboard catalog @14 (1); logs catalog @15; logs catalog again @17.
    const log = makeLog(juniorFixture, [{ ask: dashCatalog }, { ask: logsCatalog }, { ask: logsCatalog }])
    expect(review(log, juniorFixture, 3)[1]).toBe(
      'You asked logs catalog at tick 15; its answer contained the key signal: Fixture key signal (junior).',
    )
  })

  it('says it was not asked when no question matches', () => {
    const log = makeLog(juniorFixture, [{ ask: dashCatalog }, { ask: logsCart }])
    expect(review(log, juniorFixture, 3)[1]).toBe(
      'You did not ask logs catalog; its answer contained the key signal: Fixture key signal (junior).',
    )
  })

  it('uses the injected matchesPattern', () => {
    const always = vi.fn<MatchesPattern>(() => true)
    const review2 = createBuildReview({ checkMitigations: noMitigation, matchesPattern: always, engine })
    const log = makeLog(plenoFixture, [{ ask: dashCatalog }])
    expect(review2(log, plenoFixture, 3)[1]).toBe(
      'You asked compare cart at tick 18; its answer contained the key signal: Fixture key signal (pleno).',
    )
    expect(always).toHaveBeenCalledWith(plenoFixture.review.keySignalAsk, dashCatalog)
  })
})

// ---------------------------------------------------------------------------
// Sentence 3 — impact at the effective mitigation
// ---------------------------------------------------------------------------

describe('sentence 3: impact at the effective mitigation (PR-11, ADR-013 §4)', () => {
  it('reports the first effective mitigation of the player against the reference impact', () => {
    // restart cart (action 0, not effective), restart catalog (action 1, effective).
    const check = mockCheck([1], (n) => (n === 0 ? { tick: 16, impactAtAction: 2 } : { tick: 20, impactAtAction: 6 }))
    const review = createBuildReview(deps(check))
    const log = makeLog(juniorFixture, [
      { ask: logsCatalog },
      { hypothesis: 'catalog crashes' },
      { act: restartCart },
      { wait: true },
      { act: restartCatalog },
    ])
    expect(review(log, juniorFixture, 4)[2]).toBe(
      "Accumulated impact at your effective mitigation (restart catalog at tick 20): 6; at the reference path's mitigation: 4.",
    )
  })

  it('replays only the clock-moving steps of the log, with the injected engine', () => {
    const check = mockCheck([], () => ({ tick: 0, impactAtAction: 0 }))
    const review = createBuildReview(deps(check))
    const log = makeLog(juniorFixture, [{ ask: logsCatalog }, { hypothesis: 'h' }, { wait: true }, { act: restartCatalog }])
    review(log, juniorFixture, 4)
    const expected: PlayStep[] = [
      { type: 'ask', question: logsCatalog },
      { type: 'wait' },
      { type: 'act', action: restartCatalog },
    ]
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledWith(juniorFixture, expected, engine)
    expect(playStepsOf(log)).toStrictEqual({ steps: expected, seqs: [1, 3, 4] })
  })

  it('reports the impact at the end when no action was effective', () => {
    const check = mockCheck([], () => ({ tick: 16, impactAtAction: 2 }))
    const review = createBuildReview(deps(check))
    // alert 14; logs catalog (2) -> 16; restart cart (1) -> 17; wait -> 18; end @18, impact 4 (1 per tick).
    const log = makeLog(juniorFixture, [{ ask: logsCatalog }, { act: restartCart }, { wait: true }])
    expect(review(log, juniorFixture, 4)[2]).toBe(
      "No effective mitigation; accumulated impact at the end (tick 18): 4; at the reference path's mitigation: 4.",
    )
  })

  it('reports the impact at the end when the player took no action', () => {
    const review = createBuildReview(deps(noMitigation))
    const log = makeLog(juniorFixture, [{ ask: logsCatalog }, { wait: true }], 2)
    expect(review(log, juniorFixture, 1)[2]).toBe(
      "No effective mitigation; accumulated impact at the end (tick 17): 6; at the reference path's mitigation: 1.",
    )
  })
})

// ---------------------------------------------------------------------------
// Reference impact
// ---------------------------------------------------------------------------

describe('referenceImpactOf', () => {
  it('is the impact at the first effective mitigation of the referencePath', () => {
    const check = mockCheck([0], () => ({ tick: 17, impactAtAction: 3 }))
    expect(referenceImpactOf(juniorFixture, deps(check))).toBe(3)
    expect(check).toHaveBeenCalledWith(juniorFixture, juniorFixture.referencePath, engine)
  })

  it('throws when the referencePath has no effective mitigation (ruled out by CN-3)', () => {
    expect(() => referenceImpactOf(juniorFixture, deps(noMitigation))).toThrow(/no effective mitigation/)
  })
})

// ---------------------------------------------------------------------------
// Shape, no grading, determinism, errors
// ---------------------------------------------------------------------------

/** One log per branch of the 3 sentences, to check properties of every possible output. */
function allBranches(): string[] {
  const effective = createBuildReview(deps(mockCheck([0], () => ({ tick: 17, impactAtAction: 3 }))))
  const none = createBuildReview(deps(noMitigation))
  return [
    ...none(makeLog(juniorFixture, [{ ask: dashCatalog }]), juniorFixture, 3),
    ...none(makeLog(juniorFixture, [{ ask: dashGateway }, { ask: dashGateway }, { ask: logsCatalog }]), juniorFixture, 3),
    ...effective(makeLog(plenoFixture, [{ ask: { kind: 'whatChanged', window: 30 } }, { act: { kind: 'rollback', target: 'cart' } }]), plenoFixture, 2),
    ...none(makeLog(plenoFixture, [{ ask: { kind: 'trace', service: 'cart', percentile: 95 } }]), plenoFixture, 2),
  ]
}

describe('shape and content (PR-11, PR-18)', () => {
  it('returns exactly 3 strings, each a single sentence', () => {
    const review = createBuildReview(deps(noMitigation))
    const sentences = review(makeLog(juniorFixture, [{ ask: logsCatalog }]), juniorFixture, 3)
    expect(sentences).toHaveLength(3)
    for (const sentence of allBranches()) {
      expect(sentence.match(/[.!?](?=\s|$)/g)).toHaveLength(1)
      expect(sentence.endsWith('.')).toBe(true)
    }
  })

  it('has no grade, star, percentage or ranking in any branch', () => {
    const grading = /%|\bpercent|\bscore|\bgrade|\brank|\bstars?\b|★|☆|\bpoints?\b|\bXP\b|\bbest\b|\bworst\b|\bbetter\b|\bworse\b|\bpassed\b|\bfailed\b|\b\d+\s*\/\s*\d+\b/i
    for (const sentence of allBranches()) expect(sentence).not.toMatch(grading)
  })

  it('never shows the rootCause, teaches or trap of the scenario', () => {
    for (const sentence of allBranches()) {
      for (const text of [juniorFixture.rootCause, juniorFixture.teaches, juniorFixture.trap, plenoFixture.rootCause]) {
        expect(sentence).not.toContain(withoutPeriod(text))
      }
    }
  })

  it('keeps every text in REVIEW_TEXT', () => {
    expect(Object.keys(REVIEW_TEXT).sort()).toStrictEqual([
      'impactMitigated',
      'impactNotMitigated',
      'keySignalAsked',
      'keySignalNotAsked',
      'noRedundant',
      'redundant',
      'redundantItem',
    ])
  })
})

function withoutPeriod(text: string): string {
  return text.replace(/\.$/, '')
}

describe('determinism (DET)', () => {
  it('gives the same sentences for the same input', () => {
    const make = (): readonly string[] => {
      const check = mockCheck([0], () => ({ tick: 17, impactAtAction: 3 }))
      const log = makeLog(juniorFixture, [{ ask: dashGateway }, { ask: dashGateway }, { act: restartCatalog }])
      return createBuildReview(deps(check))(log, juniorFixture, 2)
    }
    expect(make()).toStrictEqual(make())
  })

  it('ignores wallMs', () => {
    const review = createBuildReview(deps(noMitigation))
    const log = makeLog(juniorFixture, [{ ask: logsCatalog }, { ask: logsCatalog }])
    const later = { ...log, steps: log.steps.map((s, i) => ({ ...s, wallMs: 1000 * (i + 1) })) }
    expect(review(later, juniorFixture, 3)).toStrictEqual(review(log, juniorFixture, 3))
  })

  it('does not mutate the log or the scenario', () => {
    const review = createBuildReview(deps(noMitigation))
    const log = makeLog(juniorFixture, [{ ask: logsCatalog }, { act: restartCatalog }])
    const before = JSON.stringify([log, juniorFixture])
    review(log, juniorFixture, 3)
    expect(JSON.stringify([log, juniorFixture])).toBe(before)
  })
})

describe('errors and formatting', () => {
  const review = createBuildReview(deps(noMitigation))

  it('rejects a log that has not ended', () => {
    const log = makeLog(juniorFixture, [{ ask: logsCatalog }])
    const open = { ...log, steps: log.steps.slice(0, -1) }
    expect(() => review(open, juniorFixture, 3)).toThrow(/ended session/)
    expect(() => review({ ...log, steps: [] }, juniorFixture, 3)).toThrow(/ended session/)
  })

  it('rejects a log of another scenario', () => {
    const log = makeLog(plenoFixture, [{ ask: logsCatalog }])
    expect(() => review(log, juniorFixture, 3)).toThrow(/92-fixture-pleno/)
  })

  it('formats every question kind', () => {
    expect(
      [
        dashGateway,
        { kind: 'logs', service: 'cart', window: 30, filter: { route: '/pay', level: 'error' } },
        { kind: 'trace', service: 'payment', percentile: 99 },
        { kind: 'whatChanged', window: 30 },
        { kind: 'compare', service: 'cart', metric: 'errorPct', by: 'instance' },
        { kind: 'askNpc', role: 'dba' },
      ].map((q) => formatQuestion(q as Question)),
    ).toStrictEqual([
      'dashboard gateway',
      'logs cart filter level=error route=/pay',
      'trace payment p99',
      'whatChanged',
      'compare cart errorPct by instance',
      'askNpc dba',
    ])
  })
})
