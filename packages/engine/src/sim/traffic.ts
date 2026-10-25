/**
 * GenerateTraffic (ADR-002 §3 step 3, §5; ADR-003 §2–3; ADR-005 "Trace simplificado").
 *
 * Simulates every request that starts in one tick and returns its spans plus one ErrorDetail per
 * error span. Metrics (deriveMetrics) and request logs (generateLogs) are derived from this output,
 * never from a formula of their own, so telemetry stays coherent (SPEC §3.3, §11). Nothing here
 * names a concrete component: the system is input data (W-3).
 *
 * Ingress: each service with `ingress` starts `ratePerTick` traces, in world order. The root is a
 * `server` span on the instance chosen by the round-robin balancer of that service. A request routed
 * to a `down` instance is lost at the edge (no caller exists to record it): it produces no span, so
 * the service simply serves less (the "served RPS drops" signal).
 *
 * Server span of a component (ADR-002 §5):
 * - own processing time sampled from a log-normal with median `latencyP50Ms` and 99th percentile
 *   `latencyP99Ms`, from the stream ('lat', traceId, spanSeq), plus `onServe.addLatencyMs`; half of
 *   it runs before the calls and half after them;
 * - `onServe.fail` fails the request (status 'error') without making calls;
 * - a service makes its calls in order; whether each call is made (`ratio`) and whether a cache call
 *   hits (`cacheHitRatio`) are drawn up front from ('traffic', tick, component), always the same
 *   number of draws per server span (one per call, plus one more per call to a cache, whether the
 *   call is made or not and whatever happens next), so a fault never changes how many draws one
 *   server span consumes (see "Isolation" below for what that does and does not guarantee);
 * - the first non-cache call that fails for good stops the remaining calls and turns the server
 *   span into 'error' (propagation). Cache failures never propagate: a miss (by ratio, by
 *   `forceCacheMiss`, by error or timeout of the cache) runs `onMiss`, whose failure does propagate.
 *
 * Call attempt (ADR-002 §5), for attempt = 0..retries, immediately one after the other (no backoff:
 * the retry storm of campaign row 5 emerges from this policy, ADR-004):
 * - `onCall.waitMs` becomes an `internal` span on the caller (`waitOperation`) before the client span;
 * - a `client` span on the caller with `peer = target`;
 * - `onCall.fail` ends the attempt on the caller side in FAST_FAIL_MS, without reaching the target;
 * - otherwise the balancer picks the target instance: round-robin over all its instances, with an
 *   initial offset per tick drawn from ('lb', tick, target). A `down` instance refuses the connection
 *   in FAST_FAIL_MS (no server span on the target);
 * - otherwise the target serves a child `server` span. If it does not finish within `timeoutMs`, the
 *   client span ends at the timeout with 'error' and the server span (and its descendants) is cut at
 *   the same instant with status 'ok': cancellation by the caller is not a server error (S-3 holds).
 *
 * IDs (ADR-003 §3): traceId = `t${tick}r${seq}` (seq counts ingress requests of the tick, including
 * the ones lost at the edge), spanId = `${traceId}s${n}` with n the span's position in the trace.
 * Output order: traces in start order, spans of a trace in pre-order (ADR-005).
 * All durations are integer ms; startMs is relative to the start of the root.
 *
 * Isolation (ADR-003 §8–9): streams isolate per tick and per trace, NOT per component. The
 * round-robin counter of each target and the decision stream of each component live for one tick
 * and are consumed per request, in trace order. So when a fault changes how many requests reach a
 * component in a tick (a caller stops its remaining calls after an error, a retry adds one more
 * balancer pick), later traces of that same tick, even ones that never touch the faulty component,
 * can land on another instance or flip a cache hit/miss. What does hold: ticks without an active
 * fault are identical to the baseline (F-2), because nothing crosses ticks; noise and ask() never
 * touch these streams (S-4, Q-3); and the own latency of a server span depends only on
 * ('lat', traceId, spanSeq), so spans that a fault inserts into a trace (a wait, a retry) shift
 * `spanSeq` only inside that trace. Fault tests therefore compare averages over seeds, never
 * traces or instances against the baseline in the ticks where the fault is active.
 */
import type {
  CallSpec,
  ComponentName,
  Dependency,
  ErrorDetail,
  GenerateTraffic,
  InstanceId,
  Rng,
  Service,
  SpanKind,
  SpanRecord,
  SpanStatus,
  TrafficInput,
  TrafficResult,
} from '../types.js'

/** Duration of an attempt refused by a down instance or failed on the caller side (ADR-002 §5). */
export const FAST_FAIL_MS = 1

/** Operation of the internal wait span when the fault does not name one. */
export const DEFAULT_WAIT_OPERATION = 'wait'

/** Generic English telemetry messages (S-5): never scenario text. */
export const MESSAGES = {
  connectionRefused: 'connection refused',
  upstreamTimeout: 'upstream timeout',
  upstreamError: 'upstream error',
  dependencyFailed: 'dependency call failed',
} as const

/** z-score of the 99th percentile of the standard normal distribution. */
const Z99 = 2.3263478740408408

/** Bound on the sampled z-score, so one unlucky draw cannot create an absurd tail. */
export const MAX_Z = 4

// Acklam's rational approximation of the inverse standard normal CDF (relative error < 1.2e-9).
const A = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
const B = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
const C = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
const D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
const P_LOW = 0.02425

const poly = (c: readonly number[], x: number): number => c.reduce((acc, k) => acc * x + k, 0)

/** Inverse of the standard normal CDF for p in (0, 1). Only arithmetic, log and sqrt (ADR-003 §6). */
export function inverseNormal(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p))
    return poly(C, q) / (poly(D, q) * q + 1)
  }
  if (p > 1 - P_LOW) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -poly(C, q) / (poly(D, q) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (poly(A, r) * q) / (poly(B, r) * r + 1)
}

/**
 * Own processing time of one server span, integer ms >= 1: log-normal with median p50 and 99th
 * percentile p99, i.e. exp(ln p50 + σ z) with σ = ln(p99 / p50) / z99. Consumes exactly one draw.
 */
export function sampleLatencyMs(rng: Rng, p50: number, p99: number): number {
  const u = rng.next()
  const z = Math.max(-MAX_Z, Math.min(MAX_Z, inverseNormal(u === 0 ? Number.MIN_VALUE : u)))
  const sigma = p99 > p50 ? Math.log(p99 / p50) / Z99 : 0
  return Math.max(1, Math.round(p50 * Math.exp(sigma * z)))
}

const nonNegativeInt = (x: number | undefined): number => (x === undefined || !(x > 0) ? 0 : Math.round(x))

type Component = { kind: 'service'; spec: Service } | { kind: 'dependency'; spec: Dependency }

/** One call of the plan drawn at the start of a server span. */
interface PlannedCall {
  call: CallSpec
  /** Only meaningful for calls to a cache. */
  hit: boolean
}

/** Result of a whole call (all attempts). */
interface CallOutcome {
  endMs: number
  ok: boolean
  /** The caller's own deadline was reached: the caller is being cut. */
  cancelled: boolean
  forceMiss: boolean
}

/** Result of one server span. */
interface ServeOutcome {
  endMs: number
  status: SpanStatus
  /** Cut by the deadline (caller timeout or caller cancellation). */
  cut: boolean
}

interface SpanFields {
  parentId: string | undefined
  component: ComponentName
  instance: InstanceId
  operation: string
  kind: SpanKind
  peer: ComponentName | undefined
  startMs: number
  durationMs: number
  status: SpanStatus
}

/** Spans of one trace, built in pre-order: a slot is reserved before the children are generated. */
class TraceBuilder {
  readonly spans: (SpanRecord | undefined)[] = []
  readonly details = new Map<string, ErrorDetail>()

  constructor(
    readonly tick: number,
    readonly traceId: string,
  ) {}

  /** Reserves the next position of the trace and returns its sequence number. */
  reserve(): number {
    this.spans.push(undefined)
    return this.spans.length - 1
  }

  spanId(seq: number): string {
    return `${this.traceId}s${seq}`
  }

  /** Fills a reserved slot with a record in ADR-005 key order, omitting absent optionals. */
  fill(seq: number, f: SpanFields, error?: Omit<ErrorDetail, 'spanId'>): void {
    const spanId = this.spanId(seq)
    const record: SpanRecord = { type: 'span', tick: this.tick, traceId: this.traceId, spanId } as SpanRecord
    if (f.parentId !== undefined) record.parentId = f.parentId
    record.component = f.component
    record.instance = f.instance
    record.operation = f.operation
    record.kind = f.kind
    if (f.peer !== undefined) record.peer = f.peer
    record.startMs = f.startMs
    record.durationMs = f.durationMs
    record.status = f.status
    this.spans[seq] = record
    if (f.status === 'error') {
      if (error === undefined) throw new Error(`traffic: error span '${spanId}' without ErrorDetail`)
      const detail: ErrorDetail = { spanId, message: error.message }
      if (error.attrs !== undefined) detail.attrs = error.attrs
      this.details.set(spanId, detail)
    }
  }

  /** Appends the finished trace to the tick result: spans in pre-order, details in span order. */
  flushInto(result: TrafficResult): void {
    for (const span of this.spans) {
      if (span === undefined) throw new Error(`traffic: trace '${this.traceId}' has an unfilled span slot`)
      result.spans.push(span)
      if (span.status === 'error') result.errors.push(this.details.get(span.spanId) as ErrorDetail)
    }
  }
}

export const generateTraffic: GenerateTraffic = (input: TrafficInput): TrafficResult => {
  const { world, tick, rng, down, hooks } = input

  const components = new Map<ComponentName, Component>()
  for (const spec of world.services) components.set(spec.name, { kind: 'service', spec })
  for (const spec of world.deps) components.set(spec.name, { kind: 'dependency', spec })
  const componentOf = (name: ComponentName): Component => {
    const component = components.get(name)
    if (component === undefined) throw new Error(`traffic: unknown component '${name}'`)
    return component
  }
  const isCache = (name: ComponentName): boolean => {
    const c = componentOf(name)
    return c.kind === 'dependency' && c.spec.kind === 'cache'
  }

  // Round-robin balancer per target component, offset drawn once per tick (ADR-002 §5).
  const balancers = new Map<ComponentName, { offset: number; next: number }>()
  const pickInstance = (name: ComponentName): InstanceId => {
    const { instances } = componentOf(name).spec
    let state = balancers.get(name)
    if (state === undefined) {
      state = { offset: rng('lb', tick, name).int(0, instances.length), next: 0 }
      balancers.set(name, state)
    }
    const instance = instances[(state.offset + state.next) % instances.length] as InstanceId
    state.next += 1
    return instance
  }

  // Decision stream per component per tick (ratio and cache hit draws).
  const decisionStreams = new Map<ComponentName, Rng>()
  const decisions = (name: ComponentName): Rng => {
    let stream = decisionStreams.get(name)
    if (stream === undefined) {
      stream = rng('traffic', tick, name)
      decisionStreams.set(name, stream)
    }
    return stream
  }

  const planOf = (service: Service): PlannedCall[] => {
    const stream = decisions(service.name)
    const plan: PlannedCall[] = []
    for (const call of service.calls) {
      const made = stream.chance(call.ratio)
      const target = componentOf(call.target)
      const hit = target.kind === 'dependency' && target.spec.kind === 'cache' ? stream.chance(target.spec.cacheHitRatio ?? 0) : true
      if (made) plan.push({ call, hit })
    }
    return plan
  }

  /** One call (all attempts) from `caller`/`callerInstance`, children of span `parentId`. */
  const performCall = (
    t: TraceBuilder,
    caller: ComponentName,
    callerInstance: InstanceId,
    parentId: string,
    call: Pick<CallSpec, 'target' | 'operation' | 'timeoutMs' | 'retries'>,
    startMs: number,
    deadline: number,
  ): CallOutcome => {
    let cursor = startMs
    let forceMiss = false
    const base = { parentId, component: caller, instance: callerInstance }
    for (let attempt = 0; attempt <= call.retries; attempt++) {
      if (cursor >= deadline) return { endMs: deadline, ok: false, cancelled: true, forceMiss }
      const effect = hooks.onCall?.({
        tick,
        caller,
        callerInstance,
        target: call.target,
        operation: call.operation,
        attempt,
        traceId: t.traceId,
      })
      if (effect?.forceCacheMiss === true) forceMiss = true

      const waitMs = nonNegativeInt(effect?.waitMs)
      if (waitMs > 0) {
        const waitEnd = Math.min(cursor + waitMs, deadline)
        const seq = t.reserve()
        t.fill(seq, {
          ...base,
          operation: effect?.waitOperation ?? DEFAULT_WAIT_OPERATION,
          kind: 'internal',
          peer: undefined,
          startMs: cursor,
          durationMs: waitEnd - cursor,
          status: 'ok',
        })
        cursor = waitEnd
        if (cursor >= deadline) return { endMs: deadline, ok: false, cancelled: true, forceMiss }
      }

      const seq = t.reserve()
      const client = { ...base, operation: call.operation, kind: 'client' as const, peer: call.target, startMs: cursor }
      const fail = (endMs: number, message: string, attrs: Record<string, string | number>) => {
        t.fill(seq, { ...client, durationMs: endMs - cursor, status: 'error' }, { message, attrs })
        cursor = endMs
      }

      if (effect?.fail !== undefined) {
        fail(Math.min(cursor + FAST_FAIL_MS, deadline), effect.fail.message, { attempt, ...effect.fail.attrs })
        continue
      }
      const instance = pickInstance(call.target)
      if (down.has(instance)) {
        fail(Math.min(cursor + FAST_FAIL_MS, deadline), MESSAGES.connectionRefused, { attempt, peerInstance: instance })
        continue
      }
      const timeoutAt = cursor + call.timeoutMs
      const attemptDeadline = Math.min(deadline, timeoutAt)
      const served = serve(t, call.target, instance, call.operation, t.spanId(seq), cursor, attemptDeadline)
      if (!served.cut) {
        if (served.status === 'error') {
          fail(served.endMs, MESSAGES.upstreamError, { attempt, peerInstance: instance })
          continue
        }
        t.fill(seq, { ...client, durationMs: served.endMs - cursor, status: 'ok' })
        return { endMs: served.endMs, ok: true, cancelled: false, forceMiss }
      }
      if (timeoutAt <= deadline) {
        fail(timeoutAt, MESSAGES.upstreamTimeout, { attempt, timeoutMs: call.timeoutMs })
        continue
      }
      // The caller itself is being cut: the attempt is cancelled, not failed.
      t.fill(seq, { ...client, durationMs: deadline - cursor, status: 'ok' })
      return { endMs: deadline, ok: false, cancelled: true, forceMiss }
    }
    return { endMs: cursor, ok: false, cancelled: false, forceMiss }
  }

  /** A server span of `name`/`instance` starting at `startMs`, never ending after `deadline`. */
  const serve = (
    t: TraceBuilder,
    name: ComponentName,
    instance: InstanceId,
    operation: string,
    parentId: string | undefined,
    startMs: number,
    deadline: number,
  ): ServeOutcome => {
    const seq = t.reserve()
    const spanId = t.spanId(seq)
    const component = componentOf(name)
    const latency = sampleLatencyMs(rng('lat', t.traceId, seq), component.spec.latencyP50Ms, component.spec.latencyP99Ms)
    const effect = hooks.onServe?.({ tick, component: name, instance, operation, traceId: t.traceId })
    const own = latency + nonNegativeInt(effect?.addLatencyMs)
    const pre = Math.floor(own / 2)
    const post = own - pre
    // Drawn for every server span of a service, whatever happens next (fixed stream consumption).
    const plan = component.kind === 'service' ? planOf(component.spec) : []

    let failure: Omit<ErrorDetail, 'spanId'> | undefined
    if (effect?.fail !== undefined) {
      failure = effect.fail.attrs === undefined ? { message: effect.fail.message } : { message: effect.fail.message, attrs: { ...effect.fail.attrs } }
    }

    let cursor = startMs + pre
    let cut = cursor > deadline
    if (failure === undefined && !cut) {
      for (const { call, hit } of plan) {
        if (cursor >= deadline) {
          cut = true
          break
        }
        const result = performCall(t, name, instance, spanId, call, cursor, deadline)
        cursor = result.endMs
        if (result.cancelled) {
          cut = true
          break
        }
        if (isCache(call.target)) {
          const miss = !result.ok || !hit || result.forceMiss
          if (!miss || call.onMiss === undefined) continue
          const fallback = performCall(t, name, instance, spanId, call.onMiss, cursor, deadline)
          cursor = fallback.endMs
          if (fallback.cancelled) {
            cut = true
            break
          }
          if (!fallback.ok) {
            failure = { message: MESSAGES.dependencyFailed, attrs: { upstream: call.onMiss.target } }
            break
          }
          continue
        }
        if (!result.ok) {
          failure = { message: MESSAGES.dependencyFailed, attrs: { upstream: call.target } }
          break
        }
      }
    }

    let endMs = cut ? deadline : cursor + post
    if (endMs > deadline) {
      cut = true
      endMs = deadline
    }
    const status: SpanStatus = !cut && failure !== undefined ? 'error' : 'ok'
    t.fill(
      seq,
      { parentId, component: name, instance, operation, kind: 'server', peer: undefined, startMs, durationMs: endMs - startMs, status },
      failure,
    )
    return { endMs, status, cut }
  }

  const result: TrafficResult = { spans: [], errors: [] }
  let seq = 0
  for (const service of world.services) {
    if (service.ingress === undefined) continue
    for (let r = 0; r < service.ingress.ratePerTick; r++) {
      const traceId = `t${tick}r${seq}`
      seq += 1
      const instance = pickInstance(service.name)
      if (down.has(instance)) continue
      const t = new TraceBuilder(tick, traceId)
      serve(t, service.name, instance, service.ingress.operation, undefined, 0, Number.POSITIVE_INFINITY)
      t.flushInto(result)
    }
  }
  return result
}
