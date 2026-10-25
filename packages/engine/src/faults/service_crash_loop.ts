/**
 * Fault module `service_crash_loop` (semantics: ADR-004).
 *
 * Scaffolding stub (T1.1): activate() returns no hooks, so the fault has no effect yet.
 * Task T1.17 replaces only the body of this file.
 */
import type { FaultModule } from '../types.js'

export const serviceCrashLoop: FaultModule<'service_crash_loop'> = {
  kind: 'service_crash_loop',
  activate: () => ({}),
}
