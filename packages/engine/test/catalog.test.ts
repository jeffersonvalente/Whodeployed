/**
 * The fault catalog transcribes ADR-004, every default is inside its range, and the fault
 * registry has one (currently no-op) module per kind.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_START_TICK, faultCatalog, faultKinds } from '../src/faults/catalog.js'
import { faultRegistry } from '../src/faults/registry.js'
import type { Fault, FaultKind, FaultModule, RngFactory, World } from '../src/types.js'

/** ADR-004 table: kind -> [campaignRow, defaultTarget, targetRule, { param: [default, min, max, integer, unit] }]. */
const ADR_004: Record<
  FaultKind,
  [number, string, string, Record<string, [number, number, number, boolean, string]>]
> = {
  service_crash_loop: [1, 'catalog', 'service', {
    uptimeTicks: [1, 1, 30, true, 'ticks'],
    restartTicks: [3, 1, 30, true, 'ticks'],
  }],
  disk_full: [2, 'postgres', 'database', {
    fillTicks: [3, 0, 30, true, 'ticks'],
    failRatio: [0.4, 0.05, 1, false, 'ratio'],
  }],
  connection_pool_exhaustion: [3, 'payment', 'service', {
    poolSize: [20, 1, 500, true, 'connections'],
    leakPerTick: [2, 0, 100, true, 'connections/tick'],
    acquireTimeoutMs: [2000, 100, 30000, true, 'ms'],
  }],
  bad_deploy: [4, 'catalog', 'service', {
    affectedInstances: [1, 1, 64, true, 'instances'],
    errorRatio: [0.6, 0.05, 1, false, 'ratio'],
  }],
  slow_dependency: [5, 'postgres', 'any', {
    addedLatencyMs: [1500, 50, 30000, true, 'ms'],
  }],
  cache_cold_start: [7, 'redis', 'cache', {
    warmupTicks: [6, 1, 60, true, 'ticks'],
  }],
}

describe('fault catalog (ADR-004)', () => {
  it('lists the 6 kinds in ADR-004 order, mapped to campaign rows 1, 2, 3, 4, 5, 7', () => {
    expect(Object.keys(faultCatalog)).toEqual([...faultKinds])
    expect(faultKinds.map((k) => faultCatalog[k].campaignRow)).toEqual([1, 2, 3, 4, 5, 7])
  })

  it.each(faultKinds)('%s transcribes its ADR-004 row', (kind) => {
    const entry = faultCatalog[kind]
    const [row, target, rule, params] = ADR_004[kind]
    expect(entry.kind).toBe(kind)
    expect(entry.campaignRow).toBe(row)
    expect(entry.defaultTarget).toBe(target)
    expect(entry.targetRule).toBe(rule)
    expect(entry.defaultStartTick).toBe(DEFAULT_START_TICK)
    expect(DEFAULT_START_TICK).toBe(10)
    expect(entry.summary.length).toBeGreaterThan(0)
    expect(Object.keys(entry.params)).toEqual(Object.keys(params))
    for (const [name, [def, min, max, integer, unit]] of Object.entries(params)) {
      expect(entry.params[name], name).toMatchObject({ default: def, min, max, integer, unit })
    }
  })

  it.each(faultKinds)('%s has every default inside its range, integers where declared', (kind) => {
    for (const [name, spec] of Object.entries(faultCatalog[kind].params)) {
      expect(spec.min, `${kind}.${name} min <= max`).toBeLessThanOrEqual(spec.max)
      expect(spec.default, `${kind}.${name} >= min`).toBeGreaterThanOrEqual(spec.min)
      expect(spec.default, `${kind}.${name} <= max`).toBeLessThanOrEqual(spec.max)
      if (spec.integer) {
        expect(Number.isInteger(spec.default) && Number.isInteger(spec.min) && Number.isInteger(spec.max)).toBe(true)
      }
      expect(spec.unit.length).toBeGreaterThan(0)
      expect(spec.description.length).toBeGreaterThan(0)
    }
  })
})

// A small but realistic world containing every default target, so that real fault modules
// (T1.17..T1.22) can still be activated here without extra setup.
const component = { replicas: 3, latencyP50Ms: 5, latencyP99Ms: 20, cpuBasePct: 4, cpuPerRequestPct: 1, memBaseMb: 256 }
const ids = (name: string) => [0, 1, 2].map((i) => `${name}-${i}`)
const world: World = {
  services: [
    { ...component, name: 'catalog', calls: [{ target: 'redis', operation: 'cache.get', ratio: 1, timeoutMs: 100, retries: 1, onMiss: { target: 'postgres', operation: 'db.query', timeoutMs: 800, retries: 1 } }], dbPoolSize: 20, instances: ids('catalog') },
    { ...component, name: 'payment', calls: [{ target: 'postgres', operation: 'db.insert', ratio: 1, timeoutMs: 2000, retries: 1 }], dbPoolSize: 20, instances: ids('payment') },
  ],
  deps: [
    { ...component, replicas: 1, name: 'postgres', kind: 'database', maxConnections: 200, instances: ['postgres-0'] },
    { ...component, replicas: 1, name: 'redis', kind: 'cache', maxConnections: 1000, cacheHitRatio: 0.9, instances: ['redis-0'] },
  ],
  tick: 0,
  seed: 'catalog',
}

/** Deterministic stand-in for the seeded factory of src/sim/rng.ts (T1.2). */
const rng: RngFactory = () => {
  let state = 1
  const next = () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
  return {
    next,
    int: (min, maxExclusive) => min + Math.floor(next() * (maxExclusive - min)),
    chance: (p) => next() < p,
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)]
      if (item === undefined) throw new Error('pick from empty list')
      return item
    },
  }
}

describe('fault registry (ADR-002 §2)', () => {
  it('has exactly one module per catalog kind', () => {
    expect(Object.keys(faultRegistry).sort()).toEqual([...faultKinds].sort())
  })

  it.each(faultKinds)('%s module is registered under its own kind and activates', (kind) => {
    const module = faultRegistry[kind] as FaultModule
    expect(module.kind).toBe(kind)
    const entry = faultCatalog[kind]
    const fault: Fault = {
      kind,
      target: entry.defaultTarget,
      startTick: entry.defaultStartTick,
      params: Object.fromEntries(Object.entries(entry.params).map(([k, v]) => [k, v.default])),
    }
    const hooks = module.activate(fault, world, rng)
    expect(typeof hooks).toBe('object')
    // Same input => same hooks shape (DET for the stubs; real modules get their own tests).
    expect(Object.keys(module.activate(fault, world, rng))).toEqual(Object.keys(hooks))
  })
})
