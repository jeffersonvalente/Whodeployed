/**
 * Fault module `connection_pool_exhaustion` (semantics: ADR-004).
 *
 * Scaffolding stub (T1.1): activate() returns no hooks, so the fault has no effect yet.
 * Task T1.19 replaces only the body of this file.
 */
import type { FaultModule } from '../types.js'

export const connectionPoolExhaustion: FaultModule<'connection_pool_exhaustion'> = {
  kind: 'connection_pool_exhaustion',
  activate: () => ({}),
}
