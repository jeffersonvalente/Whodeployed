/**
 * Fault module `bad_deploy` (semantics: ADR-004).
 *
 * Scaffolding stub (T1.1): activate() returns no hooks, so the fault has no effect yet.
 * Task T1.20 replaces only the body of this file.
 */
import type { FaultModule } from '../types.js'

export const badDeploy: FaultModule<'bad_deploy'> = {
  kind: 'bad_deploy',
  activate: () => ({}),
}
