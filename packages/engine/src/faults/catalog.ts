/**
 * Fault catalog: transcription of the parameter table of ADR-004 (fault kinds).
 *
 * Data only. Read by resolveFaults (defaults + F-7 validation), by the CLI --help and by
 * the fault modules. Each fault task (T1.17..T1.22) may edit only its own entry, and only
 * together with the matching row of ADR-004.
 */
import type { FaultCatalog, FaultKind } from '../types.js'

/** Default first tick of every fault kind (ADR-004). */
export const DEFAULT_START_TICK = 10

export const faultCatalog: FaultCatalog = {
  service_crash_loop: {
    kind: 'service_crash_loop',
    campaignRow: 1,
    summary: 'Every instance of a service alternates between up and down (crash loop).',
    defaultTarget: 'catalog',
    defaultStartTick: DEFAULT_START_TICK,
    targetRule: 'service',
    params: {
      uptimeTicks: {
        default: 1,
        min: 1,
        max: 30,
        integer: true,
        unit: 'ticks',
        description: 'Ticks an instance stays up before crashing.',
      },
      restartTicks: {
        default: 3,
        min: 1,
        max: 30,
        integer: true,
        unit: 'ticks',
        description: 'Ticks an instance stays down while restarting.',
      },
    },
  },
  disk_full: {
    kind: 'disk_full',
    campaignRow: 2,
    summary: 'A database fills its disk; after fillTicks, writes fail with probability failRatio.',
    defaultTarget: 'postgres',
    defaultStartTick: DEFAULT_START_TICK,
    targetRule: 'database',
    params: {
      fillTicks: {
        default: 3,
        min: 0,
        max: 30,
        integer: true,
        unit: 'ticks',
        description: 'Ticks of high disk usage warnings before requests start failing.',
      },
      failRatio: {
        // 0.9 (ADR-004 Emenda 3, T1.36): the only value of {0.6, 0.7, 0.8, 0.9} with 0 R3/R4
        // violations (orders-worker error % and postgres) over seeds arch-0..arch-19999.
        default: 0.9,
        min: 0.05,
        max: 1,
        integer: false,
        unit: 'ratio',
        description: 'Probability that a request served by the target fails once the disk is full.',
      },
    },
  },
  connection_pool_exhaustion: {
    kind: 'connection_pool_exhaustion',
    campaignRow: 3,
    summary: 'A service leaks database connections until its pool is exhausted and callers wait.',
    defaultTarget: 'payment',
    defaultStartTick: DEFAULT_START_TICK,
    // "service that calls a database": resolveFaults checks the call to a database (F-7).
    targetRule: 'service',
    params: {
      poolSize: {
        default: 20,
        min: 1,
        max: 500,
        integer: true,
        unit: 'connections',
        description: 'Connection pool size per instance of the target (overrides dbPoolSize).',
      },
      leakPerTick: {
        // 4 (ADR-004 Emenda 2): with poolSize 20 the pool is exhausted from s = 4, so the whole
        // signature window (s = 6..11) is exhausted in every seed: leakedAt(6) >= poolSize.
        default: 4,
        min: 0,
        max: 100,
        integer: true,
        unit: 'connections/tick',
        description: 'Connections leaked per tick per instance.',
      },
      acquireTimeoutMs: {
        default: 2000,
        min: 100,
        max: 30000,
        integer: true,
        unit: 'ms',
        description: 'Maximum wait for a free connection before the call fails.',
      },
    },
  },
  bad_deploy: {
    kind: 'bad_deploy',
    campaignRow: 4,
    summary: 'A bad version is deployed to some instances of a service; their requests fail.',
    // gateway: its failed requests never reach the services behind it, so the fault shows outside
    // the target (F-4). Behind a caller with retries (e.g. catalog) the next instance absorbs them.
    defaultTarget: 'gateway',
    defaultStartTick: DEFAULT_START_TICK,
    // "service with >= 2 instances": resolveFaults checks replicas and caps affectedInstances.
    targetRule: 'service',
    params: {
      affectedInstances: {
        default: 1,
        min: 1,
        // Effective maximum is replicas - 1 of the target, applied by resolveFaults (ADR-004).
        max: 64,
        integer: true,
        unit: 'instances',
        description: 'Instances that receive the bad deploy (at most replicas - 1).',
      },
      errorRatio: {
        default: 0.9,
        min: 0.05,
        max: 1,
        integer: false,
        unit: 'ratio',
        description: 'Probability that a request served by an affected instance fails.',
      },
    },
  },
  slow_dependency: {
    kind: 'slow_dependency',
    campaignRow: 5,
    summary: 'A component becomes slow; callers time out and retry (the retry storm emerges).',
    defaultTarget: 'postgres',
    defaultStartTick: DEFAULT_START_TICK,
    // "any component with callers": resolveFaults checks that something calls the target.
    targetRule: 'any',
    params: {
      addedLatencyMs: {
        default: 1500,
        min: 50,
        max: 30000,
        integer: true,
        unit: 'ms',
        description: 'Latency added to every request served by the target.',
      },
    },
  },
  cache_cold_start: {
    kind: 'cache_cold_start',
    campaignRow: 7,
    summary: 'A cache restarts empty; misses fall through to the backing store until it warms up.',
    defaultTarget: 'redis',
    defaultStartTick: DEFAULT_START_TICK,
    targetRule: 'cache',
    params: {
      // 30 ticks (5 min): the signature window (startTick+6..+11) must still be cold, otherwise
      // nothing outside the cache deviates there (F-4, and the p50 condition of F-3 row 7).
      warmupTicks: {
        default: 30,
        min: 1,
        max: 60,
        integer: true,
        unit: 'ticks',
        description: 'Ticks until the hit ratio is back to normal.',
      },
    },
  },
}

/** The 6 fault kinds, in ADR-004 order (campaign rows 1, 2, 3, 4, 5, 7). */
export const faultKinds: readonly FaultKind[] = [
  'service_crash_loop',
  'disk_full',
  'connection_pool_exhaustion',
  'bad_deploy',
  'slow_dependency',
  'cache_cold_start',
]
