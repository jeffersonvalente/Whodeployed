/**
 * Actions (ADR-012; PRD FASE-2 EN-4, EN-5): validation, cost, scheduling, the fault life cycle and
 * the `restart` primitive.
 *
 * - `validateAction` checks an Action against the world (ADR-012 §2) and returns a frozen copy with
 *   the keys in contract order (kind, target). There is no player level anywhere (Q-1): who may use
 *   which action is decided outside the engine.
 * - `actionCostTable` is the tick cost of each supported action (ADR-012 §3).
 * - `createFaultLifecycle` owns the active faults of a simulation. Generation 0 of each configured
 *   fault is activated exactly as in phase 1, with the stream prefix ('fault', i, kind), so a run
 *   without actions is byte-identical to phase 1 (EN-2). It also provides the mechanism of
 *   ADR-012 §6 that the reaction table uses: ending a fault at a tick (`endTick`), re-activating it
 *   as generation g >= 1 with prefix (...origin, 'gen', g), and inducing a new fault from an action
 *   with prefix ('action', n, kind). No fault module uses 'gen' as its first key (ADR-003 §2).
 * - `actionEffect` is the effect of one action in its effect tick `te = tick + 1`, merged into
 *   step 1 of the orchestrator: its `down` joins the faults' `down`, its events go after the fault
 *   events and before noise (ADR-005 Emenda 3).
 *
 * `restart X`: every instance of X is `down` in `te` (same mechanism as TickEffect.down, ADR-002
 * §5) and one `config` event with `restart: true` and no instance nor note is emitted in `te`.
 * The reaction of the faults of X to the process replacement (ADR-012 §5) and the cache rule are
 * task T2.3; `rollback` (deploy history, batches) is task T2.4: until then a rollback is validated,
 * costs its ticks and changes nothing, which is also its documented effect when the target has no
 * deploy to revert.
 *
 * Pure: no I/O, no clock; randomness only through the seeded RngFactory it is given (D-4).
 */
import { EngineError } from '../errors.js'
import { resolveFaults } from '../faults/resolve.js'
import type {
  Action,
  ActionCostTable,
  EngineErrorCode,
  Fault,
  FaultKind,
  FaultRegistry,
  RngFactory,
  SupportedActionKind,
  TickEffect,
  World,
} from '../types.js'
import type { ActiveFault } from './hooks.js'

/** Every Action kind of SPEC §6, in contract order. */
export const ACTION_KINDS: readonly Action['kind'][] = ['restart', 'rollback', 'flagOff', 'scale', 'escalate', 'declareMitigated']

/** Action kinds with semantics in phase 2 (ADR-012 §2). */
export const SUPPORTED_ACTION_KINDS: readonly SupportedActionKind[] = ['restart', 'rollback']

/** Keys an Action accepts, in contract order. */
const ACTION_KEYS: readonly string[] = ['kind', 'target']

/** Tick cost of each supported action (ADR-012 §3, EN-4). */
export const actionCostTable: ActionCostTable = Object.freeze({ restart: 2, rollback: 3 })

function fail(
  code: EngineErrorCode,
  field: string,
  received: unknown,
  message: string,
  validValues?: readonly (string | number)[],
): never {
  throw new EngineError({ code, field, received, message, ...(validValues !== undefined ? { validValues } : {}) })
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validates `action` against the world (ADR-012 §2) and returns a frozen copy, keys in contract
 * order. Throws EngineError on the first problem, in the order of the ADR table:
 *   invalid_action      not an object; kind outside SPEC §6; key other than kind/target; target
 *                       present and not a string
 *   unsupported_action  flagOff, scale, escalate, declareMitigated
 *   invalid_action      restart/rollback without target
 *   unknown_target      target that is not a component of the world
 * `target: undefined` is the same as an absent key (I24-6, ADR-004 Emenda 1).
 */
export function validateAction(action: unknown, world: Readonly<World>): Action & { kind: SupportedActionKind; target: string } {
  if (!isPlainObject(action)) fail('invalid_action', 'action', action, 'action must be an object')
  const kind = action['kind']
  if (!ACTION_KINDS.includes(kind as Action['kind'])) {
    fail('invalid_action', 'action.kind', kind, 'unknown action kind', ACTION_KINDS)
  }
  for (const key of Object.keys(action)) {
    if (!ACTION_KEYS.includes(key)) fail('invalid_action', `action.${key}`, action[key], 'unknown field for an action', ACTION_KEYS)
  }
  const names = [...world.services, ...world.deps].map((c) => c.name)
  const target: unknown = action['target']
  if (target !== undefined && typeof target !== 'string') {
    fail('invalid_action', 'action.target', target, 'target must be a string', names)
  }
  if (!SUPPORTED_ACTION_KINDS.includes(kind as SupportedActionKind)) {
    fail('unsupported_action', 'action.kind', kind, 'action kind has no semantics in this version', SUPPORTED_ACTION_KINDS)
  }
  if (typeof target !== 'string') fail('invalid_action', 'action.target', target, `a '${String(kind)}' action needs a target`, names)
  if (!names.includes(target)) fail('unknown_target', 'action.target', target, 'unknown component', names)
  return Object.freeze({ kind: kind as SupportedActionKind, target })
}

// ---------------------------------------------------------------------------
// Fault life cycle (ADR-012 §6)
// ---------------------------------------------------------------------------

/** One activation of a fault: a configured fault (generation 0), one of its later generations, or an induced fault. */
export interface FaultEntry {
  /** The fault as activated; `startTick` is this generation's first tick. */
  readonly fault: Fault
  /** Stream prefix of the fault's first generation: ('fault', i, kind) or ('action', n, kind). */
  readonly origin: readonly (string | number)[]
  /** 0 for the first activation of `origin`, g >= 1 for each re-activation. */
  readonly generation: number
  /** The hooks with their gating window; `endTick` is set when the fault is ended. */
  readonly active: ActiveFault
}

export interface FaultLifecycle {
  /** Every activation in creation order (configured faults first): the list hooksActiveAt composes. */
  readonly active: readonly ActiveFault[]
  readonly entries: readonly FaultEntry[]
  /** Entries with `fault.target === target` active in `tick` (startTick <= tick < endTick), in creation order. */
  activeOn(target: string, tick: number): FaultEntry[]
  /** Stops invoking the entry's hooks from `tick` on (exclusive end); keeps an earlier end. */
  end(entry: FaultEntry, tick: number): void
  /** Ends `entry` at `tick` and activates the same fault again with startTick = tick, as the next generation. */
  reset(entry: FaultEntry, tick: number, world: World): FaultEntry
  /** Activates a new fault of `kind` on `target` from `tick`, with the catalog defaults, for action number `action`. */
  induce(kind: FaultKind, target: string, tick: number, action: number, world: World): FaultEntry
}

function prefixed(root: RngFactory, prefix: readonly (string | number)[]): RngFactory {
  return (...key) => root(...prefix, ...key)
}

/**
 * Creates the life cycle of `faults` (already resolved) and activates generation 0 of each, in list
 * order, with the factory ('fault', i, kind) of ADR-003 §2 (same calls as activateFaults).
 */
export function createFaultLifecycle(
  faults: readonly Fault[],
  world: World,
  root: RngFactory,
  registry: FaultRegistry,
): FaultLifecycle {
  const entries: FaultEntry[] = []
  const active: ActiveFault[] = []
  /** Next generation number per origin (keyed by the joined origin, which is unique per origin). */
  const nextGeneration = new Map<string, number>()

  const activate = (fault: Fault, origin: readonly (string | number)[], activationWorld: World): FaultEntry => {
    const originKey = JSON.stringify(origin)
    const generation = nextGeneration.get(originKey) ?? 0
    nextGeneration.set(originKey, generation + 1)
    const prefix = generation === 0 ? origin : [...origin, 'gen', generation]
    const module = registry[fault.kind]
    const hooks = module.activate(fault, activationWorld, prefixed(root, prefix))
    const activeFault: ActiveFault = { startTick: fault.startTick, hooks }
    const entry: FaultEntry = Object.freeze({ fault, origin, generation, active: activeFault })
    entries.push(entry)
    active.push(activeFault)
    return entry
  }

  faults.forEach((fault, index) => activate(fault, ['fault', index, fault.kind], world))

  const isActive = (a: ActiveFault, tick: number): boolean => a.startTick <= tick && (a.endTick === undefined || tick < a.endTick)

  const end = (entry: FaultEntry, tick: number): void => {
    if (entry.active.endTick === undefined || tick < entry.active.endTick) entry.active.endTick = tick
  }

  return {
    active,
    entries,
    activeOn: (target, tick) => entries.filter((e) => e.fault.target === target && isActive(e.active, tick)),
    end,
    reset: (entry, tick, activationWorld) => {
      end(entry, tick)
      return activate(Object.freeze({ ...entry.fault, startTick: tick }), entry.origin, activationWorld)
    },
    induce: (kind, target, tick, action, activationWorld) => {
      const [fault] = resolveFaults([{ kind, target, startTick: tick }], activationWorld)
      return activate(fault as Fault, ['action', action, kind], activationWorld)
    },
  }
}

// ---------------------------------------------------------------------------
// Scheduling and effects
// ---------------------------------------------------------------------------

/** An accepted action waiting for its effect tick. `seq` numbers the accepted actions of a simulation (0, 1, ...). */
export interface ScheduledAction {
  readonly action: Action & { kind: SupportedActionKind; target: string }
  /** world.tick + 1 at the time of act(). */
  readonly effectTick: number
  readonly seq: number
}

export interface ActionEffectContext {
  /** The effect tick `te`. */
  tick: number
  world: World
  lifecycle: FaultLifecycle
}

/** Effect of one action in its effect tick (ADR-012 §4); only `down` and `events` are used. */
export function actionEffect(scheduled: ScheduledAction, ctx: ActionEffectContext): TickEffect {
  const { action } = scheduled
  switch (action.kind) {
    case 'restart': {
      const component = [...ctx.world.services, ...ctx.world.deps].find((c) => c.name === action.target)
      if (component === undefined) throw new Error(`restart: target '${action.target}' is not a component of the world`)
      return {
        down: [...component.instances],
        events: [{ kind: 'config', target: component.name, restart: true }],
      }
    }
    case 'rollback':
      // Deploy history and batches: T2.4. Without a batch to revert a rollback changes nothing (ADR-012 §4).
      return {}
  }
}
