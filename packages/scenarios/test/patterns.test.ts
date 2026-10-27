// T2.10 — question patterns (ADR-014 §2): parse and matchesPattern.
import type { Question } from '@whodeployed/engine'
import { defaultShop } from '@whodeployed/engine'
import { describe, expect, it } from 'vitest'
import { matchesPattern } from '../src/index.js'
import { parsePattern, questionKinds } from '../src/patterns.js'

const components = [...defaultShop.services.map((s) => s.name), ...defaultShop.deps.map((d) => d.name)]

describe('parsePattern', () => {
  it('knows every QuestionKind of the engine contract', () => {
    expect([...questionKinds]).toEqual(['dashboard', 'logs', 'trace', 'whatChanged', 'compare', 'askNpc'])
  })

  it.each([
    ['dashboard gateway', { kind: 'dashboard', service: 'gateway' }],
    ['logs  catalog', { kind: 'logs', service: 'catalog' }],
    ['trace payment', { kind: 'trace', service: 'payment' }],
    ['compare postgres', { kind: 'compare', service: 'postgres' }],
    ['whatChanged', { kind: 'whatChanged' }],
    ['dashboard', { kind: 'dashboard' }],
    ['askNpc', { kind: 'askNpc' }],
  ])('parses %j', (source, expected) => {
    expect(parsePattern(source, components)).toStrictEqual(expected)
  })

  it.each([
    ['graph gateway', /unknown question kind 'graph'/],
    ['dashboard inventory', /unknown component 'inventory'/],
    ['whatChanged catalog', /takes no component/],
    ['askNpc dba', /takes no component/],
    ['dashboard gateway extra', /too many words/],
    ['', /must be a string/],
    [42, /must be a string/],
  ])('rejects %j', (source, reason) => {
    const result = parsePattern(source, components)
    expect(typeof result).toBe('string')
    expect(result).toMatch(reason)
  })
})

describe('matchesPattern', () => {
  const questions: Question[] = [
    { kind: 'dashboard', service: 'gateway' },
    { kind: 'logs', service: 'catalog', window: 30 },
    { kind: 'logs', service: 'catalog', window: 30, filter: { level: 'error' } },
    { kind: 'logs', service: 'auth', window: 30 },
    { kind: 'trace', service: 'payment', percentile: 95 },
    { kind: 'whatChanged', window: 30 },
    { kind: 'compare', service: 'catalog', metric: 'errorPct', by: 'instance' },
    { kind: 'askNpc', role: 'dba' },
  ]
  const matching = (source: string): Question[] => {
    const pattern = parsePattern(source, components)
    if (typeof pattern === 'string') throw new Error(pattern)
    return questions.filter((q) => matchesPattern(pattern, q))
  }

  it('"<kind> <component>" matches that kind and component, whatever the other params', () => {
    expect(matching('logs catalog')).toEqual([questions[1], questions[2]])
  })

  it('"<kind>" matches every question of the kind', () => {
    expect(matching('logs')).toEqual([questions[1], questions[2], questions[3]])
    expect(matching('whatChanged')).toEqual([questions[5]])
    expect(matching('askNpc')).toEqual([questions[7]])
  })

  it('never matches another kind with the same component', () => {
    expect(matching('dashboard catalog')).toEqual([])
    expect(matching('compare catalog')).toEqual([questions[6]])
  })

  it('is pure: same input, same answer', () => {
    const pattern = { kind: 'trace', service: 'payment' } as const
    const q = questions[4] as Question
    expect(matchesPattern(pattern, q)).toBe(true)
    expect(matchesPattern(pattern, q)).toBe(true)
  })
})
