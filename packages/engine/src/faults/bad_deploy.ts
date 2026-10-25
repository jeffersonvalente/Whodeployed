/**
 * Fault module `bad_deploy` (semantics: ADR-004; campaign row 4, SPEC §7).
 *
 * A bad version is deployed to `affectedInstances` instances of the target service at `startTick`.
 * Requests served by those instances fail with probability `errorRatio` (`onServe.fail`,
 * `unhandled exception`, attr `version`); the other instances are untouched (F-5).
 *
 * - Which instances: drawn once, at activation, from the fault's own stream ('pick') by a partial
 *   Fisher–Yates shuffle, so the seed (not the instance id) decides who is affected (ADR-003,
 *   ADR-004 "Alternativas descartadas").
 * - The version label is a short hex id drawn from ('version'): it varies with the seed, is an
 *   identifier (not scenario text, S-5) and lets a player filter the error logs by `version`.
 * - At `s = 0` (tick === startTick) onTick emits one `deploy` EventRecord per affected instance,
 *   in world order (S-4: a fault-generated change, visible to `whatChanged`).
 * - The fail draw of a request comes from ('serve', tick, traceId), one stream per trace, consumed
 *   in serve order (deterministic: traffic visits server spans in pre-order). It is drawn only for
 *   requests served by an affected instance, so nothing else in the run consumes this stream.
 *
 * Nothing here emerges from a script: the error rate seen on the dashboards is derived from the
 * failed server spans (SPEC §3.3). The aggregate of the target is diluted by the healthy instances
 * and the callers' retries land on the next instance of the round-robin, so the service-level view
 * hides the bad instance (SPEC §3.4, F-5).
 *
 * Hooks are only invoked for tick >= startTick (the orchestrator gates them, F-2).
 */
import type { FaultModule, InstanceId, Rng } from '../types.js'

/** Log/fail message of a request that hits the bad version (ADR-005 Emenda 1 vocabulary). */
export const UNHANDLED_EXCEPTION = 'unhandled exception'

/** Picks `count` distinct items in a seed-dependent order, returned in their original order. */
export function pickDistinct<T>(items: readonly T[], count: number, rng: Rng): T[] {
  const pool = items.map((item, index) => ({ item, index }))
  const n = Math.max(0, Math.min(count, pool.length))
  for (let i = 0; i < n; i++) {
    const j = rng.int(i, pool.length)
    const tmp = pool[i] as { item: T; index: number }
    pool[i] = pool[j] as { item: T; index: number }
    pool[j] = tmp
  }
  return pool
    .slice(0, n)
    .sort((a, b) => a.index - b.index)
    .map((p) => p.item)
}

/** 7-hex-digit version label drawn from one stream draw. */
function versionLabel(rng: Rng): string {
  return rng.int(0, 0x10000000).toString(16).padStart(7, '0')
}

export const badDeploy: FaultModule<'bad_deploy'> = {
  kind: 'bad_deploy',
  activate: (fault, world, rng) => {
    const service = world.services.find((s) => s.name === fault.target)
    if (service === undefined) throw new Error(`bad_deploy: target '${fault.target}' is not a service of the world`)
    const affectedInstances = fault.params['affectedInstances'] ?? 1
    const errorRatio = fault.params['errorRatio'] ?? 0
    const affected: readonly InstanceId[] = pickDistinct(service.instances, affectedInstances, rng('pick'))
    const affectedSet = new Set(affected)
    const version = versionLabel(rng('version'))

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
        stream = rng('serve', tick, traceId)
        streams.set(traceId, stream)
      }
      return stream
    }

    return {
      onTick: ({ tick }) => {
        if (tick !== fault.startTick) return undefined
        return { events: affected.map((instance) => ({ kind: 'deploy' as const, target: service.name, instance })) }
      },
      onServe: (ctx) => {
        if (ctx.component !== service.name || !affectedSet.has(ctx.instance)) return undefined
        if (!streamOf(ctx.tick, ctx.traceId).chance(errorRatio)) return undefined
        return { fail: { message: UNHANDLED_EXCEPTION, attrs: { version } } }
      },
    }
  },
}
