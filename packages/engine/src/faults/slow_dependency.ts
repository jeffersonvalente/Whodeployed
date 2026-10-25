/**
 * Fault module `slow_dependency` (semantics: ADR-004).
 *
 * Scaffolding stub (T1.1): activate() returns no hooks, so the fault has no effect yet.
 * Task T1.21 replaces only the body of this file.
 */
import type { FaultModule } from '../types.js'

export const slowDependency: FaultModule<'slow_dependency'> = {
  kind: 'slow_dependency',
  activate: () => ({}),
}
