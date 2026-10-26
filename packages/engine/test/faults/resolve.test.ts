/**
 * resolveFaults (T1.4): catalog defaults (ADR-004), overrides (CLI-2), every F-7 rejection with
 * EngineError carrying code, field and validValues, the effective affectedInstances limit, and DET.
 * T1.30: null in target/startTick/params/params.<name> is rejected, never defaulted (ADR-004 Emenda 1, #23).
 */
import { describe, expect, it } from 'vitest'
import { EngineError } from '../../src/errors.js'
import { faultCatalog, faultKinds } from '../../src/faults/catalog.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import type { Dependency, EngineErrorCode, FaultInput, Service, World } from '../../src/types.js'

const base = { latencyP50Ms: 5, latencyP99Ms: 20, cpuBasePct: 4, cpuPerRequestPct: 1, memBaseMb: 256 }
const ids = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name}-${i}`)
const service = (name: string, replicas: number, calls: Service['calls']): Service => ({
  ...base, name, replicas, calls, dbPoolSize: 20, instances: ids(name, replicas),
})
const dep = (name: string, kind: Dependency['kind'], extra: Partial<Dependency> = {}): Dependency => ({
  ...base, name, kind, replicas: 1, maxConnections: 100, ...extra, instances: ids(name, 1),
})
const call = (target: string, onMiss?: string): Service['calls'][number] => ({
  target, operation: `${target}.op`, ratio: 1, timeoutMs: 100, retries: 1,
  ...(onMiss === undefined ? {} : { onMiss: { target: onMiss, operation: 'db.query', timeoutMs: 500, retries: 1 } }),
})

/**
 * A world with every default target of ADR-004 plus components that break each extra target
 * condition: `solo` (1 replica), `leaf` (calls no database), `orphan` (nobody calls it).
 */
const world: World = {
  services: [
    service('gateway', 3, [call('catalog'), call('payment'), call('solo')]),
    service('catalog', 3, [call('redis', 'postgres')]),
    service('payment', 4, [call('postgres'), call('queue')]),
    service('solo', 1, [call('postgres')]),
    service('leaf', 2, [call('queue')]),
  ],
  deps: [
    dep('postgres', 'database'),
    dep('redis', 'cache', { cacheHitRatio: 0.9 }),
    dep('queue', 'queue'),
    dep('orphan', 'database'),
  ],
  tick: 0,
  seed: 'resolve',
}
const ALL = ['gateway', 'catalog', 'payment', 'solo', 'leaf', 'postgres', 'redis', 'queue', 'orphan']

function rejection(input: unknown, w: World = world): EngineError {
  try {
    resolveFaults([input as FaultInput], w)
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError)
    return error as EngineError
  }
  throw new Error('expected resolveFaults to throw')
}

describe('defaults (ADR-004)', () => {
  it.each(faultKinds)('%s with only `kind` gets the catalog target, startTick and every param default', (kind) => {
    const entry = faultCatalog[kind]
    const [fault] = resolveFaults([{ kind }], world)
    expect(fault).toStrictEqual({
      kind,
      target: entry.defaultTarget,
      startTick: 10,
      params: Object.fromEntries(Object.entries(entry.params).map(([k, v]) => [k, v.default])),
    })
  })

  it('returns an empty list for no inputs', () => {
    expect(resolveFaults([], world)).toEqual([])
  })
})

describe('overrides (CLI-2) and several faults (F-6)', () => {
  it('overrides target, startTick and params; untouched params keep their defaults', () => {
    const [fault] = resolveFaults(
      [{ kind: 'connection_pool_exhaustion', target: 'catalog', startTick: 0, params: { poolSize: 5 } }],
      world,
    )
    expect(fault).toStrictEqual({
      kind: 'connection_pool_exhaustion',
      target: 'catalog',
      startTick: 0,
      params: { poolSize: 5, leakPerTick: 4, acquireTimeoutMs: 2000 },
    })
  })

  it('accepts a service whose only database call is an onMiss (catalog -> redis -> postgres)', () => {
    expect(resolveFaults([{ kind: 'connection_pool_exhaustion', target: 'catalog' }], world)[0]?.target).toBe('catalog')
  })

  it('keeps params in catalog order whatever the input order', () => {
    const [fault] = resolveFaults([{ kind: 'bad_deploy', params: { errorRatio: 1, affectedInstances: 2 } }], world)
    expect(Object.keys(fault!.params)).toEqual(['affectedInstances', 'errorRatio'])
  })

  it('accepts the inclusive bounds of every param', () => {
    for (const kind of faultKinds) {
      for (const [name, spec] of Object.entries(faultCatalog[kind].params)) {
        const max = kind === 'bad_deploy' && name === 'affectedInstances' ? 2 : spec.max
        for (const value of [spec.min, max]) {
          const [fault] = resolveFaults([{ kind, params: { [name]: value } }], world)
          expect(fault?.params[name], `${kind}.${name}=${value}`).toBe(value)
        }
      }
    }
  })

  it('resolves several faults in order, including two of the same kind', () => {
    const faults = resolveFaults(
      [
        { kind: 'connection_pool_exhaustion', target: 'payment' },
        { kind: 'service_crash_loop', target: 'catalog', startTick: 3 },
        { kind: 'service_crash_loop', target: 'gateway' },
      ],
      world,
    )
    expect(faults.map((f) => [f.kind, f.target, f.startTick])).toEqual([
      ['connection_pool_exhaustion', 'payment', 10],
      ['service_crash_loop', 'catalog', 3],
      ['service_crash_loop', 'gateway', 10],
    ])
  })

  it('does not alias or mutate the input', () => {
    const params = { poolSize: 7 }
    const input = { kind: 'connection_pool_exhaustion', params }
    const [fault] = resolveFaults([input], world)
    expect(fault!.params).not.toBe(params)
    expect(input).toStrictEqual({ kind: 'connection_pool_exhaustion', params: { poolSize: 7 } })
  })
})

describe('invalid input throws EngineError (F-7)', () => {
  type Case = [label: string, input: unknown, code: EngineErrorCode, field: string, validValues: readonly (string | number)[]]
  const cases: Case[] = [
    ['unknown kind', { kind: 'disk_explosion' }, 'unknown_fault_kind', 'faults[0].kind', faultKinds],
    ['missing kind', {}, 'unknown_fault_kind', 'faults[0].kind', faultKinds],
    ['non-object input', 'disk_full', 'unknown_fault_kind', 'faults[0].kind', faultKinds],
    ['nonexistent target', { kind: 'disk_full', target: 'mysql' }, 'unknown_target', 'faults[0].target', ALL],
    ['non-string target', { kind: 'disk_full', target: 3 }, 'unknown_target', 'faults[0].target', ALL],
    ['service_crash_loop on a dependency', { kind: 'service_crash_loop', target: 'postgres' }, 'invalid_target', 'faults[0].target',
      ['gateway', 'catalog', 'payment', 'solo', 'leaf']],
    ['disk_full on a cache', { kind: 'disk_full', target: 'redis' }, 'invalid_target', 'faults[0].target', ['postgres', 'orphan']],
    ['disk_full on a service', { kind: 'disk_full', target: 'payment' }, 'invalid_target', 'faults[0].target', ['postgres', 'orphan']],
    ['cache_cold_start on a database', { kind: 'cache_cold_start', target: 'postgres' }, 'invalid_target', 'faults[0].target', ['redis']],
    ['pool fault on a dependency', { kind: 'connection_pool_exhaustion', target: 'postgres' }, 'invalid_target', 'faults[0].target',
      ['catalog', 'payment', 'solo']],
    ['pool fault on a service with no database call', { kind: 'connection_pool_exhaustion', target: 'leaf' }, 'invalid_target',
      'faults[0].target', ['catalog', 'payment', 'solo']],
    ['bad_deploy on a single-instance service', { kind: 'bad_deploy', target: 'solo' }, 'invalid_target', 'faults[0].target',
      ['gateway', 'catalog', 'payment', 'leaf']],
    ['bad_deploy on a dependency', { kind: 'bad_deploy', target: 'redis' }, 'invalid_target', 'faults[0].target',
      ['gateway', 'catalog', 'payment', 'leaf']],
    ['slow_dependency on a component nobody calls', { kind: 'slow_dependency', target: 'orphan' }, 'invalid_target', 'faults[0].target',
      ['catalog', 'payment', 'solo', 'postgres', 'redis', 'queue']],
    ['negative startTick', { kind: 'disk_full', startTick: -1 }, 'invalid_start_tick', 'faults[0].startTick', ['integer >= 0']],
    ['non-integer startTick', { kind: 'disk_full', startTick: 2.5 }, 'invalid_start_tick', 'faults[0].startTick', ['integer >= 0']],
    ['string startTick', { kind: 'disk_full', startTick: '3' }, 'invalid_start_tick', 'faults[0].startTick', ['integer >= 0']],
    ['unknown param', { kind: 'disk_full', params: { fillRatio: 1 } }, 'unknown_param', 'faults[0].params.fillRatio',
      ['fillTicks', 'failRatio']],
    ['params not an object', { kind: 'disk_full', params: [1] }, 'unknown_param', 'faults[0].params', ['fillTicks', 'failRatio']],
    ['param below range', { kind: 'connection_pool_exhaustion', params: { poolSize: 0 } }, 'param_out_of_range',
      'faults[0].params.poolSize', ['1..500']],
    ['param above range', { kind: 'disk_full', params: { failRatio: 1.5 } }, 'param_out_of_range', 'faults[0].params.failRatio',
      ['0.05..1']],
    ['non-integer integer param', { kind: 'connection_pool_exhaustion', params: { leakPerTick: 1.5 } }, 'param_out_of_range',
      'faults[0].params.leakPerTick', ['0..100']],
    ['NaN param', { kind: 'slow_dependency', params: { addedLatencyMs: Number.NaN } }, 'param_out_of_range',
      'faults[0].params.addedLatencyMs', ['50..30000']],
    ['string param', { kind: 'cache_cold_start', params: { warmupTicks: '6' } }, 'param_out_of_range',
      'faults[0].params.warmupTicks', ['1..60']],
    ['affectedInstances = replicas', { kind: 'bad_deploy', params: { affectedInstances: 3 } }, 'param_out_of_range',
      'faults[0].params.affectedInstances', ['1..2']],
  ]

  it.each(cases)('%s', (_label, input, code, field, validValues) => {
    const error = rejection(input)
    expect(error.name).toBe('EngineError')
    expect(error.code).toBe(code)
    expect(error.field).toBe(field)
    expect(error.validValues).toEqual(validValues)
    expect(error.message).toContain(field)
    for (const v of validValues) expect(error.message).toContain(String(v))
  })

  // ADR-004 Emenda 1 (#23), table "Entrada ausente vs null": null is invalid, never "absent".
  const nullCases: Case[] = [
    ['null target', { kind: 'disk_full', target: null }, 'unknown_target', 'faults[0].target', ALL],
    ['null startTick', { kind: 'disk_full', startTick: null }, 'invalid_start_tick', 'faults[0].startTick', ['integer >= 0']],
    ['null params.failRatio', { kind: 'disk_full', params: { failRatio: null } }, 'param_out_of_range',
      'faults[0].params.failRatio', ['0.05..1']],
    ['null params.poolSize', { kind: 'connection_pool_exhaustion', params: { poolSize: null } }, 'param_out_of_range',
      'faults[0].params.poolSize', ['1..500']],
    ['null params.affectedInstances (effective max)', { kind: 'bad_deploy', target: 'leaf', params: { affectedInstances: null } },
      'param_out_of_range', 'faults[0].params.affectedInstances', ['1..1']],
    ['null params', { kind: 'disk_full', params: null }, 'unknown_param', 'faults[0].params', ['fillTicks', 'failRatio']],
  ]

  it.each(nullCases)('%s (null is not absent)', (_label, input, code, field, validValues) => {
    const error = rejection(input)
    expect(error.code).toBe(code)
    expect(error.field).toBe(field)
    expect(error.validValues).toEqual(validValues)
    expect(error.received).toBeNull()
    expect(error.message).toContain(field)
    for (const v of validValues) expect(error.message).toContain(String(v))
  })

  it('every param of every kind rejects null with param_out_of_range', () => {
    for (const kind of faultKinds) {
      for (const name of Object.keys(faultCatalog[kind].params)) {
        const error = rejection({ kind, params: { [name]: null } })
        expect(error.code, `${kind}.${name}`).toBe('param_out_of_range')
        expect(error.field).toBe(`faults[0].params.${name}`)
      }
    }
  })

  it('a missing key and an explicit undefined still take the catalog default', () => {
    const expected = resolveFaults([{ kind: 'disk_full' }], world)
    expect(expected).toStrictEqual([
      { kind: 'disk_full', target: 'postgres', startTick: 10, params: { fillTicks: 3, failRatio: 0.4 } },
    ])
    const explicit = { kind: 'disk_full', target: undefined, startTick: undefined, params: undefined }
    expect(resolveFaults([explicit as unknown as FaultInput], world)).toStrictEqual(expected)
    const paramUndefined = { kind: 'disk_full', params: { failRatio: undefined, fillTicks: 5 } }
    expect(resolveFaults([paramUndefined as unknown as FaultInput], world)[0]?.params).toStrictEqual({ fillTicks: 5, failRatio: 0.4 })
  })

  it('reports the received value', () => {
    expect(rejection({ kind: 'disk_full', target: 'mysql' }).received).toBe('mysql')
    expect(rejection({ kind: 'disk_full', params: { failRatio: 2 } }).received).toBe(2)
    expect(rejection({ kind: 'nope' }).message).toContain('"nope"')
  })

  it('caps affectedInstances at replicas - 1 of the actual target and says why', () => {
    expect(resolveFaults([{ kind: 'bad_deploy', target: 'payment', params: { affectedInstances: 3 } }], world)[0]?.params['affectedInstances']).toBe(3)
    const error = rejection({ kind: 'bad_deploy', target: 'leaf', params: { affectedInstances: 2 } })
    expect(error.validValues).toEqual(['1..1'])
    expect(error.message).toContain("'leaf' replicas - 1")
  })

  it('names the index of the offending input among several', () => {
    try {
      resolveFaults([{ kind: 'disk_full' }, { kind: 'disk_full', startTick: -5 }], world)
      expect.unreachable()
    } catch (error) {
      expect((error as EngineError).field).toBe('faults[1].startTick')
    }
  })

  it('rejects a default target that is missing from an arbitrary world', () => {
    const tiny: World = { services: [service('api', 2, [call('db')])], deps: [dep('db', 'database')], tick: 0, seed: 's' }
    const error = rejection({ kind: 'service_crash_loop' }, tiny)
    expect(error.code).toBe('unknown_target')
    expect(error.received).toBe('catalog')
    expect(error.validValues).toEqual(['api', 'db'])
    // ...while an explicit target in that world works.
    expect(resolveFaults([{ kind: 'service_crash_loop', target: 'api' }], tiny)[0]?.target).toBe('api')
  })

  it('lists "(none)" when no component of the world can take the kind', () => {
    const tiny: World = { services: [service('api', 2, [call('db')])], deps: [dep('db', 'database')], tick: 0, seed: 's' }
    const error = rejection({ kind: 'cache_cold_start', target: 'db' }, tiny)
    expect(error.validValues).toEqual([])
    expect(error.message).toContain('(none)')
  })
})

describe('determinism (DET)', () => {
  it('same input => same Fault[] (deep and serialized)', () => {
    const inputs: FaultInput[] = [
      { kind: 'bad_deploy', params: { errorRatio: 0.9 } },
      { kind: 'slow_dependency', target: 'redis', startTick: 4 },
      ...faultKinds.map((kind) => ({ kind })),
    ]
    const a = resolveFaults(inputs, world)
    const b = resolveFaults(inputs, world)
    expect(a).toStrictEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('same invalid input => same error', () => {
    const input = { kind: 'disk_full', params: { failRatio: 9 } }
    expect(rejection(input).toJSON()).toStrictEqual(rejection(input).toJSON())
  })

  it('same null input => same error (T1.30)', () => {
    for (const input of [
      { kind: 'disk_full', target: null },
      { kind: 'disk_full', startTick: null },
      { kind: 'disk_full', params: null },
      { kind: 'disk_full', params: { failRatio: null } },
    ]) {
      expect(JSON.stringify(rejection(input).toJSON())).toBe(JSON.stringify(rejection(input).toJSON()))
    }
  })
})
