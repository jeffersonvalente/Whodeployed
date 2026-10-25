/**
 * resolveFaults (ADR-004, F-7, CLI-2): turns unvalidated FaultInputs (CLI `--fault`, later
 * scenario YAML) into fully resolved Faults.
 *
 * - Missing target, startTick and params take the catalog defaults (ADR-004); every documented
 *   param is present in the result, in catalog order, whatever the input order (DET).
 * - Anything invalid throws EngineError naming the field (`faults[i].kind`, `faults[i].target`,
 *   `faults[i].startTick`, `faults[i].params.<name>`) and listing the valid values.
 * - Target rules: the catalog `targetRule` plus the extra conditions of ADR-004 (a pool fault
 *   needs a service that calls a database, a bad deploy needs >= 2 instances, a slow dependency
 *   needs callers). `affectedInstances.max` is capped at the target's replicas - 1.
 *
 * Pure: reads only the catalog and the given World; never consumes randomness.
 */
import { EngineError } from '../errors.js'
import type {
  Dependency,
  Fault,
  FaultCatalogEntry,
  FaultInput,
  FaultKind,
  FaultParamSpec,
  ResolveFaults,
  Service,
  World,
} from '../types.js'
import { faultCatalog, faultKinds } from './catalog.js'

type Component = { kind: 'service'; spec: Service } | { kind: 'dependency'; spec: Dependency }

function componentsOf(world: World): Component[] {
  return [
    ...world.services.map((spec): Component => ({ kind: 'service', spec })),
    ...world.deps.map((spec): Component => ({ kind: 'dependency', spec })),
  ]
}

/** Every component name that some service calls, directly or on a cache miss. */
function calledNames(world: World): Set<string> {
  const called = new Set<string>()
  for (const service of world.services) {
    for (const call of service.calls) {
      called.add(call.target)
      if (call.onMiss !== undefined) called.add(call.onMiss.target)
    }
  }
  return called
}

/** Human-readable statement of what a kind may target, for error messages. */
function targetRequirement(kind: FaultKind): string {
  switch (kind) {
    case 'connection_pool_exhaustion':
      return 'a service that calls a database'
    case 'bad_deploy':
      return 'a service with at least 2 instances'
    case 'slow_dependency':
      return 'a component that has callers'
    default: {
      const rule = faultCatalog[kind].targetRule
      return rule === 'service' || rule === 'dependency' ? `a ${rule}` : `a dependency of kind '${rule}'`
    }
  }
}

/** Whether `c` is an acceptable target for `kind` in `world` (catalog rule + ADR-004 extras). */
function accepts(kind: FaultKind, c: Component, world: World, called: ReadonlySet<string>): boolean {
  const rule = faultCatalog[kind].targetRule
  const ruleOk =
    rule === 'any' ||
    (rule === 'service' && c.kind === 'service') ||
    (rule === 'dependency' && c.kind === 'dependency') ||
    (c.kind === 'dependency' && c.spec.kind === rule)
  if (!ruleOk) return false
  switch (kind) {
    case 'connection_pool_exhaustion': {
      if (c.kind !== 'service') return false
      const databases = new Set(world.deps.filter((d) => d.kind === 'database').map((d) => d.name))
      return c.spec.calls.some(
        (call) => databases.has(call.target) || (call.onMiss !== undefined && databases.has(call.onMiss.target)),
      )
    }
    case 'bad_deploy':
      return c.spec.replicas >= 2
    case 'slow_dependency':
      return called.has(c.spec.name)
    default:
      return true
  }
}

/** Param spec with the target-dependent limits applied (ADR-004: affectedInstances <= replicas - 1). */
function effectiveSpec(kind: FaultKind, name: string, spec: FaultParamSpec, target: Component): FaultParamSpec {
  if (kind === 'bad_deploy' && name === 'affectedInstances') {
    return { ...spec, max: Math.min(spec.max, target.spec.replicas - 1) }
  }
  return spec
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function resolveOne(input: unknown, i: number, world: World, components: readonly Component[], called: ReadonlySet<string>): Fault {
  const at = `faults[${i}]`
  if (!isObject(input)) {
    throw new EngineError({
      code: 'unknown_fault_kind',
      field: `${at}.kind`,
      received: input,
      validValues: faultKinds,
      message: `${at} must be an object with a 'kind'`,
    })
  }

  const rawKind = input['kind']
  if (typeof rawKind !== 'string' || !(faultKinds as readonly string[]).includes(rawKind)) {
    throw new EngineError({
      code: 'unknown_fault_kind',
      field: `${at}.kind`,
      received: rawKind,
      validValues: faultKinds,
      message: `${at}.kind: unknown fault kind`,
    })
  }
  const kind = rawKind as FaultKind
  const entry: FaultCatalogEntry = faultCatalog[kind]

  // Target: default from the catalog, must exist, must satisfy the kind's rule.
  const target = input['target'] ?? entry.defaultTarget
  const names = components.map((c) => c.spec.name)
  const component = typeof target === 'string' ? components.find((c) => c.spec.name === target) : undefined
  if (component === undefined) {
    throw new EngineError({
      code: 'unknown_target',
      field: `${at}.target`,
      received: target,
      validValues: names,
      message: `${at}.target: no component named ${JSON.stringify(target)} in the world`,
    })
  }
  if (!accepts(kind, component, world, called)) {
    throw new EngineError({
      code: 'invalid_target',
      field: `${at}.target`,
      received: target,
      validValues: components.filter((c) => accepts(kind, c, world, called)).map((c) => c.spec.name),
      message: `${at}.target: '${component.spec.name}' cannot be targeted by ${kind}, which needs ${targetRequirement(kind)}`,
    })
  }

  // startTick: integer >= 0.
  const startTick = input['startTick'] ?? entry.defaultStartTick
  if (typeof startTick !== 'number' || !Number.isInteger(startTick) || startTick < 0) {
    throw new EngineError({
      code: 'invalid_start_tick',
      field: `${at}.startTick`,
      received: startTick,
      validValues: ['integer >= 0'],
      message: `${at}.startTick must be an integer >= 0`,
    })
  }

  // Params: no unknown names; every value a number inside its (effective) range.
  const rawParams = input['params'] ?? {}
  const paramNames = Object.keys(entry.params)
  if (!isObject(rawParams)) {
    throw new EngineError({
      code: 'unknown_param',
      field: `${at}.params`,
      received: rawParams,
      validValues: paramNames,
      message: `${at}.params must be an object of numbers keyed by parameter name`,
    })
  }
  for (const name of Object.keys(rawParams)) {
    if (!Object.hasOwn(entry.params, name)) {
      throw new EngineError({
        code: 'unknown_param',
        field: `${at}.params.${name}`,
        received: name,
        validValues: paramNames,
        message: `${at}.params.${name}: unknown parameter for ${kind}`,
      })
    }
  }
  const params: Record<string, number> = {}
  for (const name of paramNames) {
    const spec = effectiveSpec(kind, name, entry.params[name] as FaultParamSpec, component)
    const value = rawParams[name] ?? spec.default
    const field = `${at}.params.${name}`
    const range = `${spec.min}..${spec.max}`
    const ok =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= spec.min &&
      value <= spec.max &&
      (!spec.integer || Number.isInteger(value))
    if (!ok) {
      const what = spec.integer ? 'an integer' : 'a number'
      const limit = spec.max === entry.params[name]?.max ? '' : ` (limited by '${component.spec.name}' replicas - 1)`
      throw new EngineError({
        code: 'param_out_of_range',
        field,
        received: value,
        validValues: [range],
        message: `${field} must be ${what} in ${range} ${spec.unit}${limit}`,
      })
    }
    params[name] = value
  }

  return { kind, target: component.spec.name, startTick, params }
}

/**
 * Resolves every input in order (F-6: several faults, even of the same kind, are allowed).
 * Throws EngineError on the first invalid input.
 */
export const resolveFaults: ResolveFaults = (inputs, world) => {
  const components = componentsOf(world)
  const called = calledNames(world)
  return inputs.map((input: FaultInput, i) => resolveOne(input, i, world, components, called))
}
