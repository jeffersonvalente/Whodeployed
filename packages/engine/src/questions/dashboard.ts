/**
 * Question handler `dashboard` (semantics: ADR-006).
 *
 * Returns the component aggregate MetricRecords (the ones without `instance`) of the asked
 * component, one per tick of the fixed 30-tick window [max(0, now - 30), now] (Q-4). The
 * records come straight from the telemetry view, so the dashboard can never disagree with the
 * NDJSON (SPEC §3.3). `service` may be any component of the world, service or dependency
 * (SPEC §7 `dashboard postgres`); the dispatcher has already validated it (Q-10).
 */
import type { QuestionHandler } from '../types.js'

/** Fixed dashboard window, in ticks (ADR-006). */
export const DASHBOARD_WINDOW_TICKS = 30

export const dashboard: QuestionHandler<'dashboard'> = (question, ctx) => {
  const { view } = ctx
  const to = view.now
  const from = Math.max(0, to - DASHBOARD_WINDOW_TICKS)
  const records = view.metricsOf(question.service, from, to).filter((record) => record.instance === undefined)
  return { kind: 'dashboard', service: question.service, from, to, records }
}
