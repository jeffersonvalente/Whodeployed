/**
 * Fixture scenarios for apps/web tests (ADR-014 "Consequências": the UI tests against fixtures,
 * without waiting for the real YAML files). Typed by the scenarios contract; faults are already
 * resolved (every catalog param present, ADR-004 defaults), as the loader would return them.
 *
 * The text is fixture-only and deliberately unlike any campaign scenario (CN-8 greps the real
 * YAML strings in apps/web/src; these never enter src/).
 */
import type { Scenario, ScenarioBundle } from '@whodeployed/scenarios'

/** Junior: one crash-looping service, restart mitigates. */
export const juniorFixture: Scenario = {
  id: '91-fixture-junior',
  title: 'Fixture: junior incident',
  level: 'junior',
  teaches: 'Fixture lesson (junior).',
  trap: 'Fixture trap (junior).',
  seed: 'fixture-junior-01',
  system: 'default-shop',
  faults: [{ kind: 'service_crash_loop', target: 'catalog', startTick: 10, params: { uptimeTicks: 1, restartTicks: 3 } }],
  noise: [],
  alert: { tick: 14, text: 'fixture alert: catalog 5xx' },
  impactBudget: 60,
  referencePath: [
    { type: 'ask', question: { kind: 'logs', service: 'catalog', window: 30 } },
    { type: 'act', action: { kind: 'restart', target: 'catalog' } },
  ],
  rootCause: 'Fixture root cause (junior).',
  review: {
    redundant: [{ kind: 'dashboard', service: 'gateway' }],
    keySignal: 'Fixture key signal (junior).',
    keySignalAsk: { kind: 'logs', service: 'catalog' },
  },
  testIncident: false,
}

/** Pleno: a bad deploy on one instance, with one noise deploy; rollback mitigates. */
export const plenoFixture: Scenario = {
  id: '92-fixture-pleno',
  title: 'Fixture: pleno incident',
  level: 'pleno',
  teaches: 'Fixture lesson (pleno).',
  trap: 'Fixture trap (pleno).',
  seed: 'fixture-pleno-01',
  system: 'default-shop',
  faults: [{ kind: 'bad_deploy', target: 'cart', startTick: 12, params: { affectedInstances: 1, errorRatio: 0.9 } }],
  noise: [{ kind: 'deploy', target: 'auth', tick: 8, note: 'fixture noise' }],
  alert: { tick: 18, text: 'fixture alert: cart errors' },
  impactBudget: 60,
  referencePath: [
    { type: 'ask', question: { kind: 'whatChanged', window: 30 } },
    { type: 'ask', question: { kind: 'compare', service: 'cart', metric: 'errorPct', by: 'instance' } },
    { type: 'act', action: { kind: 'rollback', target: 'cart' } },
  ],
  rootCause: 'Fixture root cause (pleno).',
  review: {
    redundant: [],
    keySignal: 'Fixture key signal (pleno).',
    keySignalAsk: { kind: 'compare', service: 'cart' },
  },
  testIncident: false,
}

/** Test incident: opened only through the test mode, never listed (PR-4). */
export const testIncidentFixture: Scenario = {
  ...plenoFixture,
  id: 'test-fixture-a',
  title: 'Fixture: test incident',
  seed: 'fixture-test-a',
  faults: [{ kind: 'bad_deploy', target: 'orders-worker', startTick: 12, params: { affectedInstances: 1, errorRatio: 0.9 } }],
  alert: { tick: 18, text: 'fixture alert: orders backlog' },
  testIncident: true,
}

export const fixtureBundle: ScenarioBundle = {
  campaign: [juniorFixture, plenoFixture],
  testIncidents: [testIncidentFixture],
}
