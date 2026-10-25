/**
 * Fault module `cache_cold_start` (semantics: ADR-004).
 *
 * Scaffolding stub (T1.1): activate() returns no hooks, so the fault has no effect yet.
 * Task T1.22 replaces only the body of this file.
 */
import type { FaultModule } from '../types.js'

export const cacheColdStart: FaultModule<'cache_cold_start'> = {
  kind: 'cache_cold_start',
  activate: () => ({}),
}
