/**
 * The `default-shop` system (SPEC §4, W-1, W-2): 6 services + 3 dependencies of a small online
 * shop. Pure data, transcribed from the tables of ADR-002 §6; the simulation logic never names
 * any of these components (W-3). Numbers are fixed for phase 1: changing them is an amendment
 * of ADR-002 by the Architect, and no task edits this file after T1.3.
 */
import type { DependencySpec, ServiceSpec, SystemDefinition } from '../types.js'

/** Every default-shop service has 3 replicas and a pool of 20 connections per database (ADR-002 §6). */
const SERVICE_REPLICAS = 3
const DB_POOL_SIZE = 20
/** Dependencies run as a single instance (ADR-002 §6). */
const DEPENDENCY_REPLICAS = 1

const services: ServiceSpec[] = [
  {
    name: 'gateway',
    replicas: SERVICE_REPLICAS,
    latencyP50Ms: 5,
    latencyP99Ms: 20,
    cpuBasePct: 4,
    cpuPerRequestPct: 0.8,
    memBaseMb: 256,
    ingress: { ratePerTick: 12, operation: 'http.request' },
    calls: [
      { target: 'auth', operation: 'auth.verify', ratio: 1.0, timeoutMs: 800, retries: 1 },
      { target: 'catalog', operation: 'catalog.list', ratio: 0.6, timeoutMs: 1000, retries: 1 },
      { target: 'cart', operation: 'cart.get', ratio: 0.3, timeoutMs: 1000, retries: 1 },
      { target: 'payment', operation: 'payment.checkout', ratio: 0.1, timeoutMs: 5000, retries: 0 },
    ],
    dbPoolSize: DB_POOL_SIZE,
  },
  {
    name: 'auth',
    replicas: SERVICE_REPLICAS,
    latencyP50Ms: 8,
    latencyP99Ms: 30,
    cpuBasePct: 3,
    cpuPerRequestPct: 0.5,
    memBaseMb: 192,
    calls: [
      {
        target: 'redis',
        operation: 'session.get',
        ratio: 1.0,
        timeoutMs: 100,
        retries: 1,
        onMiss: { target: 'postgres', operation: 'db.query', timeoutMs: 500, retries: 1 },
      },
    ],
    dbPoolSize: DB_POOL_SIZE,
  },
  {
    name: 'catalog',
    replicas: SERVICE_REPLICAS,
    latencyP50Ms: 15,
    latencyP99Ms: 60,
    cpuBasePct: 5,
    cpuPerRequestPct: 1.0,
    memBaseMb: 384,
    calls: [
      {
        target: 'redis',
        operation: 'cache.get',
        ratio: 1.0,
        timeoutMs: 100,
        retries: 1,
        onMiss: { target: 'postgres', operation: 'db.query', timeoutMs: 800, retries: 1 },
      },
    ],
    dbPoolSize: DB_POOL_SIZE,
  },
  {
    name: 'cart',
    replicas: SERVICE_REPLICAS,
    latencyP50Ms: 10,
    latencyP99Ms: 40,
    cpuBasePct: 3,
    cpuPerRequestPct: 0.6,
    memBaseMb: 256,
    calls: [
      {
        target: 'redis',
        operation: 'cart.get',
        ratio: 1.0,
        timeoutMs: 100,
        retries: 1,
        onMiss: { target: 'postgres', operation: 'db.query', timeoutMs: 500, retries: 1 },
      },
    ],
    dbPoolSize: DB_POOL_SIZE,
  },
  {
    name: 'payment',
    replicas: SERVICE_REPLICAS,
    latencyP50Ms: 40,
    latencyP99Ms: 150,
    cpuBasePct: 6,
    cpuPerRequestPct: 2.0,
    memBaseMb: 320,
    calls: [
      { target: 'postgres', operation: 'db.insert', ratio: 1.0, timeoutMs: 2000, retries: 1 },
      { target: 'queue', operation: 'queue.publish', ratio: 1.0, timeoutMs: 500, retries: 1 },
    ],
    dbPoolSize: DB_POOL_SIZE,
  },
  {
    name: 'orders-worker',
    replicas: SERVICE_REPLICAS,
    latencyP50Ms: 20,
    latencyP99Ms: 80,
    cpuBasePct: 4,
    cpuPerRequestPct: 1.5,
    memBaseMb: 256,
    ingress: { ratePerTick: 2, operation: 'queue.consume' },
    calls: [{ target: 'postgres', operation: 'db.update', ratio: 1.0, timeoutMs: 1000, retries: 2 }],
    dbPoolSize: DB_POOL_SIZE,
  },
]

const deps: DependencySpec[] = [
  {
    name: 'postgres',
    kind: 'database',
    replicas: DEPENDENCY_REPLICAS,
    latencyP50Ms: 4,
    latencyP99Ms: 25,
    cpuBasePct: 10,
    cpuPerRequestPct: 0.3,
    memBaseMb: 2048,
    maxConnections: 200,
  },
  {
    name: 'redis',
    kind: 'cache',
    replicas: DEPENDENCY_REPLICAS,
    latencyP50Ms: 1,
    latencyP99Ms: 4,
    cpuBasePct: 2,
    cpuPerRequestPct: 0.05,
    memBaseMb: 512,
    maxConnections: 1000,
    cacheHitRatio: 0.9,
  },
  {
    name: 'queue',
    kind: 'queue',
    replicas: DEPENDENCY_REPLICAS,
    latencyP50Ms: 2,
    latencyP99Ms: 8,
    cpuBasePct: 3,
    cpuPerRequestPct: 0.1,
    memBaseMb: 256,
    maxConnections: 500,
  },
]

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** The default system, deeply frozen: buildWorld copies it, so no caller can alter it for another. */
export const defaultShop: SystemDefinition = deepFreeze({ name: 'default-shop', services, deps })
