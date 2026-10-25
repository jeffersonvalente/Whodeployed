/**
 * buildWorld / validateSystem (T1.3): W-3 (an arbitrary 2 services + 1 dependency world is
 * accepted as input data), rejection of invalid systems with EngineError('invalid_system')
 * naming the field, and DET.
 */
import { describe, expect, it } from 'vitest'
import { EngineError } from '../../src/errors.js'
import { buildWorld, instanceIds, validateSystem } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type { SystemDefinition } from '../../src/types.js'

// Tests mutate definitions freely to build invalid inputs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>

const base = { latencyP50Ms: 3, latencyP99Ms: 9, cpuBasePct: 1, cpuPerRequestPct: 0.5, memBaseMb: 64 }

/** W-3: a world unlike default-shop, built in the test itself. */
function miniSystem(): SystemDefinition {
  return {
    name: 'mini',
    services: [
      {
        ...base,
        name: 'front',
        replicas: 2,
        ingress: { ratePerTick: 5, operation: 'http.request' },
        calls: [{ target: 'store', operation: 'store.read', ratio: 1, timeoutMs: 200, retries: 1 }],
        dbPoolSize: 4,
      },
      {
        ...base,
        name: 'store',
        replicas: 1,
        calls: [{ target: 'kv', operation: 'kv.get', ratio: 0.5, timeoutMs: 50, retries: 0 }],
        dbPoolSize: 1,
      },
    ],
    deps: [{ ...base, name: 'kv', kind: 'cache', replicas: 1, maxConnections: 10, cacheHitRatio: 0.5 }],
  }
}

/** Runs `mutate` on a fresh copy of the mini system and returns the thrown EngineError. */
function rejection(mutate: (s: Loose) => void, seed = 'x'): EngineError {
  const system = miniSystem() as unknown as Loose
  mutate(system)
  try {
    buildWorld(system as unknown as SystemDefinition, seed)
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError)
    return error as EngineError
  }
  throw new Error('expected buildWorld to throw')
}

describe('W-3: the system is input data', () => {
  const valid = (): SystemDefinition => {
    const s = miniSystem()
    s.services[1]!.calls[0]!.onMiss = { target: 'kv2', operation: 'db.query', timeoutMs: 30, retries: 1 }
    s.deps.push({ ...base, name: 'kv2', kind: 'database', replicas: 1, maxConnections: 5 })
    return s
  }

  it('accepts a minimal world of 2 services + 1 dependency', () => {
    const world = buildWorld(miniSystem(), 'mini-seed')
    expect(world.services.map((x) => x.name)).toEqual(['front', 'store'])
    expect(world.deps.map((x) => x.name)).toEqual(['kv'])
    expect(world.services[0]!.instances).toEqual(['front-0', 'front-1'])
    expect(world.services[1]!.instances).toEqual(['store-0'])
    expect(world.deps[0]!.instances).toEqual(['kv-0'])
    expect(world).toMatchObject({ tick: 0, seed: 'mini-seed' })
  })

  it('copies the input: later mutations of the definition do not leak into the world', () => {
    const s = valid()
    const world = buildWorld(s, 'copy')
    s.services[0]!.replicas = 99
    s.services[0]!.calls[0]!.timeoutMs = 1
    s.deps[0]!.name = 'renamed'
    expect(world.services[0]!.replicas).toBe(2)
    expect(world.services[0]!.calls[0]!.timeoutMs).toBe(200)
    expect(world.deps[0]!.name).toBe('kv')
  })

  it('normalizes key order and drops unknown keys, so equal definitions give equal worlds', () => {
    const s = valid()
    const shuffled = JSON.parse(JSON.stringify(s), (_k, v) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse().concat([['extra', 1]]))
        : v,
    ) as SystemDefinition
    expect(JSON.stringify(buildWorld(shuffled, 'k'))).toBe(JSON.stringify(buildWorld(s, 'k')))
  })

  it('validateSystem returns the normalized definition without instances', () => {
    const normalized = validateSystem(valid())
    expect(normalized.services[0]).not.toHaveProperty('instances')
    expect(normalized).toStrictEqual(validateSystem(normalized))
  })

  it('accepts an empty dependency list', () => {
    const s: SystemDefinition = {
      name: 'deps-free',
      services: [
        { ...base, name: 'a', replicas: 1, calls: [{ target: 'b', operation: 'b.op', ratio: 1, timeoutMs: 5, retries: 0 }], dbPoolSize: 1 },
        { ...base, name: 'b', replicas: 1, calls: [], dbPoolSize: 1 },
      ],
      deps: [],
    }
    expect(buildWorld(s, 's').deps).toEqual([])
  })

  it('accepts onMiss to a service when it creates no cycle', () => {
    const s = miniSystem()
    s.services.push({ ...base, name: 'origin', replicas: 1, calls: [], dbPoolSize: 1 })
    s.services[1]!.calls[0]!.onMiss = { target: 'origin', operation: 'origin.fetch', timeoutMs: 40, retries: 2 }
    expect(buildWorld(s, 's').services[1]!.calls[0]!.onMiss).toStrictEqual({
      target: 'origin', operation: 'origin.fetch', timeoutMs: 40, retries: 2,
    })
  })

  it('instanceIds is a pure function of name and replicas', () => {
    expect(instanceIds('svc', 3)).toEqual(['svc-0', 'svc-1', 'svc-2'])
    expect(instanceIds('svc', 0)).toEqual([])
  })
})

describe('invalid systems throw EngineError(invalid_system) naming the field', () => {
  type Case = [label: string, mutate: (s: Loose) => unknown, field: string, validValues?: readonly (string | number)[]]
  const cases: Case[] = [
    ['duplicate service name', (s) => (s.services[1].name = 'front'), 'system.services[1].name'],
    ['dependency named like a service', (s) => (s.deps[0].name = 'store'), 'system.deps[0].name'],
    ['call to a nonexistent component', (s) => (s.services[0].calls[0].target = 'ghost'), 'system.services[0].calls[0].target', ['store', 'kv']],
    ['call to itself', (s) => (s.services[0].calls[0].target = 'front'), 'system.services[0].calls[0].target', ['store', 'kv']],
    [
      'onMiss on a call that is not to a cache',
      (s) => (s.services[0].calls[0].onMiss = { target: 'kv', operation: 'x', timeoutMs: 1, retries: 0 }),
      'system.services[0].calls[0].onMiss',
      ['kv'],
    ],
    [
      'onMiss to a nonexistent component',
      (s) => (s.services[1].calls[0].onMiss = { target: 'ghost', operation: 'x', timeoutMs: 1, retries: 0 }),
      'system.services[1].calls[0].onMiss.target',
      ['front', 'kv'],
    ],
    [
      'onMiss back to the same cache',
      (s) => (s.services[1].calls[0].onMiss = { target: 'kv', operation: 'x', timeoutMs: 1, retries: 0 }),
      'system.services[1].calls[0].onMiss.target',
    ],
    [
      'nested onMiss',
      (s) => {
        s.deps.push({ ...base, name: 'db', kind: 'database', replicas: 1, maxConnections: 1 })
        s.services[1].calls[0].onMiss = {
          target: 'db', operation: 'x', timeoutMs: 1, retries: 0,
          onMiss: { target: 'db', operation: 'y', timeoutMs: 1, retries: 0 },
        }
      },
      'system.services[1].calls[0].onMiss.onMiss',
    ],
    [
      'call cycle through onMiss',
      (s) => (s.services[1].calls[0].onMiss = { target: 'front', operation: 'x', timeoutMs: 1, retries: 0 }),
      'system.services[1].calls[0]',
    ],
    ['replicas < 1', (s) => (s.services[0].replicas = 0), 'system.services[0].replicas'],
    ['non-integer replicas', (s) => (s.deps[0].replicas = 1.5), 'system.deps[0].replicas'],
    ['missing replicas', (s) => delete s.services[1].replicas, 'system.services[1].replicas'],
    ['p99 below p50', (s) => (s.services[0].latencyP99Ms = 1), 'system.services[0].latencyP99Ms'],
    ['zero p50', (s) => (s.services[0].latencyP50Ms = 0), 'system.services[0].latencyP50Ms'],
    ['cpu above 100', (s) => (s.services[0].cpuBasePct = 101), 'system.services[0].cpuBasePct'],
    ['NaN memory', (s) => (s.deps[0].memBaseMb = Number.NaN), 'system.deps[0].memBaseMb'],
    ['ratio above 1', (s) => (s.services[0].calls[0].ratio = 1.2), 'system.services[0].calls[0].ratio'],
    ['zero timeout', (s) => (s.services[0].calls[0].timeoutMs = 0), 'system.services[0].calls[0].timeoutMs'],
    ['negative retries', (s) => (s.services[0].calls[0].retries = -1), 'system.services[0].calls[0].retries'],
    ['empty operation', (s) => (s.services[0].calls[0].operation = ''), 'system.services[0].calls[0].operation'],
    ['calls not an array', (s) => (s.services[0].calls = {}), 'system.services[0].calls'],
    ['call not an object', (s) => (s.services[0].calls[0] = 'store'), 'system.services[0].calls[0]'],
    ['dbPoolSize < 1', (s) => (s.services[0].dbPoolSize = 0), 'system.services[0].dbPoolSize'],
    ['negative ingress rate', (s) => (s.services[0].ingress.ratePerTick = -1), 'system.services[0].ingress.ratePerTick'],
    ['ingress without operation', (s) => delete s.services[0].ingress.operation, 'system.services[0].ingress.operation'],
    ['unknown dependency kind', (s) => (s.deps[0].kind = 'blob'), 'system.deps[0].kind', ['database', 'cache', 'queue']],
    ['maxConnections < 1', (s) => (s.deps[0].maxConnections = 0), 'system.deps[0].maxConnections'],
    ['cache without hit ratio', (s) => delete s.deps[0].cacheHitRatio, 'system.deps[0].cacheHitRatio'],
    ['hit ratio above 1', (s) => (s.deps[0].cacheHitRatio = 2), 'system.deps[0].cacheHitRatio'],
    [
      'hit ratio on a non-cache',
      (s) => s.deps.push({ ...base, name: 'db', kind: 'database', replicas: 1, maxConnections: 1, cacheHitRatio: 0.5 }),
      'system.deps[1].cacheHitRatio',
    ],
    ['name with spaces', (s) => (s.services[0].name = 'my service'), 'system.services[0].name'],
    ['name with the --fault separator', (s) => (s.deps[0].name = 'kv:1'), 'system.deps[0].name'],
    ['empty name', (s) => (s.services[0].name = ''), 'system.services[0].name'],
    ['no services', (s) => (s.services = []), 'system.services'],
    ['services not an array', (s) => (s.services = null), 'system.services'],
    ['deps missing', (s) => delete s.deps, 'system.deps'],
    ['service not an object', (s) => (s.services[1] = 7), 'system.services[1]'],
    ['dependency not an object', (s) => (s.deps[0] = []), 'system.deps[0]'],
    ['system name missing', (s) => delete s.name, 'system.name'],
  ]

  it.each(cases)('%s', (_label, mutate, field, validValues) => {
    const error = rejection(mutate)
    expect(error.code).toBe('invalid_system')
    expect(error.name).toBe('EngineError')
    expect(error.field).toBe(field)
    expect(error.message).toContain(field)
    if (validValues !== undefined) {
      expect(error.validValues).toEqual(validValues)
      for (const v of validValues) expect(error.message).toContain(String(v))
    }
  })

  it('rejects a call cycle between services and names the path', () => {
    const error = rejection((s) => {
      s.services[1].calls.push({ target: 'front', operation: 'loop', ratio: 1, timeoutMs: 5, retries: 0 })
    })
    expect(error.field).toBe('system.services[1].calls[1]')
    expect(error.message).toContain('front -> store -> front')
  })

  it('rejects a non-object system', () => {
    expect(() => buildWorld(null as unknown as SystemDefinition, 's')).toThrow(
      expect.objectContaining({ code: 'invalid_system', field: 'system' }),
    )
  })
})

describe('seed validation', () => {
  it.each([[''], [42], [undefined]])('rejects seed %j with invalid_seed', (seed) => {
    expect(() => buildWorld(defaultShop, seed as unknown as string)).toThrow(
      expect.objectContaining({ name: 'EngineError', code: 'invalid_seed', field: 'seed' }),
    )
  })
})

describe('determinism (DET)', () => {
  it('same system + seed => toStrictEqual and identical JSON; the seed is only recorded', () => {
    const s = miniSystem()
    const a = buildWorld(s, 'seed-a')
    expect(buildWorld(s, 'seed-a')).toStrictEqual(a)
    expect(JSON.stringify(buildWorld(s, 'seed-a'))).toBe(JSON.stringify(a))
    const other = buildWorld(s, 'seed-b')
    expect({ ...other, seed: 'seed-a' }).toStrictEqual(a)
  })

  it('same invalid input => same error, every time', () => {
    const run = () => rejection((s) => (s.services[0].calls[0].target = 'ghost'))
    expect(run().toJSON()).toStrictEqual(run().toJSON())
  })
})
