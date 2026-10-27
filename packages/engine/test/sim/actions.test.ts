/**
 * T2.2 — Simulation.act(): validation, cost, scheduling at tick + 1, fault life cycle (endTick,
 * generations, induced faults, stream prefixes) and the `restart` primitive (ADR-012 §1–4, §6;
 * ADR-005 Emenda 3; PRD FASE-2 EN-2, EN-3, EN-4, EN-5, EN-8, DET).
 *
 * The reaction of faults to a restart (FaultActionReactions, cache rule) is T2.3 and `rollback`
 * with deploy history is T2.4; here a rollback is validated, costs its ticks and changes nothing.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EngineError } from '../../src/errors.js'
import { faultCatalog, faultKinds } from '../../src/faults/catalog.js'
import { faultRegistry } from '../../src/faults/registry.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import {
  ACTION_KINDS,
  SUPPORTED_ACTION_KINDS,
  actionCostTable,
  actionEffect,
  createFaultLifecycle,
  validateAction,
} from '../../src/sim/actions.js'
import { activateFaults, hooksActiveAt } from '../../src/sim/hooks.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { toNdjson } from '../../src/sim/serialize.js'
import { createSimulation } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type {
  Action,
  EventRecord,
  Fault,
  FaultKind,
  FaultModule,
  FaultRegistry,
  NoiseEvent,
  RngFactory,
  Simulation,
  SimulationConfig,
  TelemetryRecord,
} from '../../src/types.js'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const world = buildWorld(defaultShop, 'actions')
const COMPONENTS = [...world.services, ...world.deps]
const NAMES = COMPONENTS.map((c) => c.name)
/** ADR-005 Emenda 1: request log and traffic messages (written out: the test does not trust the code). */
const TRAFFIC_MESSAGES = ['request completed', 'connection refused', 'upstream timeout', 'upstream error', 'dependency call failed']
const instancesOf = (name: string): string[] => [...(COMPONENTS.find((c) => c.name === name)?.instances ?? [])]

function caught(fn: () => unknown): EngineError {
  try {
    fn()
  } catch (error) {
    if (error instanceof EngineError) return error
    throw error
  }
  throw new Error('expected an EngineError')
}

const shop = (seed: string, extra: Partial<SimulationConfig> = {}): SimulationConfig => ({ system: defaultShop, seed, ...extra })
const faultsOf = (seed: string, ...inputs: { kind: string; target?: string; startTick?: number }[]): Fault[] =>
  resolveFaults(inputs, buildWorld(defaultShop, seed))

type Step = { act: Action } | { advance: number }

/** Runs `steps` on a fresh simulation and returns all its telemetry as NDJSON. */
function run(config: SimulationConfig, steps: readonly Step[]): string {
  const sim = createSimulation(config)
  for (const step of steps) {
    if ('act' in step) sim.act(step.act)
    else sim.advance(step.advance)
  }
  return toNdjson(sim.telemetry().all())
}

const recordsAt = (sim: Simulation, tick: number): readonly TelemetryRecord[] => sim.telemetry().all().filter((r) => r.tick === tick)
const eventsAt = (sim: Simulation, tick: number): readonly EventRecord[] => sim.telemetry().eventsIn(tick, tick)

// ---------------------------------------------------------------------------
// Validation (ADR-012 §2): one test per row, with code, field and validValues
// ---------------------------------------------------------------------------

describe('validation (ADR-012 §2, EN-5)', () => {
  const sim = createSimulation(shop('validation'))

  it.each([null, undefined, 'restart', 42, true, ['restart', 'cart']])('row 1: %j is not an object => invalid_action on `action`', (value) => {
    const e = caught(() => sim.act(value as unknown as Action))
    expect(e.code).toBe('invalid_action')
    expect(e.field).toBe('action')
    expect(e.validValues).toBeUndefined()
  })

  it.each(['reboot', undefined, 3, 'Restart'])('row 1: kind %j outside SPEC §6 => invalid_action on `action.kind`', (kind) => {
    const e = caught(() => sim.act({ kind, target: 'cart' } as unknown as Action))
    expect(e.code).toBe('invalid_action')
    expect(e.field).toBe('action.kind')
    expect(e.validValues).toEqual(['restart', 'rollback', 'flagOff', 'scale', 'escalate', 'declareMitigated'])
    expect(e.message).toContain('action.kind')
  })

  it.each(['level', 'playerLevel', 'instance', 'note'])('row 1: extra key %s => invalid_action on `action.<key>`', (key) => {
    const e = caught(() => sim.act({ kind: 'restart', target: 'cart', [key]: 'x' } as unknown as Action))
    expect(e.code).toBe('invalid_action')
    expect(e.field).toBe(`action.${key}`)
    expect(e.validValues).toEqual(['kind', 'target'])
  })

  it('row 1: an extra key with value undefined is still an extra key', () => {
    const e = caught(() => sim.act({ kind: 'restart', target: 'cart', level: undefined } as unknown as Action))
    expect(e.code).toBe('invalid_action')
    expect(e.field).toBe('action.level')
  })

  it.each([3, null, {}, ['cart']])('row 1: target %j present and not a string => invalid_action on `action.target`', (target) => {
    const e = caught(() => sim.act({ kind: 'restart', target } as unknown as Action))
    expect(e.code).toBe('invalid_action')
    expect(e.field).toBe('action.target')
    expect(e.validValues).toEqual(NAMES)
  })

  it.each(['flagOff', 'scale', 'escalate', 'declareMitigated'] as const)('row 2: %s => unsupported_action on `action.kind`', (kind) => {
    for (const action of [{ kind }, { kind, target: 'cart' }, { kind, target: 'nope' }] as Action[]) {
      const e = caught(() => sim.act(action))
      expect(e.code).toBe('unsupported_action')
      expect(e.field).toBe('action.kind')
      expect(e.validValues).toEqual(['restart', 'rollback'])
      expect(e.received).toBe(kind)
    }
  })

  it.each(['restart', 'rollback'] as const)('row 3: %s without target (absent or undefined) => invalid_action on `action.target`', (kind) => {
    for (const action of [{ kind }, { kind, target: undefined }]) {
      const e = caught(() => sim.act(action as Action))
      expect(e.code).toBe('invalid_action')
      expect(e.field).toBe('action.target')
      expect(e.validValues).toEqual(NAMES)
    }
  })

  it.each(['restart', 'rollback'] as const)('row 4: %s of a non-component => unknown_target, validValues = components in world order', (kind) => {
    for (const target of ['nope', '', 'Cart', 'cart-0']) {
      const e = caught(() => sim.act({ kind, target }))
      expect(e.code).toBe('unknown_target')
      expect(e.field).toBe('action.target')
      expect(e.received).toBe(target)
      expect(e.validValues).toEqual(NAMES)
    }
  })

  it('rows are checked in table order (structure, unsupported kind, missing target, unknown target)', () => {
    expect(caught(() => sim.act({ kind: 'scale', target: 3 } as unknown as Action)).code).toBe('invalid_action')
    expect(caught(() => sim.act({ kind: 'scale', extra: 1 } as unknown as Action)).field).toBe('action.extra')
    expect(caught(() => sim.act({ kind: 'scale' })).code).toBe('unsupported_action')
  })

  it('every component of the world is a valid target of both actions', () => {
    for (const kind of SUPPORTED_ACTION_KINDS) {
      for (const target of NAMES) expect(validateAction({ kind, target }, world)).toEqual({ kind, target })
    }
  })

  it('validated copy: keys in contract order (kind, target), frozen, detached from the input', () => {
    const input: { target: string; kind: 'restart' } = { target: 'cart', kind: 'restart' }
    const copy = validateAction(input, world)
    expect(Object.keys(copy)).toEqual(['kind', 'target'])
    expect(Object.isFrozen(copy)).toBe(true)
    input.target = 'auth'
    expect(copy.target).toBe('cart')
  })

  it('ACTION_KINDS is the union of SPEC §6, in contract order', () => {
    expect(ACTION_KINDS).toEqual(['restart', 'rollback', 'flagOff', 'scale', 'escalate', 'declareMitigated'])
  })
})

describe('an invalid action leaves the simulation untouched (ADR-012 §2)', () => {
  const bad: unknown[] = [
    null,
    { kind: 'reboot', target: 'cart' },
    { kind: 'restart', target: 'cart', level: 'junior' },
    { kind: 'restart' },
    { kind: 'restart', target: 'nope' },
    { kind: 'scale', target: 'cart' },
  ]

  it('same hash with and without the failed calls, and the next valid action behaves the same', () => {
    const config = shop('untouched', { faults: faultsOf('untouched', { kind: 'service_crash_loop', startTick: 3 }) })
    const plain = run(config, [{ advance: 4 }, { act: { kind: 'restart', target: 'cart' } }, { advance: 6 }])
    const sim = createSimulation(config)
    sim.advance(4)
    const before = sha(toNdjson(sim.telemetry().all()))
    for (const action of bad) expect(() => sim.act(action as Action)).toThrow(EngineError)
    expect(sha(toNdjson(sim.telemetry().all()))).toBe(before)
    expect(sim.world.tick).toBe(4)
    sim.act({ kind: 'restart', target: 'cart' })
    sim.advance(6)
    expect(sha(toNdjson(sim.telemetry().all()))).toBe(sha(plain))
  })
})

// ---------------------------------------------------------------------------
// Cost and result (ADR-012 §1, §3, EN-4)
// ---------------------------------------------------------------------------

describe('cost and ActionResult (ADR-012 §1, §3)', () => {
  it('actionCostTable = ADR-012 §3: restart 2, rollback 3, integers >= 1, frozen', () => {
    expect(actionCostTable).toEqual({ restart: 2, rollback: 3 })
    expect(Object.keys(actionCostTable)).toEqual([...SUPPORTED_ACTION_KINDS])
    for (const cost of Object.values(actionCostTable)) expect(Number.isInteger(cost) && cost >= 1).toBe(true)
    expect(Object.isFrozen(actionCostTable)).toBe(true)
  })

  it('returns { action, tick, tickCost } with the validated action and the tick of the call', () => {
    const sim = createSimulation(shop('result'))
    sim.advance(7)
    const restart = sim.act({ target: 'payment', kind: 'restart' })
    expect(restart).toEqual({ action: { kind: 'restart', target: 'payment' }, tick: 7, tickCost: 2 })
    expect(Object.keys(restart)).toEqual(['action', 'tick', 'tickCost'])
    expect(Object.keys(restart.action)).toEqual(['kind', 'target'])
    expect(Object.isFrozen(restart)).toBe(true)
    expect(Object.isFrozen(restart.action)).toBe(true)
    expect(sim.act({ kind: 'rollback', target: 'catalog' })).toEqual({ action: { kind: 'rollback', target: 'catalog' }, tick: 7, tickCost: 3 })
  })

  it('act() never advances the clock and appends no record', () => {
    const sim = createSimulation(shop('clock'))
    sim.advance(3)
    const count = sim.telemetry().all().length
    sim.act({ kind: 'restart', target: 'cart' })
    sim.act({ kind: 'rollback', target: 'cart' })
    expect(sim.world.tick).toBe(3)
    expect(sim.telemetry().now).toBe(3)
    expect(sim.telemetry().all().length).toBe(count)
    expect(eventsAt(sim, 3)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// restart (ADR-012 §4) and scheduling at tick + 1
// ---------------------------------------------------------------------------

describe('restart X (ADR-012 §4): every instance of X down at tick + 1 and one config event', () => {
  const seeds = ['r-a', 'r-b', 'r-c']

  it.each(NAMES)('restart %s', (target) => {
    for (const seed of seeds) {
      const sim = createSimulation(shop(seed))
      const base = createSimulation(shop(seed))
      sim.advance(5)
      base.advance(5)
      sim.act({ kind: 'restart', target })
      sim.advance(1)
      base.advance(1)
      const te = 6

      // Ticks before te are untouched.
      expect(toNdjson(sim.telemetry().all().filter((r) => r.tick < te))).toBe(toNdjson(base.telemetry().all().filter((r) => r.tick < te)))

      // Exactly one event in te: config, target X, restart: true, no instance, no note, ADR-005 key order.
      const events = eventsAt(sim, te)
      expect(events).toEqual([{ type: 'event', tick: te, kind: 'config', target, restart: true }])
      expect(Object.keys(events[0] as EventRecord)).toEqual(['type', 'tick', 'kind', 'target', 'restart'])

      // Every instance of X is down in te: no server span, instance metrics zeroed (ADR-002 §5).
      const records = recordsAt(sim, te)
      expect(records.some((r) => r.type === 'span' && r.component === target && r.kind === 'server')).toBe(false)
      for (const instance of instancesOf(target)) {
        const m = records.find((r) => r.type === 'metric' && r.instance === instance)
        expect(m).toMatchObject({ rps: 0, cpu: 0, connections: 0 })
      }

      // No new log message (ADR-005 Emenda 3): without faults only the request and traffic
      // vocabulary of ADR-005 Emenda 1 appears, and no log comes from the restarted instances.
      for (const r of recordsAt(sim, te)) {
        if (r.type !== 'log') continue
        expect(TRAFFIC_MESSAGES).toContain(r.message)
        expect(instancesOf(target)).not.toContain(r.instance)
      }

      // te + 1: X is up again (a one-tick outage: every instance reports CPU again) and no further event.
      sim.advance(1)
      for (const instance of instancesOf(target)) {
        const m = recordsAt(sim, te + 1).find((r) => r.type === 'metric' && r.instance === instance)
        expect(m?.type === 'metric' && m.cpu > 0).toBe(true)
      }
      expect(eventsAt(sim, te + 1)).toEqual([])
    }
  })

  it('callers of a restarted dependency see connection refused in te (the symptom shows in other services)', () => {
    const sim = createSimulation(shop('refused'))
    sim.advance(2)
    sim.act({ kind: 'restart', target: 'postgres' })
    sim.advance(1)
    const records = recordsAt(sim, 3)
    const refused = records.filter((r) => r.type === 'span' && r.kind === 'client' && r.peer === 'postgres' && r.status === 'error')
    expect(refused.length).toBeGreaterThan(0)
    expect(records.some((r) => r.type === 'log' && r.message === 'connection refused' && r.component !== 'postgres')).toBe(true)
  })

  it('the effect is scheduled for world.tick + 1, not for tick + tickCost, and only once', () => {
    const sim = createSimulation(shop('schedule'))
    sim.advance(10)
    sim.act({ kind: 'restart', target: 'cart' })
    sim.advance(5)
    const restarts = sim.telemetry().eventsIn(0, 15)
    expect(restarts).toEqual([{ type: 'event', tick: 11, kind: 'config', target: 'cart', restart: true }])
  })

  it('advance(0) keeps the action pending; the next simulated tick is the effect tick', () => {
    const sim = createSimulation(shop('advance-0'))
    sim.advance(2)
    sim.act({ kind: 'restart', target: 'auth' })
    expect(sim.advance(0)).toEqual([])
    sim.advance(1)
    expect(eventsAt(sim, 3)).toEqual([{ type: 'event', tick: 3, kind: 'config', target: 'auth', restart: true }])
  })

  it('an action at tick 0 (fresh simulation) takes effect in tick 1', () => {
    const sim = createSimulation(shop('tick-0'))
    sim.act({ kind: 'restart', target: 'redis' })
    sim.advance(1)
    expect(eventsAt(sim, 1)).toEqual([{ type: 'event', tick: 1, kind: 'config', target: 'redis', restart: true }])
  })

  it('a restart never changes ticks after the outage beyond what the down tick caused: run continues deterministically', () => {
    const a = run(shop('after'), [{ advance: 3 }, { act: { kind: 'restart', target: 'gateway' } }, { advance: 10 }])
    const b = run(shop('after'), [{ advance: 3 }, { act: { kind: 'restart', target: 'gateway' } }, { advance: 10 }])
    expect(a).toBe(b)
  })
})

describe('rollback in T2.2: validated, costed, no telemetry change (deploy history is T2.4)', () => {
  it('a rollback on a target without deploys gives the same telemetry as not acting', () => {
    for (const target of NAMES) {
      const acted = run(shop('rb'), [{ advance: 4 }, { act: { kind: 'rollback', target } }, { advance: 5 }])
      const plain = run(shop('rb'), [{ advance: 9 }])
      expect(acted).toBe(plain)
    }
  })
})

// ---------------------------------------------------------------------------
// Event order (ADR-005 Emenda 3) and several actions before the same advance
// ---------------------------------------------------------------------------

describe('event order in a tick (ADR-005 Emenda 3): fault, action (call order), noise', () => {
  it('fault events, then action events in act() order, then noise in input order', () => {
    const seed = 'order'
    const noise: NoiseEvent[] = [
      { kind: 'deploy', target: 'catalog', tick: 6, note: 'harmless copy change' },
      { kind: 'config', target: 'auth', tick: 6 },
    ]
    // bad_deploy emits its deploy events at its startTick (tick 6).
    const config = shop(seed, { faults: faultsOf(seed, { kind: 'bad_deploy', target: 'cart', startTick: 6 }), noise })
    const sim = createSimulation(config)
    sim.advance(5)
    sim.act({ kind: 'restart', target: 'payment' })
    sim.act({ kind: 'restart', target: 'redis' })
    sim.act({ kind: 'rollback', target: 'catalog' })
    sim.act({ kind: 'restart', target: 'cart' })
    sim.advance(1)

    const base = createSimulation(config)
    base.advance(6)
    const faultEvents = eventsAt(base, 6).filter((e) => e.note === undefined && !(e.kind === 'config' && e.target === 'auth'))
    expect(faultEvents.length).toBeGreaterThan(0)
    expect(faultEvents.every((e) => e.kind === 'deploy' && e.target === 'cart')).toBe(true)

    expect(eventsAt(sim, 6)).toEqual([
      ...faultEvents,
      { type: 'event', tick: 6, kind: 'config', target: 'payment', restart: true },
      { type: 'event', tick: 6, kind: 'config', target: 'redis', restart: true },
      { type: 'event', tick: 6, kind: 'config', target: 'cart', restart: true },
      { type: 'event', tick: 6, kind: 'deploy', target: 'catalog', note: 'harmless copy change' },
      { type: 'event', tick: 6, kind: 'config', target: 'auth' },
    ])
    // Events come first in the tick's records (ADR-005 canonical order).
    const records = recordsAt(sim, 6)
    const firstNonEvent = records.findIndex((r) => r.type !== 'event')
    expect(records.slice(0, firstNonEvent).every((r) => r.type === 'event')).toBe(true)
    expect(records.slice(firstNonEvent).some((r) => r.type === 'event')).toBe(false)
  })

  it('two actions before the same advance are applied in call order (order changes the bytes)', () => {
    const ab = createSimulation(shop('two'))
    ab.advance(2)
    ab.act({ kind: 'restart', target: 'cart' })
    ab.act({ kind: 'restart', target: 'auth' })
    ab.advance(1)
    expect(eventsAt(ab, 3).map((e) => e.target)).toEqual(['cart', 'auth'])

    const ba = createSimulation(shop('two'))
    ba.advance(2)
    ba.act({ kind: 'restart', target: 'auth' })
    ba.act({ kind: 'restart', target: 'cart' })
    ba.advance(1)
    expect(eventsAt(ba, 3).map((e) => e.target)).toEqual(['auth', 'cart'])

    // Same down set, so everything but the event order is equal.
    const nonEvents = (sim: Simulation) => toNdjson(sim.telemetry().all().filter((r) => r.type !== 'event'))
    expect(nonEvents(ab)).toBe(nonEvents(ba))
    expect(toNdjson(ab.telemetry().all())).not.toBe(toNdjson(ba.telemetry().all()))
  })

  it('restarting an instance already down because of a fault keeps one down tick (union) and adds the event', () => {
    const seed = 'union'
    const config = shop(seed, { faults: faultsOf(seed, { kind: 'cache_cold_start', target: 'redis', startTick: 4 }) })
    const sim = createSimulation(config)
    sim.advance(3)
    sim.act({ kind: 'restart', target: 'redis' })
    sim.advance(1)
    const base = createSimulation(config)
    base.advance(4)
    const nonEvents = (s: Simulation) => toNdjson(recordsAt(s, 4).filter((r) => r.type !== 'event'))
    expect(nonEvents(sim)).toBe(nonEvents(base))
    expect(eventsAt(sim, 4)).toEqual([...eventsAt(base, 4), { type: 'event', tick: 4, kind: 'config', target: 'redis', restart: true }])
  })
})

// ---------------------------------------------------------------------------
// EN-2 (no act => phase-1 bytes) and DET
// ---------------------------------------------------------------------------

describe('EN-2: without act() the telemetry is byte-identical to phase 1', () => {
  const fixture = (file: string) => readFileSync(join(pkgDir, 'fixtures', file), 'utf8')

  it.each(['baseline', ...faultKinds])('%s: createSimulation + advance, no act = committed fixture', (name) => {
    const faults = name === 'baseline' ? [] : faultsOf('fixture', { kind: name })
    const sim = createSimulation(shop('fixture', { faults }))
    sim.advance(59)
    expect(sha(toNdjson(sim.telemetry().all()))).toBe(sha(fixture(`${name}.ndjson`)))
  })
})

describe('DET: same seed + same act/advance sequence => identical NDJSON', () => {
  const steps: Step[] = [
    { advance: 8 },
    { act: { kind: 'restart', target: 'payment' } },
    { advance: 2 },
    { act: { kind: 'rollback', target: 'cart' } },
    { act: { kind: 'restart', target: 'postgres' } },
    { advance: 3 },
    { act: { kind: 'restart', target: 'redis' } },
    { advance: 12 },
  ]

  it.each(['baseline', ...faultKinds])('%s: two runs, same SHA-256', (name) => {
    for (const seed of ['det-1', 'det-2', 'det-3']) {
      const faults = name === 'baseline' ? [] : faultsOf(seed, { kind: name, startTick: 5 })
      const a = run(shop(seed, { faults }), steps)
      const b = run(shop(seed, { faults }), steps)
      expect(sha(a)).toBe(sha(b))
    }
  })

  it('the actions change the bytes (the run with actions is not the plain run)', () => {
    expect(run(shop('det-1'), steps)).not.toBe(run(shop('det-1'), [{ advance: 25 }]))
  })

  it('different seeds still give different telemetry with the same actions', () => {
    expect(sha(run(shop('det-1'), steps))).not.toBe(sha(run(shop('det-2'), steps)))
  })
})

// ---------------------------------------------------------------------------
// Fault life cycle (ADR-012 §6): mechanism used by T2.3/T2.4
// ---------------------------------------------------------------------------

describe('createFaultLifecycle (ADR-012 §6)', () => {
  const root = createRngFactory('lifecycle')
  const draw = (f: RngFactory, ...key: (string | number)[]) => f(...key).next()

  /** Fake modules that record the stream they got and the fault they were activated with. */
  function recordingRegistry() {
    const seen: { fault: Fault; draw: number }[] = []
    const fake = <K extends FaultKind>(kind: K): FaultModule<K> => ({
      kind,
      activate: (fault, _w, rng) => {
        seen.push({ fault, draw: draw(rng, 'probe') })
        return { onServe: () => ({ addLatencyMs: fault.startTick }) }
      },
    })
    const registry = Object.fromEntries(faultKinds.map((k) => [k, fake(k)])) as unknown as FaultRegistry
    return { seen, registry }
  }

  const faults: Fault[] = [
    { kind: 'slow_dependency', target: 'redis', startTick: 4, params: {} },
    { kind: 'disk_full', target: 'postgres', startTick: 7, params: {} },
  ]

  it('generation 0 = activateFaults: same modules, worlds, streams and startTicks, in list order', () => {
    const a = recordingRegistry()
    const b = recordingRegistry()
    const lifecycle = createFaultLifecycle(faults, world, root, a.registry)
    const active = activateFaults(faults, world, root, b.registry)
    expect(a.seen).toEqual(b.seen)
    expect(lifecycle.active.map((x) => x.startTick)).toEqual(active.map((x) => x.startTick))
    expect(lifecycle.entries.map((e) => [e.origin, e.generation])).toEqual([
      [['fault', 0, 'slow_dependency'], 0],
      [['fault', 1, 'disk_full'], 0],
    ])
    expect(lifecycle.active.every((x) => x.endTick === undefined)).toBe(true)
  })

  it('with the real registry, generation 0 hooks behave like activateFaults hooks', () => {
    const real = faultsOf('lifecycle', { kind: 'slow_dependency', target: 'redis', startTick: 2 })
    const lifecycle = createFaultLifecycle(real, world, root, faultRegistry)
    expect(lifecycle.active.length).toBe(1)
    expect(Object.keys(lifecycle.active[0]?.hooks ?? {})).toEqual(Object.keys(activateFaults(real, world, root, faultRegistry)[0]?.hooks ?? {}))
  })

  it('activeOn: by target and window [startTick, endTick), in creation order', () => {
    const { registry } = recordingRegistry()
    const lifecycle = createFaultLifecycle(faults, world, root, registry)
    expect(lifecycle.activeOn('redis', 3)).toEqual([])
    expect(lifecycle.activeOn('redis', 4)).toEqual([lifecycle.entries[0]])
    expect(lifecycle.activeOn('postgres', 6)).toEqual([])
    expect(lifecycle.activeOn('postgres', 7)).toEqual([lifecycle.entries[1]])
    expect(lifecycle.activeOn('cart', 100)).toEqual([])
    lifecycle.end(lifecycle.entries[0] as never, 9)
    expect(lifecycle.activeOn('redis', 8)).toEqual([lifecycle.entries[0]])
    expect(lifecycle.activeOn('redis', 9)).toEqual([])
  })

  it('end sets endTick (exclusive) and keeps an earlier end', () => {
    const { registry } = recordingRegistry()
    const lifecycle = createFaultLifecycle(faults, world, root, registry)
    const entry = lifecycle.entries[0] as (typeof lifecycle.entries)[number]
    lifecycle.end(entry, 12)
    expect(entry.active.endTick).toBe(12)
    lifecycle.end(entry, 15)
    expect(entry.active.endTick).toBe(12)
    lifecycle.end(entry, 10)
    expect(entry.active.endTick).toBe(10)
    // From tick 10 on only the postgres fault (startTick 7) is composed.
    expect(hooksActiveAt(lifecycle.active, 9).onServe?.({ tick: 9 } as never)).toEqual({ addLatencyMs: 4 + 7 })
    expect(hooksActiveAt(lifecycle.active, 10).onServe?.({ tick: 10 } as never)).toEqual({ addLatencyMs: 7 })
  })

  it("reset: ends the generation at te and activates generation g + 1 with startTick = te and prefix (...origin, 'gen', g)", () => {
    const { seen, registry } = recordingRegistry()
    const lifecycle = createFaultLifecycle(faults, world, root, registry)
    const gen0 = lifecycle.entries[1] as (typeof lifecycle.entries)[number]
    const gen1 = lifecycle.reset(gen0, 20, world)
    expect(gen0.active.endTick).toBe(20)
    expect(gen1.fault).toEqual({ ...faults[1], startTick: 20 })
    expect(gen1.generation).toBe(1)
    expect(gen1.origin).toEqual(['fault', 1, 'disk_full'])
    expect(seen.at(-1)?.draw).toBe(draw(root, 'fault', 1, 'disk_full', 'gen', 1, 'probe'))
    const gen2 = lifecycle.reset(gen1, 30, world)
    expect(gen1.active.endTick).toBe(30)
    expect(gen2.generation).toBe(2)
    expect(seen.at(-1)?.draw).toBe(draw(root, 'fault', 1, 'disk_full', 'gen', 2, 'probe'))
    // Generations are appended after the configured faults, in creation order (ADR-005 Emenda 3, 1a).
    expect(lifecycle.entries.map((e) => [e.fault.target, e.generation])).toEqual([
      ['redis', 0],
      ['postgres', 0],
      ['postgres', 1],
      ['postgres', 2],
    ])
    expect(lifecycle.active.length).toBe(4)
    // Exactly one generation applies in each tick.
    expect(hooksActiveAt(lifecycle.active, 19).onServe?.({ tick: 19 } as never)).toEqual({ addLatencyMs: 4 + 7 })
    expect(hooksActiveAt(lifecycle.active, 25).onServe?.({ tick: 25 } as never)).toEqual({ addLatencyMs: 4 + 20 })
    expect(hooksActiveAt(lifecycle.active, 31).onServe?.({ tick: 31 } as never)).toEqual({ addLatencyMs: 4 + 30 })
  })

  it("streams of generation 0, generation g >= 1 and of induced faults never coincide", () => {
    const keys = [
      ['fault', 0, 'cache_cold_start', 'miss', 5, 't5r0'],
      ['fault', 0, 'cache_cold_start', 'gen', 1, 'miss', 5, 't5r0'],
      ['action', 0, 'cache_cold_start', 'miss', 5, 't5r0'],
      ['action', 0, 'cache_cold_start', 'gen', 1, 'miss', 5, 't5r0'],
    ]
    const draws = keys.map((k) => draw(root, ...k))
    expect(new Set(draws).size).toBe(draws.length)
  })

  it("induce: new fault with catalog defaults, startTick = te, prefix ('action', n, kind), appended in creation order", () => {
    const { seen, registry } = recordingRegistry()
    const lifecycle = createFaultLifecycle(faults, world, root, registry)
    const induced = lifecycle.induce('cache_cold_start', 'redis', 12, 3, world)
    const defaults = Object.fromEntries(Object.entries(faultCatalog.cache_cold_start.params).map(([name, p]) => [name, p.default]))
    expect(induced.fault).toEqual({ kind: 'cache_cold_start', target: 'redis', startTick: 12, params: defaults })
    expect(induced.origin).toEqual(['action', 3, 'cache_cold_start'])
    expect(induced.generation).toBe(0)
    expect(seen.at(-1)?.draw).toBe(draw(root, 'action', 3, 'cache_cold_start', 'probe'))
    expect(lifecycle.entries.at(-1)).toBe(induced)
    expect(lifecycle.activeOn('redis', 12)).toEqual([lifecycle.entries[0], induced])
    // A reset of an induced fault follows the same generation rule under its own origin.
    lifecycle.reset(induced, 15, world)
    expect(seen.at(-1)?.draw).toBe(draw(root, 'action', 3, 'cache_cold_start', 'gen', 1, 'probe'))
  })

  it('induced and reset faults use the real modules and change telemetry from te on only (orchestrator wiring)', () => {
    // The module hooks of an induced cache_cold_start fire at its own startTick (cold restart events).
    const real = createFaultLifecycle([], world, root, faultRegistry)
    const induced = real.induce('cache_cold_start', 'redis', 9, 0, world)
    const effect = hooksActiveAt(real.active, 9).onTick?.({ tick: 9, world })
    expect(effect?.down).toEqual(instancesOf('redis'))
    expect(hooksActiveAt(real.active, 8).onTick).toBeUndefined()
    expect(induced.active.startTick).toBe(9)
  })
})

describe('actionEffect (ADR-012 §4)', () => {
  const lifecycle = createFaultLifecycle([], world, createRngFactory('effect'), faultRegistry)

  it('restart: down = every instance of the target in world order; one config restart event', () => {
    for (const target of NAMES) {
      const effect = actionEffect({ action: { kind: 'restart', target }, effectTick: 1, seq: 0 }, { tick: 1, world, lifecycle })
      expect(effect).toEqual({ down: instancesOf(target), events: [{ kind: 'config', target, restart: true }] })
    }
  })

  it('rollback: no effect yet (T2.4)', () => {
    expect(actionEffect({ action: { kind: 'rollback', target: 'cart' }, effectTick: 1, seq: 0 }, { tick: 1, world, lifecycle })).toEqual({})
  })

  it('fails loudly on a target outside the world (validation is bypassed only by internal misuse)', () => {
    expect(() => actionEffect({ action: { kind: 'restart', target: 'nope' }, effectTick: 1, seq: 0 }, { tick: 1, world, lifecycle })).toThrow(
      /not a component/,
    )
  })
})
