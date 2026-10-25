/**
 * Question handler `trace` (semantics: ADR-006).
 *
 * Among the `server` spans of the component that started in the current tick (`view.now`),
 * sorted by duration (ties: generation order), picks the one at the nearest-rank position of
 * the requested percentile, `sorted[nearestRankIndex(n, p)]`. `nearestRankIndex` is imported
 * from src/sim/metrics.ts, the same function the metrics use (ADR-006 Emenda 1), so the focused
 * duration equals the pXX of the `dashboard` aggregate in the same tick by construction (Q-6).
 * Returns the focused span id and every span of its trace, in generation order.
 * Pure read of the view: no randomness, no state (Q-3, D-4).
 */
import { nearestRankIndex } from '../sim/metrics.js'
import type { QuestionHandler, SpanRecord } from '../types.js'

export const trace: QuestionHandler<'trace'> = (question, ctx) => {
  const { view } = ctx
  const tick = view.now
  const servers = view.spansOf(question.service, tick).filter((span) => span.kind === 'server')
  const base = { kind: 'trace' as const, service: question.service, tick, percentile: question.percentile }
  const focus = nearestRankSpan(servers, question.percentile)
  if (focus === undefined) return { ...base, focusSpanId: null, spans: [] }
  return { ...base, focusSpanId: focus.spanId, spans: [...view.traceOf(focus.traceId)] }
}

/** Nearest-rank span by duration; stable on ties (generation order). undefined when empty. */
function nearestRankSpan(spans: readonly SpanRecord[], percentile: number): SpanRecord | undefined {
  const sorted = spans
    .map((span, index) => ({ span, index }))
    .sort((a, b) => a.span.durationMs - b.span.durationMs || a.index - b.index)
  return sorted[nearestRankIndex(sorted.length, percentile)]?.span
}
