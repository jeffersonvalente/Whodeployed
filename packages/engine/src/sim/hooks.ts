/**
 * Composition and gating of FaultHooks (ADR-002 §3 "Gating", §4; ADR-003 §2; ADR-012 §6).
 *
 * Gating (F-2): a fault's hooks are only part of the composition of tick `t` when
 * `startTick <= t < endTick` (`endTick` is undefined unless an action ended the fault, ADR-012 §6,
 * so without actions the window is `t >= startTick`, as in phase 1). Before that the fault is not called at all, so it can neither change
 * telemetry nor consume randomness; together with the per-key streams of ADR-003 this keeps every
 * record before `startTick` byte-identical to the baseline.
 *
 * Composition of several active faults, in fault-list order (F-6, ADR-002 §4):
 *
 *   onTick       down = union (first-occurrence order); events and logs concatenated
 *   onServe      addLatencyMs summed; fail = the first fault's that fails
 *   onCall       waitMs summed, waitOperation = the first one defined; forceCacheMiss = OR;
 *                fail = the first fault's that fails
 *   onResources  cpuPctAdd, memMbAdd, connectionsAdd summed; connectionsCap = minimum
 *
 * Every active fault's hook is always invoked, even when an earlier fault already decided the
 * outcome (e.g. failed the request): what a fault does with its own random streams never depends
 * on which other faults are active. A composed hook is only present when at least one active
 * fault defines it, so a tick without faults runs the traffic generator with no hooks at all.
 * Fields absent from every partial effect stay absent in the merged effect.
 */
import type {
  CallContext,
  CallEffect,
  FailEffect,
  Fault,
  FaultHooks,
  FaultRegistry,
  ResourceContext,
  ResourceEffect,
  RngFactory,
  ServeContext,
  ServeEffect,
  TickContext,
  TickEffect,
  World,
} from '../types.js'

/** Hooks of one fault, with the window of ticks [startTick, endTick) in which they apply. */
export interface ActiveFault {
  startTick: number
  /** First tick (exclusive end) in which the fault no longer applies; undefined = never ends (ADR-012 §6). */
  endTick?: number
  hooks: FaultHooks
}

/**
 * Factory reserved to the fault of index `index` (ADR-003 §2): every key it is asked for is
 * prefixed with ('fault', index, kind), so faults never share a stream with traffic, metrics, logs
 * or each other.
 */
export function faultRngFactory(root: RngFactory, index: number, kind: string): RngFactory {
  return (...key) => root('fault', index, kind, ...key)
}

/** Activates every fault with its own prefixed factory, in list order. */
export function activateFaults(
  faults: readonly Fault[],
  world: World,
  root: RngFactory,
  registry: FaultRegistry,
): ActiveFault[] {
  return faults.map((fault, index) => {
    const module = registry[fault.kind]
    const hooks = module.activate(fault, world, faultRngFactory(root, index, fault.kind))
    return { startTick: fault.startTick, hooks }
  })
}

/** Hooks of the faults active in `tick` (startTick <= tick < endTick), composed (F-2, F-6, ADR-012 §6). */
export function hooksActiveAt(faults: readonly ActiveFault[], tick: number): FaultHooks {
  const active: FaultHooks[] = []
  for (const fault of faults) {
    if (tick >= fault.startTick && (fault.endTick === undefined || tick < fault.endTick)) active.push(fault.hooks)
  }
  return composeHooks(active)
}

type Hook<C, E> = (ctx: C) => E | undefined

/** Collects the defined implementations of one hook, bound to their owner, in order. */
function collect<C, E>(hooks: readonly FaultHooks[], pick: (h: FaultHooks) => Hook<C, E> | undefined): Hook<C, E>[] {
  const out: Hook<C, E>[] = []
  for (const h of hooks) {
    const fn = pick(h)
    if (fn !== undefined) out.push(fn.bind(h))
  }
  return out
}

/** Calls every hook (always all of them) and returns the defined partial effects, in order. */
function effectsOf<C, E>(fns: readonly Hook<C, E>[], ctx: C): E[] {
  const out: E[] = []
  for (const fn of fns) {
    const effect = fn(ctx)
    if (effect !== undefined) out.push(effect)
  }
  return out
}

/** Sum of the defined values, or undefined when none is defined. */
function sum(values: readonly (number | undefined)[]): number | undefined {
  let total: number | undefined
  for (const v of values) if (v !== undefined) total = (total ?? 0) + v
  return total
}

function firstFail(effects: readonly { fail?: FailEffect }[]): FailEffect | undefined {
  for (const e of effects) if (e.fail !== undefined) return e.fail
  return undefined
}

export function mergeTickEffects(effects: readonly TickEffect[]): TickEffect | undefined {
  if (effects.length === 0) return undefined
  const merged: TickEffect = {}
  const down: string[] = []
  const seen = new Set<string>()
  let anyDown = false
  for (const e of effects) {
    if (e.down === undefined) continue
    anyDown = true
    for (const instance of e.down) {
      if (seen.has(instance)) continue
      seen.add(instance)
      down.push(instance)
    }
  }
  if (anyDown) merged.down = down
  if (effects.some((e) => e.events !== undefined)) merged.events = effects.flatMap((e) => e.events ?? [])
  if (effects.some((e) => e.logs !== undefined)) merged.logs = effects.flatMap((e) => e.logs ?? [])
  return merged
}

export function mergeServeEffects(effects: readonly ServeEffect[]): ServeEffect | undefined {
  if (effects.length === 0) return undefined
  const merged: ServeEffect = {}
  const addLatencyMs = sum(effects.map((e) => e.addLatencyMs))
  if (addLatencyMs !== undefined) merged.addLatencyMs = addLatencyMs
  const fail = firstFail(effects)
  if (fail !== undefined) merged.fail = fail
  return merged
}

export function mergeCallEffects(effects: readonly CallEffect[]): CallEffect | undefined {
  if (effects.length === 0) return undefined
  const merged: CallEffect = {}
  if (effects.some((e) => e.forceCacheMiss !== undefined)) merged.forceCacheMiss = effects.some((e) => e.forceCacheMiss === true)
  const waitMs = sum(effects.map((e) => e.waitMs))
  if (waitMs !== undefined) merged.waitMs = waitMs
  const waitOperation = effects.find((e) => e.waitOperation !== undefined)?.waitOperation
  if (waitOperation !== undefined) merged.waitOperation = waitOperation
  const fail = firstFail(effects)
  if (fail !== undefined) merged.fail = fail
  return merged
}

export function mergeResourceEffects(effects: readonly ResourceEffect[]): ResourceEffect | undefined {
  if (effects.length === 0) return undefined
  const merged: ResourceEffect = {}
  const cpuPctAdd = sum(effects.map((e) => e.cpuPctAdd))
  if (cpuPctAdd !== undefined) merged.cpuPctAdd = cpuPctAdd
  const memMbAdd = sum(effects.map((e) => e.memMbAdd))
  if (memMbAdd !== undefined) merged.memMbAdd = memMbAdd
  const connectionsAdd = sum(effects.map((e) => e.connectionsAdd))
  if (connectionsAdd !== undefined) merged.connectionsAdd = connectionsAdd
  let cap: number | undefined
  for (const e of effects) if (e.connectionsCap !== undefined) cap = cap === undefined ? e.connectionsCap : Math.min(cap, e.connectionsCap)
  if (cap !== undefined) merged.connectionsCap = cap
  return merged
}

/** Composes the hooks of several faults (already gated) by the rules of ADR-002 §4. */
export function composeHooks(hooks: readonly FaultHooks[]): FaultHooks {
  const composed: FaultHooks = {}
  const onTick = collect<TickContext, TickEffect>(hooks, (h) => h.onTick)
  if (onTick.length > 0) composed.onTick = (ctx) => mergeTickEffects(effectsOf(onTick, ctx))
  const onServe = collect<ServeContext, ServeEffect>(hooks, (h) => h.onServe)
  if (onServe.length > 0) composed.onServe = (ctx) => mergeServeEffects(effectsOf(onServe, ctx))
  const onCall = collect<CallContext, CallEffect>(hooks, (h) => h.onCall)
  if (onCall.length > 0) composed.onCall = (ctx) => mergeCallEffects(effectsOf(onCall, ctx))
  const onResources = collect<ResourceContext, ResourceEffect>(hooks, (h) => h.onResources)
  if (onResources.length > 0) composed.onResources = (ctx) => mergeResourceEffects(effectsOf(onResources, ctx))
  return composed
}
