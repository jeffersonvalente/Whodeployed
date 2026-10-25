/**
 * Question handler `trace` (semantics: ADR-006).
 *
 * Among the `server` spans of the component that started in the current tick (`view.now`),
 * sorted by duration (ties: generation order), picks the one at the nearest-rank position of
 * the requested percentile, `sorted[ceil(p / 100 * n) - 1]` (ADR-005). That is the same rule
 * the metrics use, so the focused duration equals the pXX of the `dashboard` aggregate in the
 * same tick (Q-6). Returns the focused span id and every span of its trace, in generation order.
 * Pure read of the view: no randomness, no state (Q-3, D-4).
 */
import type { QuestionHandler, SpanRecord } from '../types.js'

export const trace: QuestionHandler<'trace'> = (question, ctx) => {
  const { view } = ctx
  const tick = view.now
  const servers = view.spansOf(question.service, tick).filter((span) => span.kind === 'server')
  const base = { kind: 'trace' as const, service: question.service, tick, percentile: question.percentile }
  const focus = nearestRank(servers, question.percentile)
  if (focus === undefined) return { ...base, focusSpanId: null, spans: [] }
  return { ...base, focusSpanId: focus.spanId, spans: [...view.traceOf(focus.traceId)] }
}

/** Nearest-rank span by duration; stable on ties (generation order). undefined when empty. */
function nearestRank(spans: readonly SpanRecord[], percentile: number): SpanRecord | undefined {
  const sorted = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.durationMs - b.span.durationMs || a.index - b.index)
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length))
  return sorted[rank - 1]?.span
}
