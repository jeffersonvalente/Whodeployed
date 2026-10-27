/**
 * Orchestrator: createSimulation / advance / simulate (ADR-002 §3, ADR-003, ADR-005).
 *
 * The engine is a pure function of (system, seed, faults, noise) -> telemetry: no I/O, no clock,
 * every random draw comes from the RngFactory of `config.seed` (SPEC §3.3, §3.6).
 *
 * Per tick `t`, in this order (ADR-002 §3):
 *   1. onTick of the faults active in `t` (startTick-gated, F-2) -> down set, fault events, fault logs;
 *   2. noise events with tick = t (S-4: noise only ever produces EventRecords);
 *   3. generateTraffic with the root factory and the composed hooks;
 *   4. onResources for every instance, in world order;
 *   5. deriveMetrics;
 *   6. generateLogs (fault logs first, then request logs);
 *   7. records in canonical order (ADR-005): events (fault, then noise), spans, logs, metrics;
 *      then store.appendTick.
 *
 * Nothing here names a concrete component: the system is input data (W-3). Records are never
 * mutated after they are appended to the store (the store hands out the same objects).
 */
import { EngineError } from '../errors.js'
import { faultRegistry } from '../faults/registry.js'
import { resolveFaults } from '../faults/resolve.js'
import { ask, type AskEnvironment } from '../questions/ask.js'
import type {
  ChangeKind,
  CreateSimulation,
  EventRecord,
  Fault,
  FaultRegistry,
  InstanceId,
  NoiseEvent,
  ResourceEffect,
  Simulate,
  Simulation,
  SimulationConfig,
  TelemetryRecord,
  TelemetryView,
  TickEffect,
  World,
} from '../types.js'
import { buildWorld, validateSystem } from '../world/build.js'
import { activateFaults, hooksActiveAt } from './hooks.js'
import { deriveMetrics } from './metrics.js'
import { generateLogs } from './logs.js'
import { createRngFactory } from './rng.js'
import { createTelemetryStore } from './store.js'
import { generateTraffic } from './traffic.js'

const CHANGE_KINDS: readonly ChangeKind[] = ['deploy', 'config']

/** Largest tick count accepted by advance/simulate in one call (same bound as the CLI, ADR-007). */
export const MAX_TICKS = 100_000

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function invalidNoise(field: string, received: unknown, message: string, validValues?: readonly (string | number)[]): never {
  throw new EngineError({ code: 'invalid_noise', field, received, message, ...(validValues ? { validValues } : {}) })
}

/** Validates noise against the world and returns normalized copies (key order of NoiseEvent). */
export function validateNoise(noise: unknown, world: World): NoiseEvent[] {
  if (noise === undefined) return []
  if (!Array.isArray(noise)) invalidNoise('noise', noise, 'must be an array of noise events')
  const components = [...world.services, ...world.deps]
  const names = components.map((c) => c.name)
  return noise.map((raw: unknown, i): NoiseEvent => {
    const field = `noise[${i}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) invalidNoise(field, raw, 'must be an object')
    const n = raw as Record<string, unknown>
    if (!CHANGE_KINDS.includes(n['kind'] as ChangeKind)) invalidNoise(`${field}.kind`, n['kind'], 'unknown change kind', CHANGE_KINDS)
    const component = components.find((c) => c.name === n['target'])
    if (component === undefined) invalidNoise(`${field}.target`, n['target'], 'unknown component', names)
    const tick = n['tick']
    if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) {
      invalidNoise(`${field}.tick`, tick, 'must be an integer >= 0')
    }
    const event: NoiseEvent = { kind: n['kind'] as ChangeKind, target: component.name, tick }
    if (n['instance'] !== undefined) {
      if (!component.instances.includes(n['instance'] as InstanceId)) {
        invalidNoise(`${field}.instance`, n['instance'], `not an instance of '${component.name}'`, component.instances)
      }
      event.instance = n['instance'] as InstanceId
    }
    if (n['note'] !== undefined) {
      if (typeof n['note'] !== 'string') invalidNoise(`${field}.note`, n['note'], 'must be a string')
      event.note = n['note']
    }
    return event
  })
}

function assertTicks(ticks: unknown, min: number): asserts ticks is number {
  if (typeof ticks !== 'number' || !Number.isInteger(ticks) || ticks < min || ticks > MAX_TICKS) {
    throw new EngineError({
      code: 'invalid_ticks',
      field: 'ticks',
      received: ticks,
      validValues: [`${min}..${MAX_TICKS}`],
      message: `ticks must be an integer in ${min}..${MAX_TICKS}`,
    })
  }
}

/** EventRecord in ADR-005 key order: type, tick, kind, target, instance?, restart?, note?. */
function eventRecord(tick: number, e: Omit<EventRecord, 'type' | 'tick'>): EventRecord {
  const record: EventRecord = { type: 'event', tick, kind: e.kind, target: e.target }
  if (e.instance !== undefined) record.instance = e.instance
  if (e.restart === true) record.restart = true
  if (e.note !== undefined) record.note = e.note
  return record
}

export interface SimulationOptions {
  /** Fault modules by kind; defaults to the engine's registry. Tests inject fake modules here. */
  registry?: FaultRegistry
}

/** createSimulation with injectable internals (not part of the public API). */
export function createSimulationWith(config: SimulationConfig, options: SimulationOptions = {}): Simulation {
  if (typeof config !== 'object' || config === null) {
    throw new EngineError({ code: 'invalid_system', field: 'config', received: config, message: 'config must be an object' })
  }
  const built = buildWorld(config.system, config.seed)
  const services = deepFreeze(built.services)
  const deps = deepFreeze(built.deps)
  const seed = built.seed
  const snapshotAt = (tick: number): World => Object.freeze({ services, deps, tick, seed })

  if (config.faults !== undefined && !Array.isArray(config.faults)) {
    throw new EngineError({ code: 'invalid_system', field: 'faults', received: config.faults, message: 'faults must be an array' })
  }
  // Faults are documented as already resolved; re-resolving validates them (F-7) and is a no-op
  // for valid input.
  const faults: readonly Fault[] = deepFreeze(resolveFaults(config.faults ?? [], snapshotAt(0)))
  const noise: readonly NoiseEvent[] = deepFreeze(validateNoise(config.noise, snapshotAt(0)))
  // Own normalized copy of the system: a caller mutating its input later cannot change this run
  // nor its lastWeek comparison (ADR-003 §4).
  const system = deepFreeze(validateSystem(config.system))
  const frozenConfig: SimulationConfig = Object.freeze({ system, seed, faults, noise })

  const rng = createRngFactory(seed)
  const active = activateFaults(faults, snapshotAt(0), rng, options.registry ?? faultRegistry)
  const instances = [...services, ...deps].flatMap((c) => c.instances.map((instance) => ({ component: c.name, instance })))

  let world = snapshotAt(0)
  const store = createTelemetryStore(world)
  const view: TelemetryView = {
    get world() {
      return world
    },
    get now() {
      return store.now
    },
    metricsOf: (component, from, to) => store.metricsOf(component, from, to),
    logsOf: (component, from, to) => store.logsOf(component, from, to),
    spansOf: (component, tick) => store.spansOf(component, tick),
    traceOf: (traceId) => store.traceOf(traceId),
    eventsIn: (from, to) => store.eventsIn(from, to),
    all: () => store.all(),
  }
  // One environment per Simulation, passed on every ask() call (T1.16 memoizes lastWeek on it).
  // createLastWeek is injected so questions/ask.ts does not import this module (ADR-002 Emenda 2 §2.4).
  const env: AskEnvironment = Object.freeze({ view, config: frozenConfig, createLastWeek: createSimulation })

  const step = (tick: number): TelemetryRecord[] => {
    const tickWorld = snapshotAt(tick)
    const hooks = hooksActiveAt(active, tick)

    // 1. Fault tick effects.
    const effect: TickEffect = hooks.onTick?.({ tick, world: tickWorld }) ?? {}
    const down = new Set<InstanceId>(effect.down ?? [])

    // 2. Events: fault events in fault order, then noise in input order.
    const events: EventRecord[] = (effect.events ?? []).map((e) => eventRecord(tick, e))
    for (const n of noise) if (n.tick === tick) events.push(eventRecord(tick, n))

    // 3. Traffic.
    const { spans, errors } = generateTraffic({ world: tickWorld, tick, rng, down, hooks })

    // 4. Resource effects per instance, in world order.
    const resourceEffects = new Map<InstanceId, ResourceEffect>()
    if (hooks.onResources !== undefined) {
      for (const { component, instance } of instances) {
        const r = hooks.onResources({ tick, component, instance })
        if (r !== undefined) resourceEffects.set(instance, r)
      }
    }

    // 5–6. Metrics and logs derived from the spans of this tick.
    const metrics = deriveMetrics({ world: tickWorld, tick, spans, down, resourceEffects, rng })
    const logs = generateLogs({ world: tickWorld, tick, spans, errors, faultLogs: effect.logs ?? [], rng })

    // 7. Canonical order (ADR-005).
    const records: TelemetryRecord[] = [...events, ...spans, ...logs, ...metrics]
    store.appendTick(tick, records)
    world = tickWorld
    return records
  }

  step(0)

  return {
    get world() {
      return world
    },
    advance(ticks = 1) {
      assertTicks(ticks, 0)
      const out: TelemetryRecord[] = []
      const first = world.tick + 1
      for (let t = first; t < first + ticks; t++) {
        for (const record of step(t)) out.push(record)
      }
      return out
    },
    ask: (question) => ask(question, env),
    // Interface stub (ADR-012): the body is task T2.2 (docs/prd/FASE-2.tasks.md).
    act: () => {
      throw new Error('Simulation.act: not implemented yet (T2.2)')
    },
    telemetry: () => view,
  }
}

/** Creates the simulation and simulates tick 0 (ADR-002 §3). Throws EngineError on invalid config. */
export const createSimulation: CreateSimulation = (config) => createSimulationWith(config)

/** Records of ticks [0, ticks) in canonical order. */
export const simulate: Simulate = (config, ticks) => {
  assertTicks(ticks, 1)
  const sim = createSimulation(config)
  sim.advance(ticks - 1)
  return [...sim.telemetry().all()]
}
