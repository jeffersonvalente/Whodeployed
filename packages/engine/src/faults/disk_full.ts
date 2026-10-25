/**
 * Fault module `disk_full` (campaign row 2; semantics: ADR-004).
 *
 * With `s = tick − startTick`:
 *
 *   - filling, `s < fillTicks`: every instance of the target logs one `warn` `disk usage high` per
 *     tick with attr `usagePct`, rising from FILL_START_PCT towards 99; requests are unaffected;
 *   - full, `s >= fillTicks`: every instance logs one `error` `no space left on device` per tick
 *     (attr `usagePct` = 100), and every request it serves fails with probability `failRatio`
 *     (`onServe.fail`, same message). `fillTicks = 0` starts full.
 *
 * The failure draw of a request comes from the fault's own stream ('fault', i, kind, tick, traceId)
 * (ADR-003 §2): one stream per trace, consumed once per server span of the target in that trace
 * (retries get fresh draws). Hooks are called in generation order, so the draws are deterministic
 * and stay inside the trace that is affected (ADR-003 §8).
 *
 * Nothing is scripted in the callers: the `server` span of the target turns `error`, the caller's
 * client span gets `upstream error`, the caller retries per its CallSpec and, when every attempt
 * fails, its own request fails with `dependency call failed` ("symptom far from the cause",
 * PRD F-3 row 2). Cache users only reach the database on a miss, so they see a fraction of it.
 */
import type { FaultLog, FaultModule, Rng } from '../types.js'

/** Messages of this fault (ADR-005 Emenda 1 vocabulary). */
export const DISK_USAGE_HIGH = 'disk usage high'
export const NO_SPACE_LEFT = 'no space left on device'

/** Disk usage reported in the first filling tick, %. */
export const FILL_START_PCT = 95

/** Disk usage (integer %) at `s` while filling: FILL_START_PCT at s = 0, approaching 99 before full. */
export function usagePct(s: number, fillTicks: number): number {
  if (s >= fillTicks) return 100
  return FILL_START_PCT + Math.floor(((99 - FILL_START_PCT) * s) / fillTicks)
}

export const diskFull: FaultModule<'disk_full'> = {
  kind: 'disk_full',
  activate(fault, world, rng) {
    const target = [...world.services, ...world.deps].find((c) => c.name === fault.target)
    // resolveFaults guarantees a database target; an unknown one has no disk to fill.
    if (target === undefined) return {}
    const fillTicks = fault.params['fillTicks'] as number
    const failRatio = fault.params['failRatio'] as number

    // One stream per trace of the current tick (cleared when the tick changes).
    let streamTick = -1
    const streams = new Map<string, Rng>()
    const streamOf = (tick: number, traceId: string): Rng => {
      if (tick !== streamTick) {
        streams.clear()
        streamTick = tick
      }
      let stream = streams.get(traceId)
      if (stream === undefined) {
        stream = rng(tick, traceId)
        streams.set(traceId, stream)
      }
      return stream
    }

    return {
      onTick: ({ tick }) => {
        const s = tick - fault.startTick
        const full = s >= fillTicks
        const logs: FaultLog[] = target.instances.map((instance) => ({
          component: target.name,
          instance,
          level: full ? 'error' : 'warn',
          message: full ? NO_SPACE_LEFT : DISK_USAGE_HIGH,
          attrs: { usagePct: usagePct(s, fillTicks) },
        }))
        return { logs }
      },
      onServe: ({ tick, component, traceId }) => {
        if (component !== target.name || tick - fault.startTick < fillTicks) return undefined
        if (!streamOf(tick, traceId).chance(failRatio)) return undefined
        return { fail: { message: NO_SPACE_LEFT } }
      },
    }
  },
}
