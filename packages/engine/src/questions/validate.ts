/**
 * Question validation (Q-10, ADR-006 "Validação").
 *
 * Runs before any handler. Every invalid question throws an EngineError whose `field` is
 * `question.<field>` and whose message lists the valid values; never undefined, never a generic
 * error. Valid questions come back as a fresh, frozen copy with the keys of the contract
 * (SPEC §6) in contract order, so the Answer echoes a question the caller can no longer change
 * (Q-2: deep equality with what was asked).
 *
 * No player-level parameter exists (Q-1): a key outside the contract of the kind, whatever its
 * name, is rejected as `invalid_question`.
 */
import { EngineError } from '../errors.js'
import type { EngineErrorCode, MetricName, Question, QuestionKind, World } from '../types.js'

export const QUESTION_KINDS: readonly QuestionKind[] = ['dashboard', 'logs', 'trace', 'whatChanged', 'compare', 'askNpc']
export const PERCENTILES: readonly (50 | 95 | 99)[] = [50, 95, 99]
export const METRIC_NAMES: readonly MetricName[] = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']
export const COMPARE_BY: readonly ('instance' | 'lastWeek')[] = ['instance', 'lastWeek']
export const NPC_ROLES: readonly ('dev' | 'dba' | 'oncall')[] = ['dev', 'dba', 'oncall']

/** Keys each kind accepts, in contract order (SPEC §6). */
const KEYS: { readonly [K in QuestionKind]: readonly string[] } = {
  dashboard: ['kind', 'service'],
  logs: ['kind', 'service', 'window', 'filter'],
  trace: ['kind', 'service', 'percentile'],
  whatChanged: ['kind', 'window'],
  compare: ['kind', 'service', 'metric', 'by'],
  askNpc: ['kind', 'role'],
}

function fail(
  code: EngineErrorCode,
  field: string,
  received: unknown,
  message: string,
  validValues?: readonly (string | number)[],
): never {
  throw new EngineError({ code, field, received, message, ...(validValues !== undefined ? { validValues } : {}) })
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function serviceOf(q: Record<string, unknown>, world: Readonly<World>): string {
  const names = [...world.services, ...world.deps].map((c) => c.name)
  const value = q['service']
  if (typeof value !== 'string' || !names.includes(value)) {
    fail('unknown_service', 'question.service', value, 'unknown component', names)
  }
  return value
}

function windowOf(q: Record<string, unknown>): number {
  const value = q['window']
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail('invalid_window', 'question.window', value, 'window must be an integer number of ticks >= 1', ['integer >= 1'])
  }
  return value
}

function filterOf(q: Record<string, unknown>): Record<string, string> | undefined {
  const value = q['filter']
  if (value === undefined) return undefined
  if (!isPlainObject(value)) fail('invalid_filter', 'question.filter', value, 'filter must be an object of string values')
  const entries = Object.keys(value).map((key): [string, string] => {
    const v = value[key]
    if (typeof v !== 'string') fail('invalid_filter', `question.filter.${key}`, v, 'filter values must be strings')
    return [key, v]
  })
  // Object.fromEntries defines own data properties, so a key such as "__proto__" stays a key.
  return Object.freeze(Object.fromEntries(entries))
}

function oneOf<T extends string | number>(
  q: Record<string, unknown>,
  key: string,
  values: readonly T[],
  code: EngineErrorCode,
  message: string,
): T {
  const value = q[key]
  if (!values.includes(value as T)) fail(code, `question.${key}`, value, message, values)
  return value as T
}

/**
 * Validates `question` against the world and returns a frozen normalized copy.
 * Throws EngineError (Q-10) on the first invalid field, in contract order.
 */
export function validateQuestion(question: unknown, world: Readonly<World>): Question {
  if (!isPlainObject(question)) fail('invalid_question', 'question', question, 'question must be an object')
  const kind = question['kind']
  if (!QUESTION_KINDS.includes(kind as QuestionKind)) {
    fail('invalid_question', 'question.kind', kind, 'unknown question kind', QUESTION_KINDS)
  }
  const k = kind as QuestionKind
  for (const key of Object.keys(question)) {
    if (!KEYS[k].includes(key)) {
      fail('invalid_question', `question.${key}`, question[key], `unknown field for a '${k}' question`, KEYS[k])
    }
  }

  let normalized: Question
  switch (k) {
    case 'dashboard':
      normalized = { kind: k, service: serviceOf(question, world) }
      break
    case 'logs': {
      const s = serviceOf(question, world)
      const w = windowOf(question)
      const f = filterOf(question)
      normalized = f === undefined ? { kind: k, service: s, window: w } : { kind: k, service: s, window: w, filter: f }
      break
    }
    case 'trace':
      normalized = {
        kind: k,
        service: serviceOf(question, world),
        percentile: oneOf(question, 'percentile', PERCENTILES, 'invalid_percentile', 'percentile must be 50, 95 or 99'),
      }
      break
    case 'whatChanged':
      normalized = { kind: k, window: windowOf(question) }
      break
    case 'compare':
      normalized = {
        kind: k,
        service: serviceOf(question, world),
        metric: oneOf(question, 'metric', METRIC_NAMES, 'unknown_metric', 'unknown metric'),
        by: oneOf(question, 'by', COMPARE_BY, 'invalid_question', 'unknown comparison'),
      }
      break
    case 'askNpc':
      normalized = { kind: k, role: oneOf(question, 'role', NPC_ROLES, 'invalid_role', 'unknown NPC role') }
      break
  }
  return Object.freeze(normalized)
}
