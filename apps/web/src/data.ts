/**
 * The ONLY module that provides the scenario bundle to the UI (ADR-015 §3); tests vi.mock it.
 *
 * Stub (T2.21): an empty bundle, typed by the scenarios contract. T2.32 replaces the body with
 * the real import of `@whodeployed/scenarios/data` (generated from the YAML at build time,
 * ADR-014 §4). The UI never reads YAML (SPEC §6, PR-19).
 */
import type { ScenarioBundle } from '@whodeployed/scenarios'

export const bundle: ScenarioBundle = { campaign: [], testIncidents: [] }
