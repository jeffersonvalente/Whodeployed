/**
 * toSimulationConfig (Scenario -> engine input). FASE-2 EN-5; ADR-014 §1.1, §2.
 *
 * Its own module so that the "." entry (browser) can export it without pulling the YAML loader:
 * nothing reachable from src/index.ts imports `yaml` or `node:*` (ADR-014 Emenda 1).
 */
import type { SimulationConfig } from '@whodeployed/engine'
import { ScenarioError } from './errors.js'
import type { EngineRuntime, Scenario, ToSimulationConfig } from './types.js'

/** The engine input of a scenario and nothing else: no scenario text reaches the engine (EN-5). */
export const toSimulationConfig: ToSimulationConfig = (scenario: Scenario, engine: EngineRuntime): SimulationConfig => {
  const known = Object.prototype.hasOwnProperty.call(engine.systems, scenario.system)
  const system = known ? engine.systems[scenario.system] : undefined
  if (system === undefined) {
    throw new ScenarioError({
      file: scenario.id,
      field: 'system',
      reason: `unknown system '${scenario.system}' (valid values: ${Object.keys(engine.systems).join(', ')})`,
    })
  }
  return { system, seed: scenario.seed, faults: scenario.faults, noise: scenario.noise }
}
