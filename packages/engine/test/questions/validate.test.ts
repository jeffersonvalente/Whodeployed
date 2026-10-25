/**
 * T1.16 — Question validation (Q-10, ADR-006 "Validação"): one case per error, plus the
 * normalized copy returned for valid questions (Q-2 echo) and Q-1 (no level parameter).
 */
import { describe, expect, it } from 'vitest'
import { EngineError } from '../../src/errors.js'
import { validateQuestion } from '../../src/questions/validate.js'
import type { EngineErrorCode } from '../../src/types.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'

const built = buildWorld(defaultShop, 'validate')
const world = { services: built.services, deps: built.deps, tick: 0, seed: built.seed }
const components = ['gateway', 'auth', 'catalog', 'cart', 'payment', 'orders-worker', 'postgres', 'redis', 'queue']
const kinds = ['dashboard', 'logs', 'trace', 'whatChanged', 'compare', 'askNpc']
const metrics = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']

function caught(question: unknown): EngineError {
  try {
    validateQuestion(question, world)
  } catch (error) {
    if (error instanceof EngineError) return error
    throw new Error(`expected EngineError, got ${String(error)}`)
  }
  throw new Error('expected validateQuestion to throw')
}

interface Case {
  name: string
  question: unknown
  code: EngineErrorCode
  field: string
  validValues?: readonly (string | number)[]
}

const cases: Case[] = [
  { name: 'question is null', question: null, code: 'invalid_question', field: 'question' },
  { name: 'question is an array', question: [], code: 'invalid_question', field: 'question' },
  { name: 'question is a string', question: 'dashboard', code: 'invalid_question', field: 'question' },
  { name: 'unknown kind', question: { kind: 'metrics', service: 'gateway' }, code: 'invalid_question', field: 'question.kind', validValues: kinds },
  { name: 'missing kind', question: { service: 'gateway' }, code: 'invalid_question', field: 'question.kind', validValues: kinds },
  { name: 'level parameter (Q-1)', question: { kind: 'dashboard', service: 'gateway', level: 'junior' }, code: 'invalid_question', field: 'question.level', validValues: ['kind', 'service'] },
  { name: 'field of another kind', question: { kind: 'whatChanged', window: 30, service: 'gateway' }, code: 'invalid_question', field: 'question.service', validValues: ['kind', 'window'] },
  { name: 'unknown service (dashboard)', question: { kind: 'dashboard', service: 'billing' }, code: 'unknown_service', field: 'question.service', validValues: components },
  { name: 'missing service (logs)', question: { kind: 'logs', window: 30 }, code: 'unknown_service', field: 'question.service', validValues: components },
  { name: 'non-string service (trace)', question: { kind: 'trace', service: 1, percentile: 95 }, code: 'unknown_service', field: 'question.service', validValues: components },
  { name: 'unknown service (compare)', question: { kind: 'compare', service: 'Gateway', metric: 'rps', by: 'instance' }, code: 'unknown_service', field: 'question.service', validValues: components },
  { name: 'window = 0 (logs)', question: { kind: 'logs', service: 'gateway', window: 0 }, code: 'invalid_window', field: 'question.window' },
  { name: 'window < 0 (whatChanged)', question: { kind: 'whatChanged', window: -5 }, code: 'invalid_window', field: 'question.window' },
  { name: 'window not integer', question: { kind: 'logs', service: 'gateway', window: 2.5 }, code: 'invalid_window', field: 'question.window' },
  { name: 'window as string', question: { kind: 'whatChanged', window: '30' }, code: 'invalid_window', field: 'question.window' },
  { name: 'window missing', question: { kind: 'whatChanged' }, code: 'invalid_window', field: 'question.window' },
  { name: 'window NaN', question: { kind: 'whatChanged', window: Number.NaN }, code: 'invalid_window', field: 'question.window' },
  { name: 'window Infinity', question: { kind: 'whatChanged', window: Number.POSITIVE_INFINITY }, code: 'invalid_window', field: 'question.window' },
  { name: 'percentile 90', question: { kind: 'trace', service: 'payment', percentile: 90 }, code: 'invalid_percentile', field: 'question.percentile', validValues: [50, 95, 99] },
  { name: 'percentile as string', question: { kind: 'trace', service: 'payment', percentile: '95' }, code: 'invalid_percentile', field: 'question.percentile', validValues: [50, 95, 99] },
  { name: 'unknown metric', question: { kind: 'compare', service: 'payment', metric: 'latency', by: 'instance' }, code: 'unknown_metric', field: 'question.metric', validValues: metrics },
  { name: 'unknown by', question: { kind: 'compare', service: 'payment', metric: 'p95', by: 'yesterday' }, code: 'invalid_question', field: 'question.by', validValues: ['instance', 'lastWeek'] },
  { name: 'unknown role', question: { kind: 'askNpc', role: 'cto' }, code: 'invalid_role', field: 'question.role', validValues: ['dev', 'dba', 'oncall'] },
  { name: 'filter null', question: { kind: 'logs', service: 'gateway', window: 30, filter: null }, code: 'invalid_filter', field: 'question.filter' },
  { name: 'filter array', question: { kind: 'logs', service: 'gateway', window: 30, filter: ['level'] }, code: 'invalid_filter', field: 'question.filter' },
  { name: 'filter value not a string', question: { kind: 'logs', service: 'gateway', window: 30, filter: { status: 500 } }, code: 'invalid_filter', field: 'question.filter.status' },
]

describe('validateQuestion errors (Q-10)', () => {
  for (const c of cases) {
    it(`${c.name} -> ${c.code} on ${c.field}`, () => {
      const error = caught(c.question)
      expect(error).toBeInstanceOf(EngineError)
      expect(error.name).toBe('EngineError')
      expect(error.code).toBe(c.code)
      expect(error.field).toBe(c.field)
      expect(error.message).toContain(c.field)
      if (c.validValues !== undefined) {
        expect(error.validValues).toEqual(c.validValues)
        for (const v of c.validValues) expect(error.message).toContain(String(v))
      }
      if (c.code === 'invalid_window') {
        // The range is infinite, but the message still states what is valid.
        expect(error.message).toContain('>= 1')
      }
    })
  }

  it('reports the first invalid field in contract order', () => {
    expect(caught({ kind: 'compare', service: 'nope', metric: 'nope', by: 'nope' }).field).toBe('question.service')
    expect(caught({ kind: 'compare', service: 'payment', metric: 'nope', by: 'nope' }).field).toBe('question.metric')
    expect(caught({ kind: 'logs', service: 'gateway', window: 0, filter: null }).field).toBe('question.window')
  })

  it('same invalid input => same error (DET)', () => {
    for (const c of cases) expect(caught(c.question).toJSON()).toStrictEqual(caught(c.question).toJSON())
  })
})

describe('validateQuestion normalized copy (Q-2)', () => {
  const valid = [
    { kind: 'dashboard', service: 'gateway' },
    { kind: 'dashboard', service: 'postgres' },
    { kind: 'logs', service: 'payment', window: 30 },
    { kind: 'logs', service: 'payment', window: 1, filter: {} },
    { kind: 'logs', service: 'payment', window: 30, filter: { level: 'error', instance: 'payment-1' } },
    { kind: 'trace', service: 'payment', percentile: 50 },
    { kind: 'trace', service: 'redis', percentile: 99 },
    { kind: 'whatChanged', window: 30 },
    { kind: 'compare', service: 'payment', metric: 'connections', by: 'instance' },
    { kind: 'compare', service: 'queue', metric: 'p95', by: 'lastWeek' },
    { kind: 'askNpc', role: 'dev' },
    { kind: 'askNpc', role: 'dba' },
    { kind: 'askNpc', role: 'oncall' },
  ] as const

  for (const q of valid) {
    it(`accepts ${JSON.stringify(q)} and returns a frozen deep-equal copy`, () => {
      const out = validateQuestion(q, world)
      expect(out).toStrictEqual(q)
      expect(out).not.toBe(q)
      expect(Object.isFrozen(out)).toBe(true)
      expect(Object.keys(out)).toEqual(Object.keys(q))
    })
  }

  it('keys come back in contract order whatever the input order', () => {
    const out = validateQuestion({ by: 'instance', metric: 'rps', service: 'cart', kind: 'compare' }, world)
    expect(Object.keys(out)).toEqual(['kind', 'service', 'metric', 'by'])
  })

  it('copies the filter: later changes to the caller object do not reach the copy', () => {
    const filter: Record<string, string> = { level: 'error' }
    const out = validateQuestion({ kind: 'logs', service: 'payment', window: 30, filter }, world)
    filter['level'] = 'info'
    filter['extra'] = 'x'
    expect(out).toStrictEqual({ kind: 'logs', service: 'payment', window: 30, filter: { level: 'error' } })
    expect(out.kind === 'logs' && Object.isFrozen(out.filter)).toBe(true)
  })

  it('an explicit undefined filter is the same as no filter', () => {
    const out = validateQuestion({ kind: 'logs', service: 'payment', window: 30, filter: undefined }, world)
    expect(Object.keys(out)).toEqual(['kind', 'service', 'window'])
  })

  it('a "__proto__" filter key stays an own key and does not change the prototype', () => {
    const filter = JSON.parse('{"__proto__": "x"}') as Record<string, string>
    const out = validateQuestion({ kind: 'logs', service: 'payment', window: 30, filter }, world)
    const copied = out.kind === 'logs' ? out.filter : undefined
    expect(Object.keys(copied ?? {})).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
  })
})
