/**
 * @whodeployed/scenarios — public entry ("."), safe for the browser (ADR-014 §4).
 *
 * Browser-safe runtime API: toSimulationConfig, matchesPattern, repertoire, inRepertoire,
 * checkMitigations (T2.13) and ScenarioError. Nothing reachable from this file imports `yaml` or a
 * Node built-in (ADR-014 Emenda 1; test/browser-entry.test.ts): the YAML loader (parseScenario)
 * and the file helpers live in "./node", the generated data in "./data"; neither is re-exported
 * from this file.
 *
 * Nothing in src/ imports a runtime value from '@whodeployed/engine' (SPEC §6 "engine (types)",
 * ADR-014 §1.1): see eslint.config.js and test/type-only-engine.test.ts.
 */
export type * from './types.js'
export { inRepertoire, repertoire } from './repertoire.js'

// T2.10: errors (CN-4), question patterns, engine input. parseScenario is in "./node" (Emenda 1).
export { ScenarioError } from './errors.js'
export { toSimulationConfig } from './config.js'
export { matchesPattern } from './patterns.js'
