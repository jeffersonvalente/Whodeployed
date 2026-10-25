/**
 * Fault module `connection_pool_exhaustion` (campaign row 3; semantics: ADR-004).
 *
 * With `s = tick − startTick`, every instance of the target service has leaked
 * `leaked(s) = min(poolSize, leakPerTick × (s + 1))` connections of its database pool:
 *
 *   - onResources: each instance of the target reports `connectionsAdd = leaked(s)` with
 *     `connectionsCap = poolSize` (poolSize replaces dbPoolSize on the target only). The database
 *     sees the leaked connections too, because a dependency's connections are the sum of what its
 *     clients hold (ADR-005 Emenda 1): the DBA's view climbs as well.
 *   - onCall from the target to a `database`: a request needs one free connection. While
 *     `leaked(s) + 1 <= poolSize` one is free and nothing changes. Once the leak has taken the whole
 *     pool (`leaked(s) >= poolSize`, i.e. leaked + the connection in use would exceed the pool), the
 *     attempt waits in an internal span `db.acquire` until the pool reclaims a connection. The
 *     time until the next reclaim is drawn as `acquireTimeoutMs × U[RECLAIM_MIN, RECLAIM_MAX)`.
 *     If it comes before `acquireTimeoutMs`, the attempt waits that long and then proceeds
 *     normally. Otherwise it waits exactly `acquireTimeoutMs` and fails on the caller side with
 *     `connection pool timeout` (attr `poolSize`); the caller's retry policy applies, and the
 *     retry (next attempt of the same call, same trace) waits only the rest of the time until that
 *     same reclaim, instead of a fresh draw: the reclaim was already on its way. So a timed-out
 *     acquisition followed by a retry still shows one dominant `db.acquire` span.
 *
 * Draws come from the fault's own stream ('fault', i, kind, tick, traceId) (ADR-003 §2): one
 * stream per trace, read once per fresh acquisition, so they stay inside the affected trace
 * (ADR-003 §8).
 *
 * Nothing else is touched. The rest of the signature emerges from the traffic model: the target's
 * latency explodes (the wait sits inside its server span), its callers wait with it (gateway p95)
 * while requests that never reach the target keep the gateway p50 flat ("the aggregate hides the
 * bottleneck", PRD F-3 row 3), and failed acquisitions turn into `dependency call failed` errors.
 */
import type { CallEffect, FaultModule, Rng } from '../types.js'

/** Message of a failed acquisition (ADR-005 Emenda 1 vocabulary). */
export const POOL_TIMEOUT = 'connection pool timeout'

/** Operation of the internal wait span (SPEC §7: "waiting on db.acquire"). */
export const ACQUIRE_OPERATION = 'db.acquire'

/** Reclaim time of an exhausted pool, as a fraction of acquireTimeoutMs: uniform in [MIN, MAX). */
export const RECLAIM_MIN = 0.5
export const RECLAIM_MAX = 1.1

/** Connections leaked per instance after `s` ticks of fault (s >= 0), capped at the pool size. */
export function leakedAt(s: number, leakPerTick: number, poolSize: number): number {
  return Math.min(poolSize, leakPerTick * (s + 1))
}

export const connectionPoolExhaustion: FaultModule<'connection_pool_exhaustion'> = {
  kind: 'connection_pool_exhaustion',
  activate(fault, world, rng) {
    const service = world.services.find((s) => s.name === fault.target)
    // resolveFaults guarantees a service that calls a database; anything else has no pool.
    if (service === undefined) return {}
    const instances = new Set(service.instances)
    const databases = new Set(world.deps.filter((d) => d.kind === 'database').map((d) => d.name))
    const poolSize = fault.params['poolSize'] as number
    const leakPerTick = fault.params['leakPerTick'] as number
    const acquireTimeoutMs = fault.params['acquireTimeoutMs'] as number
    const leaked = (tick: number) => leakedAt(tick - fault.startTick, leakPerTick, poolSize)

    // Per trace of the current tick (cleared when the tick changes): its stream, and the time left
    // until the reclaim that an attempt timed out waiting for.
    let stateTick = -1
    const traces = new Map<string, { rng: Rng; pendingMs: number | undefined }>()
    const traceState = (tick: number, traceId: string) => {
      if (tick !== stateTick) {
        traces.clear()
        stateTick = tick
      }
      let state = traces.get(traceId)
      if (state === undefined) {
        state = { rng: rng(tick, traceId), pendingMs: undefined }
        traces.set(traceId, state)
      }
      return state
    }

    return {
      onResources: ({ tick, component, instance }) => {
        if (component !== service.name || !instances.has(instance)) return undefined
        return { connectionsAdd: leaked(tick), connectionsCap: poolSize }
      },
      onCall: ({ tick, caller, target, attempt, traceId }): CallEffect | undefined => {
        if (caller !== service.name || !databases.has(target)) return undefined
        if (leaked(tick) + 1 <= poolSize) return undefined
        const state = traceState(tick, traceId)
        let reclaimMs: number
        if (attempt > 0 && state.pendingMs !== undefined) {
          reclaimMs = state.pendingMs
        } else {
          const u = state.rng.next()
          reclaimMs = Math.round(acquireTimeoutMs * (RECLAIM_MIN + (RECLAIM_MAX - RECLAIM_MIN) * u))
        }
        if (reclaimMs < acquireTimeoutMs) {
          state.pendingMs = undefined
          return { waitMs: reclaimMs, waitOperation: ACQUIRE_OPERATION }
        }
        state.pendingMs = reclaimMs - acquireTimeoutMs
        return {
          waitMs: acquireTimeoutMs,
          waitOperation: ACQUIRE_OPERATION,
          fail: { message: POOL_TIMEOUT, attrs: { poolSize } },
        }
      },
    }
  },
}
