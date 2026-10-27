// T2.11: repertoire table (single place, PR-6) and inRepertoire (CN-5).
// The expected table below is a transcription of FASE-2 PRD "Repertório do nível" and ADR-014 §3.
import { describe, expect, it } from 'vitest'
import { inRepertoire, repertoire } from '../src/index.js'
import type { PlayableLevel, ReferenceStep, RepertoireTable } from '../src/index.js'
import type { Action, Question } from '@whodeployed/engine'

const ask = (question: Question): ReferenceStep => ({ type: 'ask', question })
const act = (action: Action): ReferenceStep => ({ type: 'act', action })

// PRD conventions table, transcribed: Júnior = dashboard; logs window 30 without filter; restart.
// Pleno = everything of Júnior; logs with filter; compare by instance; trace 50/95/99; whatChanged
// (window 30, ADR-014 §3); rollback.
const expectedTable: RepertoireTable = {
  junior: {
    dashboard: true,
    logs: { window: 30, filter: false },
    tracePercentiles: [],
    whatChanged: null,
    compareBy: [],
    actions: ['restart'],
  },
  pleno: {
    dashboard: true,
    logs: { window: 30, filter: true },
    tracePercentiles: [50, 95, 99],
    whatChanged: { window: 30 },
    compareBy: ['instance'],
    actions: ['restart', 'rollback'],
  },
}

const SENIOR_ACTIONS = ['flagOff', 'declareMitigated', 'escalate', 'scale'] as const
const LEVELS: readonly PlayableLevel[] = ['junior', 'pleno']

describe('repertoire table', () => {
  it('equals the PRD conventions table, with only junior and pleno', () => {
    expect(repertoire).toStrictEqual(expectedTable)
    expect(Object.keys(repertoire).sort()).toEqual(['junior', 'pleno'])
  })

  it('is deeply frozen', () => {
    expect(Object.isFrozen(repertoire)).toBe(true)
    for (const level of LEVELS) {
      const r = repertoire[level]
      expect(Object.isFrozen(r)).toBe(true)
      expect(Object.isFrozen(r.logs)).toBe(true)
      expect(Object.isFrozen(r.tracePercentiles)).toBe(true)
      expect(Object.isFrozen(r.compareBy)).toBe(true)
      expect(Object.isFrozen(r.actions)).toBe(true)
      if (r.whatChanged !== null) expect(Object.isFrozen(r.whatChanged)).toBe(true)
    }
  })
})

describe('inRepertoire: junior', () => {
  const j = (step: ReferenceStep) => inRepertoire('junior', step)

  it('accepts dashboard of a component, logs with window 30 and no filter, restart', () => {
    expect(j(ask({ kind: 'dashboard', service: 'gateway' }))).toBe(true)
    expect(j(ask({ kind: 'dashboard', service: 'postgres' }))).toBe(true)
    expect(j(ask({ kind: 'logs', service: 'payment', window: 30 }))).toBe(true)
    expect(j(act({ kind: 'restart', target: 'payment' }))).toBe(true)
  })

  it('refuses logs with another window or with a filter', () => {
    expect(j(ask({ kind: 'logs', service: 'payment', window: 29 }))).toBe(false)
    expect(j(ask({ kind: 'logs', service: 'payment', window: 60 }))).toBe(false)
    expect(j(ask({ kind: 'logs', service: 'payment', window: 30, filter: { level: 'error' } }))).toBe(false)
    expect(j(ask({ kind: 'logs', service: 'payment', window: 30, filter: {} }))).toBe(false)
  })

  it('refuses trace, whatChanged, compare and rollback', () => {
    for (const percentile of [50, 95, 99] as const) {
      expect(j(ask({ kind: 'trace', service: 'payment', percentile }))).toBe(false)
    }
    expect(j(ask({ kind: 'whatChanged', window: 30 }))).toBe(false)
    expect(j(ask({ kind: 'compare', service: 'payment', metric: 'p95', by: 'instance' }))).toBe(false)
    expect(j(ask({ kind: 'compare', service: 'payment', metric: 'p95', by: 'lastWeek' }))).toBe(false)
    expect(j(act({ kind: 'rollback', target: 'payment' }))).toBe(false)
  })
})

describe('inRepertoire: pleno', () => {
  const p = (step: ReferenceStep) => inRepertoire('pleno', step)

  it('accepts everything of junior', () => {
    expect(p(ask({ kind: 'dashboard', service: 'gateway' }))).toBe(true)
    expect(p(ask({ kind: 'logs', service: 'payment', window: 30 }))).toBe(true)
    expect(p(act({ kind: 'restart', target: 'payment' }))).toBe(true)
  })

  it('accepts logs with window 30, with or without filter; refuses other windows', () => {
    expect(p(ask({ kind: 'logs', service: 'payment', window: 30, filter: { level: 'error' } }))).toBe(true)
    expect(p(ask({ kind: 'logs', service: 'payment', window: 31 }))).toBe(false)
    expect(p(ask({ kind: 'logs', service: 'payment', window: 10, filter: { level: 'error' } }))).toBe(false)
  })

  it('accepts trace with 50, 95 and 99', () => {
    for (const percentile of [50, 95, 99] as const) {
      expect(p(ask({ kind: 'trace', service: 'catalog', percentile }))).toBe(true)
    }
  })

  it('accepts whatChanged only with window 30', () => {
    expect(p(ask({ kind: 'whatChanged', window: 30 }))).toBe(true)
    expect(p(ask({ kind: 'whatChanged', window: 60 }))).toBe(false)
    expect(p(ask({ kind: 'whatChanged', window: 1 }))).toBe(false)
  })

  it('accepts compare by instance; refuses compare by lastWeek and askNpc', () => {
    expect(p(ask({ kind: 'compare', service: 'catalog', metric: 'p95', by: 'instance' }))).toBe(true)
    expect(p(ask({ kind: 'compare', service: 'catalog', metric: 'p95', by: 'lastWeek' }))).toBe(false)
    for (const role of ['dev', 'dba', 'oncall'] as const) {
      expect(p(ask({ kind: 'askNpc', role }))).toBe(false)
    }
  })

  it('accepts rollback with a target', () => {
    expect(p(act({ kind: 'rollback', target: 'catalog' }))).toBe(true)
  })
})

describe('inRepertoire: no senior item at any level', () => {
  it.each(LEVELS)('%s refuses flagOff, declareMitigated, escalate and scale, with or without target', (level) => {
    for (const kind of SENIOR_ACTIONS) {
      expect(inRepertoire(level, act({ kind, target: 'payment' }))).toBe(false)
      expect(inRepertoire(level, act({ kind }))).toBe(false)
    }
    expect(inRepertoire(level, ask({ kind: 'askNpc', role: 'dba' }))).toBe(false)
    expect(inRepertoire(level, ask({ kind: 'compare', service: 'x', metric: 'p95', by: 'lastWeek' }))).toBe(false)
  })

  it('refuses every step for a level without repertoire (senior at runtime)', () => {
    const senior = 'senior' as unknown as PlayableLevel
    expect(inRepertoire(senior, ask({ kind: 'dashboard', service: 'gateway' }))).toBe(false)
    expect(inRepertoire(senior, act({ kind: 'restart', target: 'gateway' }))).toBe(false)
  })
})

describe('inRepertoire: actions need a target', () => {
  it.each(LEVELS)('%s refuses restart without a target or with an empty one', (level) => {
    expect(inRepertoire(level, act({ kind: 'restart' }))).toBe(false)
    expect(inRepertoire(level, act({ kind: 'restart', target: '' }))).toBe(false)
  })
})

describe('inRepertoire: robustness and determinism', () => {
  it('refuses an unknown question kind or step type', () => {
    const unknownAsk = { type: 'ask', question: { kind: 'metrics', service: 'gateway' } } as unknown as ReferenceStep
    const unknownType = { type: 'wait' } as unknown as ReferenceStep
    for (const level of LEVELS) {
      expect(inRepertoire(level, unknownAsk)).toBe(false)
      expect(inRepertoire(level, unknownType)).toBe(false)
    }
  })

  it('is pure: same input, same output, input not mutated', () => {
    const step = ask({ kind: 'logs', service: 'payment', window: 30, filter: { level: 'error' } })
    const before = structuredClone(step)
    expect(inRepertoire('pleno', step)).toBe(inRepertoire('pleno', step))
    expect(step).toStrictEqual(before)
  })
})
