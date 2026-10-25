/**
 * Fault registry: maps each FaultKind to its module (ADR-002 §2).
 * Complete from T1.1 on; fault tasks replace module bodies, never this file.
 */
import type { FaultRegistry } from '../types.js'
import { badDeploy } from './bad_deploy.js'
import { cacheColdStart } from './cache_cold_start.js'
import { connectionPoolExhaustion } from './connection_pool_exhaustion.js'
import { diskFull } from './disk_full.js'
import { serviceCrashLoop } from './service_crash_loop.js'
import { slowDependency } from './slow_dependency.js'

export const faultRegistry: FaultRegistry = {
  service_crash_loop: serviceCrashLoop,
  disk_full: diskFull,
  connection_pool_exhaustion: connectionPoolExhaustion,
  bad_deploy: badDeploy,
  slow_dependency: slowDependency,
  cache_cold_start: cacheColdStart,
}
