/**
 * Question handler `logs` (semantics: ADR-006).
 *
 * Returns the log entries of the asked component whose tick lies in the closed window
 * [max(0, now - window), now], `window` measured in ticks (Q-5). With `filter`, an entry is
 * kept only when every `key: value` pair matches: the key names a top-level field of the entry
 * (`level`, `instance`, `message`, `traceId`) or, otherwise, a key of `attrs`; the comparison
 * is `String(entryValue) === value`. A key missing from the entry does not match. An empty or
 * absent filter means no filter. Entry order is the telemetry order (ADR-005).
 */
import type { LogRecord, QuestionHandler } from '../types.js'

/** Top-level log fields a filter key may address (ADR-006); any other key is looked up in `attrs`. */
const TOP_LEVEL_FIELDS: readonly string[] = ['level', 'instance', 'message', 'traceId']

function fieldValue(entry: LogRecord, key: string): string | number | undefined {
  if (TOP_LEVEL_FIELDS.includes(key)) return entry[key as 'level' | 'instance' | 'message' | 'traceId']
  const attrs = entry.attrs
  if (attrs === undefined || !Object.hasOwn(attrs, key)) return undefined
  return attrs[key]
}

/** True when `entry` matches every pair of `filter` (ADR-006). An empty filter matches everything. */
export function matchesFilter(entry: LogRecord, filter: Readonly<Record<string, string>>): boolean {
  for (const key of Object.keys(filter)) {
    const value = fieldValue(entry, key)
    if (value === undefined || String(value) !== filter[key]) return false
  }
  return true
}

export const logs: QuestionHandler<'logs'> = (question, ctx) => {
  const { view } = ctx
  const to = view.now
  const from = Math.max(0, to - question.window)
  const inWindow = view.logsOf(question.service, from, to)
  const filter = question.filter
  const entries = filter === undefined ? inWindow : inWindow.filter((entry) => matchesFilter(entry, filter))
  return { kind: 'logs', service: question.service, from, to, entries }
}
