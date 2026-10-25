/**
 * Fault module `slow_dependency` (semantics: ADR-004; campaign row 5, SPEC §7).
 *
 * The target becomes slow: `onServe` adds `addedLatencyMs` to the own processing time of every
 * request it serves. That is the whole fault. The target produces no error of its own.
 *
 * Everything else emerges from the callers' call policy (ADR-002 §5), never from this module
 * (SPEC §3.3; ADR-004 rejected `retry_storm` as a kind name for this reason):
 * - each caller attempt that exceeds its `timeoutMs` ends with `upstream timeout` and is retried
 *   at once, up to `retries`: the count of client spans towards the target multiplies (the retry
 *   storm) and the target receives the extra load;
 * - the target's server spans are cut at the caller's timeout with status 'ok' (cancellation is
 *   not a server error), so the target's error % stays at its baseline while its latency soars;
 * - callers that run out of attempts fail their own request (`dependency call failed`) and their
 *   callers see it: the components that "scream" are the callers, not the slow one (SPEC §3.4).
 *
 * Consumes no randomness. Hooks are only invoked for tick >= startTick (orchestrator gating, F-2).
 */
import type { FaultModule } from '../types.js'

export const slowDependency: FaultModule<'slow_dependency'> = {
  kind: 'slow_dependency',
  activate: (fault) => {
    const addedLatencyMs = fault.params['addedLatencyMs'] ?? 0
    return {
      onServe: (ctx) => (ctx.component === fault.target ? { addLatencyMs: addedLatencyMs } : undefined),
    }
  },
}
