/**
 * Question handler `askNpc` (semantics: ADR-006).
 *
 * An NPC is a person who knows what "usual" looks like for their slice of the system. The
 * answer is structured data only (Q-9): up to 3 hints, each naming a component (and, for the
 * on-call, an instance), a metric and two numbers. No prose and no fault kind: the NPC points at
 * anomalies, it never names the root cause (SPEC §3.2, §3.4). The words an NPC says are content
 * of phase 3, built from these fields.
 *
 * For each candidate (component or instance x metric):
 *   current = mean over ticks [max(0, now - 5), now] of this run;
 *   usual   = mean over the same ticks of the lastWeek run (fault- and noise-free, ADR-003);
 *   deviation = |current - usual| / max(usual, 1).
 * Only deviations >= 0.25 are kept, ordered by deviation desc; ties keep world order (services,
 * then dependencies, instances in order) and then MetricName order. At most 3 hints.
 *
 * Scope by role:
 *   dev    — aggregates of the services; rps, p95, errorPct;
 *   dba    — aggregates of the `database` dependencies (all 8 metrics) and `connections` of the
 *            services that call them (directly or on cache miss);
 *   oncall — instances of every component; p95, errorPct, cpu.
 */
import type {
  CallSpec,
  ComponentName,
  InstanceId,
  MetricName,
  MetricRecord,
  NpcHint,
  QuestionHandler,
  TelemetryView,
  World,
} from '../types.js'

/** Ticks before `now` included in the NPC's look-back (window of 6 ticks, ADR-006). */
export const NPC_LOOKBACK_TICKS = 5
/** Minimum relative deviation for a hint (ADR-006). */
export const NPC_MIN_DEVIATION = 0.25
/** Maximum number of hints in one answer (ADR-006). */
export const NPC_MAX_HINTS = 3

/** MetricName in its canonical order (ADR-005); every list below keeps it (tie-break, ADR-006). */
const METRIC_ORDER: readonly MetricName[] = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']
const DEV_METRICS: readonly MetricName[] = ['rps', 'p95', 'errorPct']
const ONCALL_METRICS: readonly MetricName[] = ['p95', 'errorPct', 'cpu']

interface Candidate {
  component: ComponentName
  /** Absent for the component aggregate. */
  instance?: InstanceId
  metric: MetricName
}

type Role = 'dev' | 'dba' | 'oncall'

function callsTarget(calls: readonly CallSpec[], targets: ReadonlySet<ComponentName>): boolean {
  return calls.some(
    (call) => targets.has(call.target) || (call.onMiss !== undefined && targets.has(call.onMiss.target)),
  )
}

/** Candidates of a role, already in world order x MetricName order (the tie-break order). */
export function npcCandidates(world: World, role: Role): Candidate[] {
  const out: Candidate[] = []
  if (role === 'dev') {
    for (const service of world.services) {
      for (const metric of DEV_METRICS) out.push({ component: service.name, metric })
    }
    return out
  }
  if (role === 'dba') {
    const databases = new Set(world.deps.filter((d) => d.kind === 'database').map((d) => d.name))
    for (const service of world.services) {
      if (callsTarget(service.calls, databases)) out.push({ component: service.name, metric: 'connections' })
    }
    for (const dep of world.deps) {
      if (!databases.has(dep.name)) continue
      for (const metric of METRIC_ORDER) out.push({ component: dep.name, metric })
    }
    return out
  }
  for (const component of [...world.services, ...world.deps]) {
    for (const instance of component.instances) {
      for (const metric of ONCALL_METRICS) out.push({ component: component.name, instance, metric })
    }
  }
  return out
}

/** Value per tick of one candidate's metric (aggregate when `instance` is absent). */
function seriesOf(view: TelemetryView, candidate: Candidate, from: number, to: number): Map<number, number> {
  const series = new Map<number, number>()
  const records: MetricRecord[] = view.metricsOf(candidate.component, from, to)
  for (const record of records) {
    if (record.instance === candidate.instance) series.set(record.tick, record[candidate.metric])
  }
  return series
}

export const askNpc: QuestionHandler<'askNpc'> = (question, ctx) => {
  const { view } = ctx
  const now = view.now
  const from = Math.max(0, now - NPC_LOOKBACK_TICKS)
  const lastWeek = ctx.lastWeek()

  const scored: { hint: NpcHint; deviation: number }[] = []
  for (const candidate of npcCandidates(view.world, question.role)) {
    const current = seriesOf(view, candidate, from, now)
    const usual = seriesOf(lastWeek, candidate, from, now)
    // "The same ticks": only ticks present in both runs are compared.
    let sumCurrent = 0
    let sumUsual = 0
    let n = 0
    for (let tick = from; tick <= now; tick++) {
      const c = current.get(tick)
      const u = usual.get(tick)
      if (c === undefined || u === undefined) continue
      sumCurrent += c
      sumUsual += u
      n++
    }
    if (n === 0) continue
    const meanCurrent = sumCurrent / n
    const meanUsual = sumUsual / n
    const deviation = Math.abs(meanCurrent - meanUsual) / Math.max(meanUsual, 1)
    if (deviation < NPC_MIN_DEVIATION) continue
    const hint: NpcHint = {
      component: candidate.component,
      ...(candidate.instance === undefined ? {} : { instance: candidate.instance }),
      metric: candidate.metric,
      current: meanCurrent,
      usual: meanUsual,
    }
    scored.push({ hint, deviation })
  }

  // Array.prototype.sort is stable (ES2019): equal deviations keep candidate (world x metric) order.
  scored.sort((a, b) => b.deviation - a.deviation)
  const hints = scored.slice(0, NPC_MAX_HINTS).map((s) => s.hint)
  return { kind: 'askNpc', role: question.role, tick: now, hints }
}
