/**
 * EngineError (T1.4; class used by F-7 and Q-10): implements EngineErrorInfo, is an Error,
 * always names the field and lists the valid values in its message, and is deterministic.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { EngineError, describeValue, isEngineError } from '../src/errors.js'
import type { EngineErrorInfo } from '../src/types.js'

describe('EngineError', () => {
  it('is an Error implementing EngineErrorInfo', () => {
    const error = new EngineError({
      code: 'unknown_metric',
      field: 'question.metric',
      received: 'latency',
      validValues: ['rps', 'p95'],
      message: 'question.metric: unknown metric',
    })
    expectTypeOf(error).toMatchTypeOf<EngineErrorInfo>()
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(EngineError)
    expect(isEngineError(error)).toBe(true)
    expect(isEngineError(new Error('x'))).toBe(false)
    expect(error.name).toBe('EngineError')
    expect(error.code).toBe('unknown_metric')
    expect(error.field).toBe('question.metric')
    expect(error.received).toBe('latency')
    expect(error.validValues).toEqual(['rps', 'p95'])
    expect(error.message).toBe('question.metric: unknown metric (received "latency"). Valid values: rps, p95')
    expect(error.stack).toContain('EngineError')
  })

  it('adds the field and the valid values to a message that lacks them', () => {
    const error = new EngineError({ code: 'invalid_window', field: 'question.window', received: 0, validValues: ['1..'], message: 'must be >= 1' })
    expect(error.message).toBe('question.window: must be >= 1 (received 0). Valid values: 1..')
  })

  it('keeps a message that already names the field, the received value and the valid values', () => {
    const message = '--ticks: received "x"; valid values: 1..100000'
    const error = new EngineError({ code: 'usage', field: '--ticks', received: 'x', validValues: ['1..100000'], message })
    expect(error.message).toBe(message)
  })

  it('omits validValues when the set is not finite', () => {
    const error = new EngineError({ code: 'invalid_seed', field: 'seed', received: '', message: 'seed must be a non-empty string' })
    expect(error).not.toHaveProperty('validValues')
    expect(Object.keys(error.toJSON())).toEqual(['name', 'code', 'field', 'received', 'message'])
    expect(error.message).toBe('seed must be a non-empty string (received "")')
  })

  it('renders an empty valid set as "(none)"', () => {
    const error = new EngineError({ code: 'invalid_target', field: 'faults[0].target', received: 'db', validValues: [], message: 'no target' })
    expect(error.message).toContain('Valid values: (none)')
  })

  it('copies validValues, so mutating the source array does not change the error', () => {
    const valid = ['a', 'b']
    const error = new EngineError({ code: 'invalid_role', field: 'question.role', received: 'cto', validValues: valid, message: 'bad role' })
    valid.push('c')
    expect(error.validValues).toEqual(['a', 'b'])
  })

  it('toJSON returns the plain EngineErrorInfo and survives JSON.stringify', () => {
    const error = new EngineError({ code: 'unknown_param', field: 'faults[0].params.x', received: 'x', validValues: ['poolSize'], message: 'unknown parameter' })
    const info: EngineErrorInfo = error.toJSON()
    expect(info).toStrictEqual({
      name: 'EngineError',
      code: 'unknown_param',
      field: 'faults[0].params.x',
      received: 'x',
      message: error.message,
      validValues: ['poolSize'],
    })
    expect(JSON.parse(JSON.stringify(error))).toStrictEqual(JSON.parse(JSON.stringify(info)))
  })

  it('is deterministic: same init => same message and JSON', () => {
    const init = { code: 'invalid_percentile', field: 'question.percentile', received: 90, validValues: [50, 95, 99], message: 'bad percentile' } as const
    expect(new EngineError(init).toJSON()).toStrictEqual(new EngineError(init).toJSON())
  })
})

describe('describeValue', () => {
  it.each([
    [undefined, 'undefined'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [-2.5, '-2.5'],
    [10n, '10n'],
    ['s', '"s"'],
    [null, 'null'],
    [{ a: 1 }, '{"a":1}'],
    [[1, 2], '[1,2]'],
  ])('%s -> %s', (value, expected) => {
    expect(describeValue(value)).toBe(expected)
  })

  it('handles functions, symbols, circular values and long values', () => {
    expect(describeValue(Symbol('k'))).toBe('Symbol(k)')
    expect(describeValue({ toJSON: () => undefined })).toBe('[object Object]')
    expect(describeValue(function f() {})).toContain('function')
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(describeValue(circular)).toBe('[object Object]')
    const long = describeValue('x'.repeat(200))
    expect(long.length).toBe(80)
    expect(long.endsWith('...')).toBe(true)
  })
})
