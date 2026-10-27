// @vitest-environment node
/**
 * Notebook core (T2.23): PR-9 (hypothesis, discard with citation), PR-10 (end with active / new /
 * unknown; nothing after the end) and DET (same inputs => same outputs, inputs untouched).
 * Pure module: tested over hand-built SessionStep lists, independent of session.ts.
 */
import { defaultShop } from '@whodeployed/engine'
import type { Action, ActionResult, Answer, Question } from '@whodeployed/engine'
import { describe, expect, it } from 'vitest'
import {
  activeHypotheses,
  checkDiscard,
  checkEnd,
  checkHypothesis,
  hypothesesOf,
  systemComponents,
  type NotebookResult,
} from '../../src/session/notebook'
import type { SessionStep } from '../../src/session/types'

const components = systemComponents(defaultShop)

// The notebook reads only `type` and `seq` of ask/act steps; the payloads are opaque here.
const question: Question = { kind: 'logs', service: 'catalog', window: 30 }
const answer = { question, tickCost: 3 } as unknown as Answer
const action: Action = { kind: 'restart', target: 'catalog' }
const result = { tickCost: 3 } as unknown as ActionResult

const base = (seq: number) => ({ seq, tickBefore: 14, tickCost: 0, impactAfter: 0, wallMs: 0 })
const ask = (seq: number): SessionStep => ({ ...base(seq), type: 'ask', question, answer, tickCost: 3 })
const act = (seq: number): SessionStep => ({ ...base(seq), type: 'act', action, result, tickCost: 3 })
const wait = (seq: number): SessionStep => ({ ...base(seq), type: 'wait', tickCost: 1 })
const hyp = (seq: number, component = 'catalog', text = 'crash loop'): SessionStep => ({
  ...base(seq),
  type: 'hypothesis',
  component,
  text,
})
const disc = (seq: number, hypothesisSeq: number, citedSeqs: number[]): SessionStep => ({
  ...base(seq),
  type: 'discard',
  hypothesisSeq,
  citedSeqs,
})
const end = (seq: number): SessionStep => ({ ...base(seq), type: 'end', final: { kind: 'unknown' }, reason: 'player' })

function code<T>(r: NotebookResult<T>): string {
  return r.ok ? 'ok' : r.code
}

describe('systemComponents', () => {
  it('lists the 9 components of default-shop, services then dependencies (SPEC §4)', () => {
    expect(components).toEqual([
      'gateway',
      'auth',
      'catalog',
      'cart',
      'payment',
      'orders-worker',
      'postgres',
      'redis',
      'queue',
    ])
  })
})

describe('checkHypothesis (PR-9)', () => {
  it('accepts each of the 9 components with non-empty text and trims the text', () => {
    for (const c of components) {
      expect(checkHypothesis([], components, c, '  pool leak \n')).toEqual({
        ok: true,
        value: { type: 'hypothesis', component: c, text: 'pool leak' },
      })
    }
  })

  it('rejects a component outside the 9', () => {
    expect(code(checkHypothesis([], components, 'billing', 'x'))).toBe('unknown_component')
    expect(code(checkHypothesis([], components, '', 'x'))).toBe('unknown_component')
    expect(code(checkHypothesis([], components, 'Catalog', 'x'))).toBe('unknown_component')
  })

  it('rejects empty or whitespace-only text', () => {
    expect(code(checkHypothesis([], components, 'catalog', ''))).toBe('empty_text')
    expect(code(checkHypothesis([], components, 'catalog', ' \t\n '))).toBe('empty_text')
  })

  it('needs no previous answer: a hypothesis may come before any question', () => {
    expect(code(checkHypothesis([], components, 'redis', 'cold cache'))).toBe('ok')
  })
})

describe('checkDiscard (PR-9)', () => {
  const steps = [ask(1), hyp(2), act(3), wait(4), ask(5)]

  it('accepts a discard citing previous ask steps, keeping order, and omits empty text', () => {
    expect(checkDiscard(steps, 2, [5, 1])).toEqual({
      ok: true,
      value: { type: 'discard', hypothesisSeq: 2, citedSeqs: [5, 1] },
    })
    expect(checkDiscard(steps, 2, [1], '   ')).toEqual({
      ok: true,
      value: { type: 'discard', hypothesisSeq: 2, citedSeqs: [1] },
    })
  })

  it('keeps optional text, trimmed', () => {
    expect(checkDiscard(steps, 2, [5], '  logs show no crash  ')).toEqual({
      ok: true,
      value: { type: 'discard', hypothesisSeq: 2, citedSeqs: [5], text: 'logs show no crash' },
    })
  })

  it('may cite an answer given before the hypothesis was written', () => {
    expect(code(checkDiscard(steps, 2, [1]))).toBe('ok')
  })

  it('rejects a discard without citation', () => {
    expect(code(checkDiscard(steps, 2, []))).toBe('no_citation')
    expect(code(checkDiscard(steps, 2, [], 'I just feel it'))).toBe('no_citation')
  })

  it('rejects citing a non-ask step (hypothesis, act, wait)', () => {
    expect(code(checkDiscard(steps, 2, [2]))).toBe('invalid_citation')
    expect(code(checkDiscard(steps, 2, [3]))).toBe('invalid_citation')
    expect(code(checkDiscard(steps, 2, [4]))).toBe('invalid_citation')
  })

  it('rejects citing a future or nonexistent step', () => {
    expect(code(checkDiscard(steps, 2, [6]))).toBe('invalid_citation')
    expect(code(checkDiscard(steps, 2, [0]))).toBe('invalid_citation')
    expect(code(checkDiscard(steps, 2, [-1]))).toBe('invalid_citation')
    expect(code(checkDiscard(steps, 2, [1.5]))).toBe('invalid_citation')
  })

  it('rejects one bad citation among good ones, and repeated citations', () => {
    expect(code(checkDiscard(steps, 2, [1, 3]))).toBe('invalid_citation')
    expect(code(checkDiscard(steps, 2, [1, 1]))).toBe('invalid_citation')
  })

  it('rejects a target that is not a hypothesis', () => {
    expect(code(checkDiscard(steps, 1, [1]))).toBe('unknown_hypothesis')
    expect(code(checkDiscard(steps, 9, [1]))).toBe('unknown_hypothesis')
  })

  it('rejects discarding a hypothesis twice', () => {
    expect(code(checkDiscard([...steps, disc(6, 2, [1])], 2, [5]))).toBe('hypothesis_discarded')
  })
})

describe('hypothesesOf / activeHypotheses', () => {
  it('derives the notebook state from the steps', () => {
    const steps = [ask(1), hyp(2, 'catalog', 'a'), hyp(3, 'postgres', 'b'), disc(4, 2, [1])]
    expect(hypothesesOf(steps)).toEqual([
      { seq: 2, component: 'catalog', text: 'a', discardedBy: 4 },
      { seq: 3, component: 'postgres', text: 'b' },
    ])
    expect(activeHypotheses(steps)).toEqual([{ seq: 3, component: 'postgres', text: 'b' }])
    expect(hypothesesOf([])).toEqual([])
  })
})

describe('checkEnd (PR-10)', () => {
  const steps = [ask(1), hyp(2, 'catalog', 'a'), hyp(3, 'cart', 'b'), disc(4, 2, [1])]

  it('ends with an active hypothesis', () => {
    expect(checkEnd(steps, components, { kind: 'active', hypothesisSeq: 3 })).toEqual({
      ok: true,
      value: { type: 'end', final: { kind: 'active', hypothesisSeq: 3 }, reason: 'player' },
    })
  })

  it('rejects a discarded or nonexistent hypothesis as final', () => {
    expect(code(checkEnd(steps, components, { kind: 'active', hypothesisSeq: 2 }))).toBe('hypothesis_discarded')
    expect(code(checkEnd(steps, components, { kind: 'active', hypothesisSeq: 1 }))).toBe('unknown_hypothesis')
    expect(code(checkEnd(steps, components, { kind: 'active', hypothesisSeq: 7 }))).toBe('unknown_hypothesis')
  })

  it('ends with a new hypothesis (component among the 9, text trimmed and non-empty)', () => {
    expect(checkEnd(steps, components, { kind: 'new', component: 'queue', text: ' backlog ' })).toEqual({
      ok: true,
      value: { type: 'end', final: { kind: 'new', component: 'queue', text: 'backlog' }, reason: 'player' },
    })
    expect(code(checkEnd(steps, components, { kind: 'new', component: 'billing', text: 'x' }))).toBe(
      'unknown_component',
    )
    expect(code(checkEnd(steps, components, { kind: 'new', component: 'queue', text: '  ' }))).toBe('empty_text')
  })

  it('ends with unknown, even with no hypothesis at all', () => {
    expect(checkEnd([], components, { kind: 'unknown' })).toEqual({
      ok: true,
      value: { type: 'end', final: { kind: 'unknown' }, reason: 'player' },
    })
  })
})

describe('after the end (PR-10)', () => {
  it('rejects every notebook operation with session_ended', () => {
    const steps = [ask(1), hyp(2), end(3)]
    expect(code(checkHypothesis(steps, components, 'catalog', 'x'))).toBe('session_ended')
    expect(code(checkDiscard(steps, 2, [1]))).toBe('session_ended')
    expect(code(checkEnd(steps, components, { kind: 'unknown' }))).toBe('session_ended')
    expect(code(checkEnd(steps, components, { kind: 'active', hypothesisSeq: 2 }))).toBe('session_ended')
  })

  it('also after a tick-limit end', () => {
    const steps: SessionStep[] = [ask(1), { ...base(2), type: 'end', final: { kind: 'unknown' }, reason: 'tickLimit' }]
    expect(code(checkHypothesis(steps, components, 'catalog', 'x'))).toBe('session_ended')
  })
})

describe('DET', () => {
  it('same inputs give the same outputs twice and never mutate the inputs', () => {
    const run = () => {
      const steps = Object.freeze([ask(1), hyp(2), ask(3)].map((s) => Object.freeze(s)))
      const cited = Object.freeze([3, 1])
      const before = JSON.stringify(steps)
      const out = [
        checkHypothesis(steps, components, 'postgres', ' disk full '),
        checkDiscard(steps, 2, cited, ' no errors in logs '),
        checkEnd(steps, components, { kind: 'new', component: 'postgres', text: 'disk' }),
        checkDiscard(steps, 2, []),
        hypothesesOf(steps),
      ]
      expect(JSON.stringify(steps)).toBe(before)
      return JSON.stringify(out)
    }
    expect(run()).toBe(run())
  })

  it('the discard payload does not alias the caller array', () => {
    const cited = [1]
    const r = checkDiscard([ask(1), hyp(2)], 2, cited)
    cited.push(99)
    expect(r.ok && r.value.citedSeqs).toEqual([1])
  })
})
