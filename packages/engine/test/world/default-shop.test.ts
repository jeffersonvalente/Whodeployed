/**
 * default-shop (T1.3): W-1 (exact component sets), W-2 (>= 3 instances per service, stable ids)
 * and every number of ADR-002 §6, re-typed here independently of src/world/default-shop.ts.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type { CallSpec } from '../../src/types.js'

const SERVICES = ['gateway', 'auth', 'catalog', 'cart', 'payment', 'orders-worker']
const DEPS = ['postgres', 'redis', 'queue']

/** ADR-002 §6, services: [ingress, p50, p99, cpuBase, cpuPerReq, mem, calls]. */
type Call = [string, string, number, number, number, [string, string, number, number]?]
const ADR_SERVICES: Record<string, [[number, string] | null, number, number, number, number, number, Call[]]> = {
  gateway: [[12, 'http.request'], 5, 20, 4, 0.8, 256, [
    ['auth', 'auth.verify', 1.0, 800, 1],
    ['catalog', 'catalog.list', 0.6, 1000, 1],
    ['cart', 'cart.get', 0.3, 1000, 1],
    ['payment', 'payment.checkout', 0.1, 5000, 0],
  ]],
  auth: [null, 8, 30, 3, 0.5, 192, [['redis', 'session.get', 1.0, 100, 1, ['postgres', 'db.query', 500, 1]]]],
  catalog: [null, 15, 60, 5, 1.0, 384, [['redis', 'cache.get', 1.0, 100, 1, ['postgres', 'db.query', 800, 1]]]],
  cart: [null, 10, 40, 3, 0.6, 256, [['redis', 'cart.get', 1.0, 100, 1, ['postgres', 'db.query', 500, 1]]]],
  payment: [null, 40, 150, 6, 2.0, 320, [
    ['postgres', 'db.insert', 1.0, 2000, 1],
    ['queue', 'queue.publish', 1.0, 500, 1],
  ]],
  'orders-worker': [[2, 'queue.consume'], 20, 80, 4, 1.5, 256, [['postgres', 'db.update', 1.0, 1000, 2]]],
}

/** ADR-002 §6, dependencies: [kind, p50, p99, cpuBase, cpuPerReq, mem, maxConnections, cacheHitRatio?]. */
const ADR_DEPS: Record<string, [string, number, number, number, number, number, number, number?]> = {
  postgres: ['database', 4, 25, 10, 0.3, 2048, 200],
  redis: ['cache', 1, 4, 2, 0.05, 512, 1000, 0.9],
  queue: ['queue', 2, 8, 3, 0.1, 256, 500],
}

const toCall = ([target, operation, ratio, timeoutMs, retries, miss]: Call): CallSpec => ({
  target,
  operation,
  ratio,
  timeoutMs,
  retries,
  ...(miss === undefined ? {} : { onMiss: { target: miss[0], operation: miss[1], timeoutMs: miss[2], retries: miss[3] } }),
})

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('default-shop system (W-1, ADR-002 §6)', () => {
  const world = buildWorld(defaultShop, 'w1')

  it('W-1: has exactly the 6 services and 3 dependencies of SPEC §4', () => {
    expect(defaultShop.name).toBe('default-shop')
    expect(world.services.map((s) => s.name)).toEqual(SERVICES)
    expect(world.deps.map((d) => d.name)).toEqual(DEPS)
  })

  it.each(SERVICES)('service %s matches ADR-002 §6', (name) => {
    const s = world.services.find((x) => x.name === name)
    const [ingress, p50, p99, cpuBase, cpuPerReq, mem, calls] = ADR_SERVICES[name]!
    expect(s).toBeDefined()
    expect(s).toStrictEqual({
      name,
      replicas: 3,
      latencyP50Ms: p50,
      latencyP99Ms: p99,
      cpuBasePct: cpuBase,
      cpuPerRequestPct: cpuPerReq,
      memBaseMb: mem,
      ...(ingress === null ? {} : { ingress: { ratePerTick: ingress[0], operation: ingress[1] } }),
      calls: calls.map(toCall),
      dbPoolSize: 20,
      instances: [`${name}-0`, `${name}-1`, `${name}-2`],
    })
  })

  it.each(DEPS)('dependency %s matches ADR-002 §6', (name) => {
    const d = world.deps.find((x) => x.name === name)
    const [kind, p50, p99, cpuBase, cpuPerReq, mem, maxConnections, hit] = ADR_DEPS[name]!
    expect(d).toStrictEqual({
      name,
      replicas: 1,
      latencyP50Ms: p50,
      latencyP99Ms: p99,
      cpuBasePct: cpuBase,
      cpuPerRequestPct: cpuPerReq,
      memBaseMb: mem,
      kind,
      maxConnections,
      ...(hit === undefined ? {} : { cacheHitRatio: hit }),
      instances: [`${name}-0`],
    })
  })

  it('is deeply frozen, so no test or caller can alter it for another', () => {
    expect(Object.isFrozen(defaultShop)).toBe(true)
    expect(Object.isFrozen(defaultShop.services[0]?.calls[0])).toBe(true)
    expect(() => {
      ;(defaultShop.services as unknown[]).push({})
    }).toThrow(TypeError)
  })
})

describe('default-shop instances (W-2)', () => {
  it('every service has >= 3 instances named `${component}-${index}`', () => {
    const world = buildWorld(defaultShop, 'w2')
    for (const s of world.services) {
      expect(s.instances.length, s.name).toBeGreaterThanOrEqual(3)
      expect(s.instances).toEqual(s.instances.map((_, i) => `${s.name}-${i}`))
    }
  })

  it('instance ids are identical in two constructions with the same seed, and independent of the seed', () => {
    const ids = (seed: string) => buildWorld(defaultShop, seed).services.flatMap((s) => s.instances)
    expect(ids('stable')).toEqual(ids('stable'))
    expect(ids('stable')).toEqual(ids('another-seed'))
  })
})

describe('determinism (DET)', () => {
  it('two constructions with the same seed are toStrictEqual and hash-identical', () => {
    const a = buildWorld(defaultShop, 'det-seed')
    const b = buildWorld(defaultShop, 'det-seed')
    expect(a).toStrictEqual(b)
    expect(a).not.toBe(b)
    expect(sha256(a)).toBe(sha256(b))
    expect(a.tick).toBe(0)
    expect(a.seed).toBe('det-seed')
  })

  it('pins the serialized default-shop world (golden hash)', () => {
    // Any change to the ADR-002 §6 numbers or to the World key order changes this hash.
    expect(sha256(buildWorld(defaultShop, 'golden'))).toMatchInlineSnapshot(`"7afa15c772add96cba84c6552412ce4989ae8576377c6b66abbcd92efdb50955"`)
  })
})
