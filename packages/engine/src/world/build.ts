/**
 * buildWorld(system, seed): validates a SystemDefinition and turns it into the World of
 * SPEC §6 (ADR-002 §1, §3). The system is input data (W-3, SPEC §3.7): nothing here names a
 * concrete component.
 *
 * - Instance ids are `${component}-${index}`, index from 0 (W-2, ADR-003 §3): they depend only
 *   on the definition, never on the seed or on any randomness.
 * - The World is a fresh deep copy with a fixed key order, so the same (system, seed) always
 *   produces a structurally identical World (DET) and later mutations of the input never leak.
 * - Any invalid definition throws EngineError('invalid_system') naming the offending field;
 *   an empty or non-string seed throws EngineError('invalid_seed').
 */
import { EngineError } from '../errors.js'
import type {
  CallSpec,
  Dependency,
  DependencyKind,
  DependencySpec,
  IngressSpec,
  InstanceId,
  Service,
  ServiceSpec,
  SystemDefinition,
  World,
} from '../types.js'

export const DEPENDENCY_KINDS: readonly DependencyKind[] = ['database', 'cache', 'queue']

/** Component names must be safe inside instance ids and the CLI `--fault` syntax (ADR-007). */
const COMPONENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** Stable instance ids of a component (W-2). */
export function instanceIds(component: string, replicas: number): InstanceId[] {
  const ids: InstanceId[] = []
  for (let index = 0; index < replicas; index++) ids.push(`${component}-${index}`)
  return ids
}

type Obj = Record<string, unknown>

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(field: string, received: unknown, reason: string, validValues?: readonly (string | number)[]): never {
  throw new EngineError(
    validValues === undefined
      ? { code: 'invalid_system', field, received, message: `${field}: ${reason}` }
      : { code: 'invalid_system', field, received, validValues, message: `${field}: ${reason}` },
  )
}

function objectAt(value: unknown, field: string): Obj {
  if (!isObject(value)) invalid(field, value, 'must be an object')
  return value
}

function arrayAt(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field, value, 'must be an array')
  return value
}

function stringAt(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) invalid(field, value, 'must be a non-empty string')
  return value
}

interface NumberRule {
  min: number
  max?: number
  integer?: boolean
  /** When true, `min` itself is excluded. */
  exclusiveMin?: boolean
}

function numberAt(value: unknown, field: string, rule: NumberRule): number {
  const max = rule.max ?? Number.POSITIVE_INFINITY
  const range = `${rule.exclusiveMin === true ? '>' : '>='} ${rule.min}${Number.isFinite(max) ? ` and <= ${max}` : ''}`
  const kind = rule.integer === true ? 'an integer' : 'a finite number'
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (rule.integer !== true || Number.isInteger(value)) &&
    (rule.exclusiveMin === true ? value > rule.min : value >= rule.min) &&
    value <= max
  if (!ok) invalid(field, value, `must be ${kind} ${range}`)
  return value
}

/** Fields shared by services and dependencies, copied in a fixed key order. */
function baseAt(raw: Obj, field: string) {
  const name = stringAt(raw['name'], `${field}.name`)
  if (!COMPONENT_NAME.test(name)) {
    invalid(`${field}.name`, name, 'must match [A-Za-z0-9][A-Za-z0-9_.-]* (letters, digits, "_", "." and "-")')
  }
  const latencyP50Ms = numberAt(raw['latencyP50Ms'], `${field}.latencyP50Ms`, { min: 0, exclusiveMin: true })
  const latencyP99Ms = numberAt(raw['latencyP99Ms'], `${field}.latencyP99Ms`, { min: 0, exclusiveMin: true })
  if (latencyP99Ms < latencyP50Ms) {
    invalid(`${field}.latencyP99Ms`, latencyP99Ms, `must be >= latencyP50Ms (${latencyP50Ms})`)
  }
  return {
    name,
    replicas: numberAt(raw['replicas'], `${field}.replicas`, { min: 1, integer: true }),
    latencyP50Ms,
    latencyP99Ms,
    cpuBasePct: numberAt(raw['cpuBasePct'], `${field}.cpuBasePct`, { min: 0, max: 100 }),
    cpuPerRequestPct: numberAt(raw['cpuPerRequestPct'], `${field}.cpuPerRequestPct`, { min: 0, max: 100 }),
    memBaseMb: numberAt(raw['memBaseMb'], `${field}.memBaseMb`, { min: 0 }),
  }
}

/** Shape of one component, collected in a first pass so call targets can be checked in a second. */
interface Declared {
  name: string
  field: string
  dependencyKind?: DependencyKind
}

function readDependency(raw: unknown, field: string): DependencySpec {
  const obj = objectAt(raw, field)
  const base = baseAt(obj, field)
  const kind = obj['kind']
  if (typeof kind !== 'string' || !(DEPENDENCY_KINDS as readonly string[]).includes(kind)) {
    invalid(`${field}.kind`, kind, 'unknown dependency kind', DEPENDENCY_KINDS)
  }
  const dep: DependencySpec = {
    ...base,
    kind: kind as DependencyKind,
    maxConnections: numberAt(obj['maxConnections'], `${field}.maxConnections`, { min: 1, integer: true }),
  }
  if (kind === 'cache') {
    dep.cacheHitRatio = numberAt(obj['cacheHitRatio'], `${field}.cacheHitRatio`, { min: 0, max: 1 })
  } else if (obj['cacheHitRatio'] !== undefined) {
    invalid(`${field}.cacheHitRatio`, obj['cacheHitRatio'], `is only allowed on dependencies of kind 'cache'`)
  }
  return dep
}

function readCall(
  raw: unknown,
  field: string,
  caller: string,
  byName: ReadonlyMap<string, Declared>,
  isMiss: boolean,
): CallSpec {
  const obj = objectAt(raw, field)
  const others = [...byName.keys()].filter((name) => name !== caller)
  const target = stringAt(obj['target'], `${field}.target`)
  if (target === caller) invalid(`${field}.target`, target, 'a component cannot call itself', others)
  const targetDecl = byName.get(target)
  if (targetDecl === undefined) invalid(`${field}.target`, target, 'unknown component', others)
  const call: CallSpec = {
    target,
    operation: stringAt(obj['operation'], `${field}.operation`),
    ratio: isMiss ? 1 : numberAt(obj['ratio'], `${field}.ratio`, { min: 0, max: 1 }),
    timeoutMs: numberAt(obj['timeoutMs'], `${field}.timeoutMs`, { min: 1, integer: true }),
    retries: numberAt(obj['retries'], `${field}.retries`, { min: 0, integer: true }),
  }
  if (isMiss) {
    if (obj['onMiss'] !== undefined) invalid(`${field}.onMiss`, obj['onMiss'], 'onMiss cannot be nested')
    return call
  }
  if (obj['onMiss'] !== undefined) {
    if (targetDecl.dependencyKind !== 'cache') {
      const caches = [...byName.values()].filter((d) => d.dependencyKind === 'cache').map((d) => d.name)
      invalid(`${field}.onMiss`, obj['onMiss'], `onMiss is only allowed on calls to a cache ('${target}' is not one)`, caches)
    }
    const miss = readCall(obj['onMiss'], `${field}.onMiss`, caller, byName, true)
    if (miss.target === target) invalid(`${field}.onMiss.target`, miss.target, 'onMiss cannot call the same cache')
    call.onMiss = { target: miss.target, operation: miss.operation, timeoutMs: miss.timeoutMs, retries: miss.retries }
  }
  return call
}

function readIngress(raw: unknown, field: string): IngressSpec {
  const obj = objectAt(raw, field)
  return {
    ratePerTick: numberAt(obj['ratePerTick'], `${field}.ratePerTick`, { min: 0, integer: true }),
    operation: stringAt(obj['operation'], `${field}.operation`),
  }
}

function readService(raw: Obj, field: string, byName: ReadonlyMap<string, Declared>): ServiceSpec {
  const base = baseAt(raw, field)
  const ingress = raw['ingress'] === undefined ? undefined : readIngress(raw['ingress'], `${field}.ingress`)
  const calls = arrayAt(raw['calls'], `${field}.calls`).map((call, k) =>
    readCall(call, `${field}.calls[${k}]`, base.name, byName, false),
  )
  const dbPoolSize = numberAt(raw['dbPoolSize'], `${field}.dbPoolSize`, { min: 1, integer: true })
  // Built in one literal so the key order is fixed (ingress before calls), whatever the input.
  return ingress === undefined ? { ...base, calls, dbPoolSize } : { ...base, ingress, calls, dbPoolSize }
}

/** Rejects call cycles between services (including onMiss): traffic would never terminate. */
function assertAcyclic(services: readonly ServiceSpec[], field: (index: number) => string): void {
  const index = new Map(services.map((s, i) => [s.name, i]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (name: string, path: string[]): void => {
    state.set(name, 'visiting')
    const i = index.get(name) as number
    const service = services[i] as ServiceSpec
    service.calls.forEach((call, k) => {
      const targets = call.onMiss === undefined ? [call.target] : [call.target, call.onMiss.target]
      for (const target of targets) {
        if (!index.has(target)) continue
        const seen = state.get(target)
        if (seen === 'visiting') {
          const cycle = [...path.slice(path.indexOf(target)), name, target].join(' -> ')
          invalid(`${field(i)}.calls[${k}]`, target, `call cycle between services: ${cycle}`)
        }
        if (seen === undefined) visit(target, [...path, name])
      }
    })
    state.set(name, 'done')
  }
  for (const service of services) if (!state.has(service.name)) visit(service.name, [])
}

/**
 * Validates `system` and returns a normalized deep copy (fixed key order, unknown keys dropped).
 * Accepts `unknown` because systems will also come from YAML (SPEC §3.7).
 */
export function validateSystem(system: unknown): SystemDefinition {
  const root = objectAt(system, 'system')
  const name = stringAt(root['name'], 'system.name')
  const rawServices = arrayAt(root['services'], 'system.services')
  const rawDeps = arrayAt(root['deps'], 'system.deps')
  if (rawServices.length === 0) invalid('system.services', rawServices, 'must declare at least one service')

  // Pass 1: names, uniqueness and dependency kinds.
  const deps = rawDeps.map((raw, j) => readDependency(raw, `system.deps[${j}]`))
  const byName = new Map<string, Declared>()
  const declare = (decl: Declared) => {
    const previous = byName.get(decl.name)
    if (previous !== undefined) {
      invalid(`${decl.field}.name`, decl.name, `duplicate component name (already used by ${previous.field})`)
    }
    byName.set(decl.name, decl)
  }
  rawServices.forEach((raw, i) => {
    const field = `system.services[${i}]`
    declare({ name: stringAt(objectAt(raw, field)['name'], `${field}.name`), field })
  })
  deps.forEach((dep, j) => declare({ name: dep.name, field: `system.deps[${j}]`, dependencyKind: dep.kind }))

  // Pass 2: services and their calls (targets resolved against every declared component).
  const services = rawServices.map((raw, i) => readService(raw as Obj, `system.services[${i}]`, byName))
  assertAcyclic(services, (i) => `system.services[${i}]`)

  return { name, services, deps }
}

/** Builds the World of SPEC §6 at tick 0. Throws EngineError on an invalid system or seed. */
export function buildWorld(system: SystemDefinition, seed: string): World {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new EngineError({ code: 'invalid_seed', field: 'seed', received: seed, message: 'seed must be a non-empty string' })
  }
  const valid = validateSystem(system)
  const services: Service[] = valid.services.map((s) => ({ ...s, instances: instanceIds(s.name, s.replicas) }))
  const deps: Dependency[] = valid.deps.map((d) => ({ ...d, instances: instanceIds(d.name, d.replicas) }))
  return { services, deps, tick: 0, seed }
}
