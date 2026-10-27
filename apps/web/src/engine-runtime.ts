/**
 * The EngineRuntime injected into the scenarios functions and the session core (ADR-014 §1.1,
 * ADR-015 §3). Built only from the engine's public entry (PR-19); the UI adds no simulation logic.
 */
import { accumulatedImpact, createSimulation, defaultShop, resolveFaults } from '@whodeployed/engine'
import type { EngineRuntime } from '@whodeployed/scenarios'

export const engineRuntime: EngineRuntime = {
  resolveFaults,
  createSimulation,
  accumulatedImpact,
  systems: { 'default-shop': defaultShop },
}
