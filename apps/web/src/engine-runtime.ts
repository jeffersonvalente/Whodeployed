/**
 * The EngineRuntime injected into the scenarios functions and the session core (ADR-014 §1.1,
 * ADR-015 §3). Built only from the engine's public entry (PR-19); the UI adds no simulation logic.
 *
 * `accumulatedImpact` (ADR-013) is not exported by the engine until T2.6. Until then this entry
 * throws instead of computing anything here; when T2.6 is in main, replace it with the engine's
 * runtime export (one import line).
 */
import type { AccumulatedImpact } from '@whodeployed/engine'
import { createSimulation, defaultShop, resolveFaults } from '@whodeployed/engine'
import type { EngineRuntime } from '@whodeployed/scenarios'

const accumulatedImpact: AccumulatedImpact = () => {
  throw new Error('accumulatedImpact is not available: @whodeployed/engine does not export it yet (T2.6)')
}

export const engineRuntime: EngineRuntime = {
  resolveFaults,
  createSimulation,
  accumulatedImpact,
  systems: { 'default-shop': defaultShop },
}
