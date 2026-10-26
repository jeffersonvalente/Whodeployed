/**
 * Fault module `cache_cold_start` (semantics: ADR-004; campaign row 7, SPEC §7).
 *
 * The target cache restarts empty at `startTick` and warms up over `warmupTicks`:
 * - `s = 0` (tick === startTick): onTick emits one `config` EventRecord with `restart: true` per
 *   instance of the cache (S-4, visible to `whatChanged`) and marks those instances `down` for
 *   this tick only, so callers get `connection refused` and fall through to `onMiss`;
 * - `0 <= s < warmupTicks`: every call to the cache is forced to miss with probability
 *   `1 − s / warmupTicks`, drawn per request from ('miss', tick, traceId) (one stream per trace,
 *   consumed in call order, which the traffic generator makes deterministic);
 * - `s >= warmupTicks`: no effect; only the cache's own `cacheHitRatio` applies.
 *
 * The cache keeps answering (its RPS does not drop after the restart tick): a forced miss is still a
 * call to the cache, followed by the `onMiss` call. What moves is emergent (SPEC §3.3): the backing
 * store's RPS and latency, and the p50 of every service that uses the cache, all derived from the
 * spans the miss path generates. The cache itself looks healthy again right after the restart
 * (SPEC §3.4: the pain shows elsewhere).
 *
 * Hooks are only invoked for tick >= startTick (orchestrator gating, F-2).
 */
import type { FaultModule, Rng } from '../types.js'

export const cacheColdStart: FaultModule<'cache_cold_start'> = {
  kind: 'cache_cold_start',
  activate: (fault, world, rng) => {
    const cache = world.deps.find((d) => d.name === fault.target)
    if (cache === undefined) throw new Error(`cache_cold_start: target '${fault.target}' is not a dependency of the world`)
    const warmupTicks = fault.params['warmupTicks'] ?? 1
    const instances = [...cache.instances]

    // One stream per trace, reset when the tick changes (traces never span ticks).
    let streamsTick = -1
    let streams = new Map<string, Rng>()
    const streamOf = (tick: number, traceId: string): Rng => {
      if (tick !== streamsTick) {
        streamsTick = tick
        streams = new Map()
      }
      let stream = streams.get(traceId)
      if (stream === undefined) {
        stream = rng('miss', tick, traceId)
        streams.set(traceId, stream)
      }
      return stream
    }

    return {
      onTick: ({ tick }) => {
        if (tick !== fault.startTick) return undefined
        return {
          down: instances,
          events: instances.map((instance) => ({ kind: 'config' as const, target: cache.name, instance, restart: true as const })),
        }
      },
      onCall: (ctx) => {
        const s = ctx.tick - fault.startTick
        if (ctx.target !== cache.name || s >= warmupTicks) return undefined
        const coldRatio = 1 - s / warmupTicks
        return streamOf(ctx.tick, ctx.traceId).chance(coldRatio) ? { forceCacheMiss: true } : undefined
      },
    }
  },
}
