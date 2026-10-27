/**
 * @whodeployed/scenarios — public entry ("."), safe for the browser (ADR-014 §4).
 *
 * T2.9 (scaffolding): types only. The runtime API (parseScenario, toSimulationConfig,
 * matchesPattern, repertoire, inRepertoire, checkMitigations, ScenarioError) is added here by
 * T2.10, T2.11 and T2.13. Node-only helpers live in "./node" and the generated data in "./data";
 * neither is re-exported from this file.
 *
 * Nothing in src/ imports a runtime value from '@whodeployed/engine' (SPEC §6 "engine (types)",
 * ADR-014 §1.1): see eslint.config.js and test/type-only-engine.test.ts.
 */
export type * from './types.js'
