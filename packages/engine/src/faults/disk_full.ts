/**
 * Fault module `disk_full` (semantics: ADR-004).
 *
 * Scaffolding stub (T1.1): activate() returns no hooks, so the fault has no effect yet.
 * Task T1.18 replaces only the body of this file.
 */
import type { FaultModule } from '../types.js'

export const diskFull: FaultModule<'disk_full'> = {
  kind: 'disk_full',
  activate: () => ({}),
}
