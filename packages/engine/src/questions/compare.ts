/**
 * Question handler `compare` (semantics: ADR-006).
 *
 * Fixed window of 30 ticks, `[max(0, now - 30), now]`.
 * - `by: 'instance'`: one series per instance of the component, in world order, label = id.
 * - `by: 'lastWeek'`: two series, `current` (aggregate of this run) and `lastWeek` (aggregate of
 *   the view returned by `ctx.lastWeek()`, the fault-free run with seed `${seed}:lastWeek`,
 *   ADR-003; building that run is the dispatcher's job, T1.16), over the same ticks.
 * `question.metric` is already validated as a MetricName by the dispatcher (Q-10).
 * Pure read of the views: no randomness, no state (Q-3, D-4).
 */
import type {
  CompareSeries,
  ComponentName,
  InstanceId,
  MetricName,
  MetricPoint,
  MetricRecord,
  QuestionHandler,
  TelemetryView,
} from '../types.js'

/** Window of `compare`, in ticks (ADR-006). */
export const COMPARE_WINDOW_TICKS = 30

export const compare: QuestionHandler<'compare'> = (question, ctx) => {
  const { view } = ctx
  const to = view.now
  const from = Math.max(0, to - COMPARE_WINDOW_TICKS)
  const metric = question.metric as MetricName
  const records = view.metricsOf(question.service, from, to)

  let series: CompareSeries[]
  if (question.by === 'instance') {
    series = instancesOf(view, question.service).map((id) => ({
      label: id,
      points: points(
        records.filter((r) => r.instance === id),
        metric,
      ),
    }))
  } else {
    const lastWeek = ctx.lastWeek().metricsOf(question.service, from, to)
    series = [
      { label: 'current', points: points(records.filter(isAggregate), metric) },
      { label: 'lastWeek', points: points(lastWeek.filter(isAggregate), metric) },
    ]
  }
  return { kind: 'compare', service: question.service, metric, by: question.by, from, to, series }
}

function instancesOf(view: TelemetryView, component: ComponentName): readonly InstanceId[] {
  const found =
    view.world.services.find((s) => s.name === component) ?? view.world.deps.find((d) => d.name === component)
  return found?.instances ?? []
}

const isAggregate = (record: MetricRecord): boolean => record.instance === undefined

function points(records: readonly MetricRecord[], metric: MetricName): MetricPoint[] {
  return records.map((r) => ({ tick: r.tick, value: r[metric] }))
}
