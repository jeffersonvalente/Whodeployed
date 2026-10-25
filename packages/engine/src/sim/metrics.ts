/**
 * DeriveMetrics (ADR-002 §3 step 5, ADR-005 "Métricas").
 *
 * Request metrics are never computed by their own formula: they are derived from the
 * `server` spans of the tick (P-1, per instance) and from the union of those spans over all
 * instances of a component (P-2, aggregate), so a metric can always be recomputed from the
 * spans of the same tick (SPEC §3.3, §11).
 *
 *   rps      = n / 10                      (1 tick = 10 s, W-4)
 *   errorPct = errors / n * 100            (0 when n = 0)
 *   pXX      = nearest-rank over durations (0 when n = 0)
 *
 * Resource metrics (cpu, mem, connections) follow the resource model of ADR-005, with jitter
 * from the stream ('res', tick, component, instance) (ADR-003 §2) and the merged
 * ResourceEffect of the active faults for that instance.
 */
import type {
  ComponentName,
  ComponentSpecBase,
  DeriveMetrics,
  DeriveMetricsInput,
  InstanceId,
  MetricRecord,
  MetricValues,
  ResourceEffect,
  SpanRecord,
  World,
} from '../types.js'

/** Seconds of game time per tick (SPEC §6, W-4). */
export const TICK_SECONDS = 10

/** Milliseconds of game time per tick: Σ client-span ms / this = mean concurrent connections. */
export const TICK_MS = TICK_SECONDS * 1000

/** CPU jitter: uniform in [-CPU_JITTER_PCT, +CPU_JITTER_PCT) percentage points. */
export const CPU_JITTER_PCT = 1

/** Memory jitter: uniform in [-MEM_JITTER_RATIO, +MEM_JITTER_RATIO) × memBaseMb. */
export const MEM_JITTER_RATIO = 0.01

/**
 * Nearest-rank percentile of an ascending array: `sorted[ceil(p/100 × n) − 1]`, 0 when empty.
 * The rank is computed as `ceil(p × n / 100)` so that it is exact in floating point.
 */
export function nearestRank(sorted: readonly number[], p: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const rank = Math.min(n, Math.max(1, Math.ceil((p * n) / 100)))
  return sorted[rank - 1] as number
}

/** Request metrics derived from a set of server spans (P-1 / P-2). */
export function requestMetrics(spans: readonly SpanRecord[]): Pick<MetricValues, 'rps' | 'p50' | 'p95' | 'p99' | 'errorPct'> {
  const n = spans.length
  let errors = 0
  const durations: number[] = []
  for (const span of spans) {
    if (span.status === 'error') errors += 1
    durations.push(span.durationMs)
  }
  durations.sort((a, b) => a - b)
  return {
    rps: n / TICK_SECONDS,
    p50: nearestRank(durations, 50),
    p95: nearestRank(durations, 95),
    p99: nearestRank(durations, 99),
    errorPct: n === 0 ? 0 : (errors / n) * 100,
  }
}

const round1 = (x: number): number => Math.round(x * 10) / 10

const clamp = (x: number, min: number, max: number): number => Math.min(max, Math.max(min, x))

/** Connection count after a fault effect: integer, >= 0, bounded by connectionsCap. */
function applyConnectionEffect(base: number, effect: ResourceEffect | undefined): number {
  let value = base + (effect?.connectionsAdd ?? 0)
  if (effect?.connectionsCap !== undefined) value = Math.min(value, effect.connectionsCap)
  return Math.max(0, Math.round(value))
}

const key = (component: ComponentName, instance: InstanceId): string => `${component}\u001f${instance}`

interface Component {
  spec: ComponentSpecBase
  instances: readonly InstanceId[]
}

/** Components in world order: services, then dependencies (ADR-005). */
function componentsOf(world: World): Component[] {
  return [
    ...world.services.map((s) => ({ spec: s, instances: s.instances })),
    ...world.deps.map((d) => ({ spec: d, instances: d.instances })),
  ]
}

/** Names of database dependencies a service may call (call targets and onMiss), in call order. */
function databaseTargets(world: World, service: World['services'][number]): ComponentName[] {
  const databases = new Set(world.deps.filter((d) => d.kind === 'database').map((d) => d.name))
  const out: ComponentName[] = []
  const add = (target: ComponentName) => {
    if (databases.has(target) && !out.includes(target)) out.push(target)
  }
  for (const call of service.calls) {
    add(call.target)
    if (call.onMiss) add(call.onMiss.target)
  }
  return out
}

export interface PeerUsage {
  /** Σ durationMs of the client spans to the peer. */
  ms: number
  /** Same sum, by the peer instance that served the attempt. */
  byInstance: Map<InstanceId, number>
}

/**
 * Splits `count` connections among the instances of a dependency in proportion to the client
 * milliseconds each one served (largest remainder, ties to the lower index). With no served
 * milliseconds (e.g. only leaked connections), everything goes to the first instance that is not
 * down. Down instances get nothing. Deterministic: depends only on its arguments.
 */
export function distribute(
  count: number,
  instances: readonly InstanceId[],
  usage: PeerUsage | undefined,
  down: ReadonlySet<InstanceId>,
): [InstanceId, number][] {
  const up = instances.filter((i) => !down.has(i))
  const weights = up.map((i) => usage?.byInstance.get(i) ?? 0)
  const totalWeight = weights.reduce((s, w) => s + w, 0)
  if (up.length === 0) return []
  if (totalWeight === 0) return [[up[0] as InstanceId, count]]
  const shares = weights.map((w) => (count * w) / totalWeight)
  const out = shares.map((s) => Math.floor(s))
  let rest = count - out.reduce((s, n) => s + n, 0)
  const order = shares
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const { i } of order) {
    if (rest <= 0) break
    out[i] = (out[i] as number) + 1
    rest -= 1
  }
  return up.map((instance, i) => [instance, out[i] as number])
}

/**
 * Derives the MetricRecords of one tick: for every component in world order, one record per
 * instance (in instance order) followed by the component aggregate without `instance`.
 *
 * Resource model (ADR-005):
 * - cpu = clamp(cpuBasePct + cpuPerRequestPct × n + jitter + cpuPctAdd, 0, 100), 1 decimal.
 * - mem = memBaseMb + jitter + memMbAdd (>= 0), 1 decimal.
 * - connections of a service instance: for each database it calls, a pool of
 *   ceil(Σ durationMs of its client spans to that database / 10000) connections; the instance's
 *   connectionsAdd/connectionsCap apply to each pool (ServiceSpec.dbPoolSize is per instance and
 *   per database); the metric is the sum of its pools. With a single database (default-shop)
 *   this is exactly `ceil(Σ / 10000) + connectionsAdd`, capped by connectionsCap. A service that
 *   calls no database has one implicit pool of 0 connections (so connectionsAdd still shows).
 * - connections of a dependency instance: sum of the connections clients hold to it (database
 *   pools above; for cache/queue, ceil(Σ client-span ms / 10000) per client instance), split
 *   among the dependency's instances by `distribute`, then its own connectionsAdd/connectionsCap.
 * - A `down` instance reports cpu = 0 and connections = 0 and holds no connection to its
 *   dependencies; mem is kept. Its request metrics still come from its spans (none, since a down
 *   instance serves nothing), so P-1 holds by construction.
 * - Aggregate: request metrics over the union of instance spans (P-2); cpu = mean of instances
 *   (1 decimal); mem = sum (1 decimal); connections = sum.
 */
export const deriveMetrics: DeriveMetrics = (input: DeriveMetricsInput): MetricRecord[] => {
  const { world, tick, spans, down, resourceEffects, rng } = input

  // Index spans of the tick: server spans per (component, instance); for client spans, the
  // milliseconds spent per (caller component, caller instance, peer), split by the peer
  // instance that served the attempt (its child server span), when there is one.
  const serverSpans = new Map<string, SpanRecord[]>()
  const servedBy = new Map<string, InstanceId>()
  for (const span of spans) {
    if (span.kind !== 'server') continue
    const k = key(span.component, span.instance)
    const list = serverSpans.get(k)
    if (list) list.push(span)
    else serverSpans.set(k, [span])
    if (span.parentId !== undefined) servedBy.set(span.parentId, span.instance)
  }
  const clientMs = new Map<string, Map<ComponentName, PeerUsage>>()
  for (const span of spans) {
    if (span.kind !== 'client' || span.peer === undefined) continue
    const k = key(span.component, span.instance)
    let byPeer = clientMs.get(k)
    if (!byPeer) {
      byPeer = new Map()
      clientMs.set(k, byPeer)
    }
    let usage = byPeer.get(span.peer)
    if (!usage) {
      usage = { ms: 0, byInstance: new Map() }
      byPeer.set(span.peer, usage)
    }
    usage.ms += span.durationMs
    const served = servedBy.get(span.spanId)
    if (served !== undefined) usage.byInstance.set(served, (usage.byInstance.get(served) ?? 0) + span.durationMs)
  }

  // Connections that clients hold on each dependency instance, accumulated while services are
  // derived (services precede dependencies in world order).
  const held = new Map<string, number>()
  const dependencies = new Map(world.deps.map((d) => [d.name, d]))
  const hold = (depName: ComponentName, count: number, usage: PeerUsage | undefined) => {
    const dep = dependencies.get(depName)
    if (!dep || count === 0) return
    for (const [instance, n] of distribute(count, dep.instances, usage, down)) {
      const k = key(depName, instance)
      held.set(k, (held.get(k) ?? 0) + n)
    }
  }

  const serviceConnections = (service: World['services'][number], instance: InstanceId): number => {
    if (down.has(instance)) return 0
    const effect = resourceEffects.get(instance)
    const byPeer = clientMs.get(key(service.name, instance))
    const databases = databaseTargets(world, service)
    // Cache and queue clients: plain occupancy, no pool effect.
    if (byPeer) {
      for (const [peer, usage] of byPeer) {
        if (dependencies.has(peer) && !databases.includes(peer)) hold(peer, Math.ceil(usage.ms / TICK_MS), usage)
      }
    }
    if (databases.length === 0) return applyConnectionEffect(0, effect)
    let total = 0
    for (const db of databases) {
      const usage = byPeer?.get(db)
      const pool = applyConnectionEffect(Math.ceil((usage?.ms ?? 0) / TICK_MS), effect)
      hold(db, pool, usage)
      total += pool
    }
    return total
  }

  const records: MetricRecord[] = []
  for (const { spec, instances } of componentsOf(world)) {
    const service = world.services.find((s) => s.name === spec.name)
    const instanceRecords: MetricRecord[] = []
    const allServer: SpanRecord[] = []
    for (const instance of instances) {
      const own = serverSpans.get(key(spec.name, instance)) ?? []
      for (const span of own) allServer.push(span)
      const effect = resourceEffects.get(instance)
      const isDown = down.has(instance)
      const jitter = rng('res', tick, spec.name, instance)
      const cpuJitter = (jitter.next() * 2 - 1) * CPU_JITTER_PCT
      const memJitter = (jitter.next() * 2 - 1) * MEM_JITTER_RATIO * spec.memBaseMb
      const cpu = isDown
        ? 0
        : round1(clamp(spec.cpuBasePct + spec.cpuPerRequestPct * own.length + cpuJitter + (effect?.cpuPctAdd ?? 0), 0, 100))
      const mem = round1(Math.max(0, spec.memBaseMb + memJitter + (effect?.memMbAdd ?? 0)))
      const connections = service
        ? serviceConnections(service, instance)
        : isDown
          ? 0
          : applyConnectionEffect(held.get(key(spec.name, instance)) ?? 0, effect)
      instanceRecords.push({
        type: 'metric',
        tick,
        component: spec.name,
        instance,
        ...requestMetrics(own),
        cpu,
        mem,
        connections,
      })
    }
    records.push(...instanceRecords)
    const n = instanceRecords.length
    records.push({
      type: 'metric',
      tick,
      component: spec.name,
      ...requestMetrics(allServer),
      cpu: n === 0 ? 0 : round1(instanceRecords.reduce((s, r) => s + r.cpu, 0) / n),
      mem: round1(instanceRecords.reduce((s, r) => s + r.mem, 0)),
      connections: instanceRecords.reduce((s, r) => s + r.connections, 0),
    })
  }
  return records
}
