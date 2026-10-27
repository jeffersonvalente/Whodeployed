/**
 * Question patterns of `review.redundant[*]` and `review.keySignalAsk` (ADR-014 §2).
 *
 * YAML syntax: `"<kind>"` or `"<kind> <component>"`, e.g. `"dashboard gateway"`, `"whatChanged"`.
 * A pattern matches every question of that kind (and component), whatever its other parameters.
 * Only kinds whose Question has a `service` accept a component.
 */
import type { Question, QuestionKind } from '@whodeployed/engine'
import type { MatchesPattern, QuestionPattern } from './types.js'

/** Every QuestionKind of the engine contract, and whether its Question names a `service`. */
const KIND_HAS_SERVICE = {
  dashboard: true,
  logs: true,
  trace: true,
  whatChanged: false,
  compare: true,
  askNpc: false,
} as const satisfies Record<QuestionKind, boolean>

export const questionKinds: readonly QuestionKind[] = Object.keys(KIND_HAS_SERVICE) as QuestionKind[]

export function isQuestionKind(value: unknown): value is QuestionKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KIND_HAS_SERVICE, value)
}

/**
 * Parses a pattern string against the components of the scenario's system. Returns the pattern or
 * an English reason for the error (the caller adds file and field).
 */
export function parsePattern(source: unknown, components: readonly string[]): QuestionPattern | string {
  if (typeof source !== 'string') return 'must be a string "<kind>" or "<kind> <component>"'
  const parts = source.trim().split(/\s+/)
  const [kind, service, ...rest] = parts
  if (kind === undefined || kind === '') return 'must be a string "<kind>" or "<kind> <component>"'
  if (!isQuestionKind(kind)) return `unknown question kind '${kind}' (valid values: ${questionKinds.join(', ')})`
  if (rest.length > 0) return `too many words in '${source}'; expected "<kind>" or "<kind> <component>"`
  if (service === undefined) return { kind }
  if (!KIND_HAS_SERVICE[kind]) return `question kind '${kind}' takes no component (received '${service}')`
  if (!components.includes(service)) return `unknown component '${service}' (valid values: ${components.join(', ')})`
  return { kind, service }
}

export const matchesPattern: MatchesPattern = (pattern: QuestionPattern, question: Question): boolean => {
  if (pattern.kind !== question.kind) return false
  if (pattern.service === undefined) return true
  return 'service' in question && question.service === pattern.service
}
