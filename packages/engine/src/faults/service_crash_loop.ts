/**
 * Fault module `service_crash_loop` (campaign row 1; semantics: ADR-004).
 *
 * Every instance of the target service cycles through `uptimeTicks` up and `restartTicks` down
 * (`onTick.down`). The cycle position of each instance is its phase, drawn once at activation
 * from the fault's own stream ('fault', i, kind, 'phase') (ADR-003 §2):
 *
 *   - the instances are put in a random order (Fisher–Yates on the 'phase' stream);
 *   - a random base offset in [0, period) is drawn;
 *   - the instance of rank r gets phase (base + floor(r × period / n)) mod period,
 *
 * so phases are spread evenly over the cycle. With the defaults (1 up, 2 down, 3 replicas) exactly
 * one instance is up in every tick and the other two are down, as ADR-004 requires; which one is
 * up, and when, changes with the seed (no decorable pattern, SPEC §11).
 *
 * Position of an instance at `s = tick − startTick` is `(s + phase) mod period`; it is up while the
 * position is `< uptimeTicks`. A crash is the tick an instance goes down: `s = 0` when it starts
 * down, and every later tick whose position is exactly `uptimeTicks`.
 *
 * In every tick an instance is down it logs one `error` `process exited` with attrs `exitCode`
 * (drawn once per fault from ('fault', i, kind, 'exit'): the same bug always exits the same way)
 * and `restartCount` (crashes of that instance so far, closed form: no state across ticks).
 *
 * Nothing else is touched: the indirect signals emerge from the traffic model (ADR-002 §5, §5.1).
 * Callers of the target get `connection refused` from the down instances and retry on the next
 * one; when every attempt lands on a down instance the caller's request fails ("the caller
 * errors", PRD F-3 row 1). The target itself serves less (lower RPS) but never reports an error.
 */
import type { FaultLog, FaultModule, InstanceId, Rng } from '../types.js'

/** Exit codes a crashing process may report (generic, no scenario text). */
export const EXIT_CODES: readonly number[] = [1, 134, 137, 139]

/** Message of the per-tick log of a down instance (ADR-005 Emenda 1 vocabulary). */
export const PROCESS_EXITED = 'process exited'

/** In-place Fisher–Yates shuffle of a copy, driven by `rng`. */
function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i + 1)
    const tmp = out[i] as T
    out[i] = out[j] as T
    out[j] = tmp
  }
  return out
}

/** Non-negative remainder. */
const mod = (a: number, m: number): number => ((a % m) + m) % m

/**
 * Number of crashes of an instance in ticks `[0, s]` of the fault (s >= 0): one at `s = 0` if it
 * starts down, plus one for every `m` in `(0, s]` with `(m + phase) mod period = up`.
 */
export function crashCount(s: number, phase: number, up: number, period: number): number {
  const initial = mod(phase, period) >= up ? 1 : 0
  let first = mod(up - phase, period)
  if (first === 0) first = period
  const later = first <= s ? Math.floor((s - first) / period) + 1 : 0
  return initial + later
}

export const serviceCrashLoop: FaultModule<'service_crash_loop'> = {
  kind: 'service_crash_loop',
  activate(fault, world, rng) {
    const service = world.services.find((s) => s.name === fault.target)
    // resolveFaults guarantees a service target; an unknown one has nothing to crash.
    if (service === undefined) return {}
    const up = fault.params['uptimeTicks'] as number
    const period = up + (fault.params['restartTicks'] as number)

    const phaseRng = rng('phase')
    const order = shuffled(service.instances, phaseRng)
    const base = phaseRng.int(0, period)
    const n = order.length
    const phases = new Map<InstanceId, number>()
    order.forEach((instance, rank) => phases.set(instance, (base + Math.floor((rank * period) / n)) % period))
    const exitCode = rng('exit').pick(EXIT_CODES)

    return {
      onTick: ({ tick }) => {
        const s = tick - fault.startTick
        const down: InstanceId[] = []
        const logs: FaultLog[] = []
        // World order of instances, so the output order never depends on the shuffle.
        for (const instance of service.instances) {
          const phase = phases.get(instance) as number
          if ((s + phase) % period < up) continue
          down.push(instance)
          logs.push({
            component: service.name,
            instance,
            level: 'error',
            message: PROCESS_EXITED,
            attrs: { exitCode, restartCount: crashCount(s, phase, up, period) },
          })
        }
        return { down, logs }
      },
    }
  },
}
