/**
 * T2.2 — Simulation.act(): validation, cost, scheduling at tick + 1, fault life cycle (endTick,
 * generations, induced faults, stream prefixes) and the `restart` primitive (ADR-012 §1–4, §6;
 * ADR-005 Emenda 3; PRD FASE-2 EN-2, EN-3, EN-4, EN-5, EN-8, DET).
 * T2.3 — the reaction table FaultActionReactions (ADR-012 §5) applied by the process replacement of
 * `restart`, and the cache rule (induced cache_cold_start, ADR-012 §4).
 *
 * T2.4 — `rollback`: deploy history read from the TelemetryView, most recent batch not yet
 * reverted, binding to bad_deploy, process replacement without unavailability, one `deploy` event,
 * no batch = nothing (ADR-012 §4–§6; PRD FASE-2 EN-4, EN-5, DET).
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
  faultActionReactions,
  latestRevertibleBatch,
  replaceProcess,
  validateAction,
} from '../../src/sim/actions.js'
import { activateFaults, hooksActiveAt } from '../../src/sim/hooks.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { toNdjson } from '../../src/sim/serialize.js'
import { createSimulation, createSimulationWith } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import { signatureSeeds } from '../support/signature.js'
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
  TelemetryView,
} from '../../src/types.js'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const world = buildWorld(defaultShop, 'actions')
const COMPONENTS = [...world.services, ...world.deps]
const NAMES = COMPONENTS.map((c) => c.name)
/** ADR-005 Emenda 1: request log and traffic messages (written out: the test does not trust the code). */
const TRAFFIC_MESSAGES = ['request completed', 'connection refused', 'upstream timeout', 'upstream error', 'dependency call failed']
const instancesOf = (name: string): string[] => [...(COMPONENTS.find((c) => c.name === name)?.instances ?? [])]
/** Caches follow the cache rule of ADR-012 §4 (their restart events are the cache_cold_start module's). */
const CACHES = world.deps.filter((d) => d.kind === 'cache').map((d) => d.name)
const NON_CACHE = NAMES.filter((n) => !CACHES.includes(n))
/** The restart events of cache_cold_start (ADR-004): one config event with restart: true per instance. */
const coldStartEvents = (cache: string, tick: number): EventRecord[] =>
  instancesOf(cache).map((instance) => ({ type: 'event', tick, kind: 'config', target: cache, instance, restart: true }))

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

  // T2.3: a cache is excluded here; its restart follows the cache rule (see "cache rule" below).
  it.each(NON_CACHE)('restart %s', (target) => {
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
    // T2.3: redis is a cache, so the events of tick 1 are the induced cache_cold_start's (ADR-012 §4).
    expect(eventsAt(sim, 1)).toEqual(coldStartEvents('redis', 1))
  })

  it('a restart never changes ticks after the outage beyond what the down tick caused: run continues deterministically', () => {
    const a = run(shop('after'), [{ advance: 3 }, { act: { kind: 'restart', target: 'gateway' } }, { advance: 10 }])
    const b = run(shop('after'), [{ advance: 3 }, { act: { kind: 'restart', target: 'gateway' } }, { advance: 10 }])
    expect(a).toBe(b)
  })
})

describe('rollback without any deploy in the run: validated, costed, no telemetry change', () => {
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

    // T2.3: the restart of redis (a cache) emits no action event; the induced cache_cold_start
    // emits its restart events as a fault, after the configured faults (creation order).
    expect(eventsAt(sim, 6)).toEqual([
      ...faultEvents,
      ...coldStartEvents('redis', 6),
      { type: 'event', tick: 6, kind: 'config', target: 'payment', restart: true },
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
    // T2.3: with the real modules this no longer happens on the restarted component (the crash loop
    // is cleared in te, a cache follows the cache rule), so the union is checked with a fake module
    // of a kind whose reaction is `none` (bad_deploy) that keeps catalog-0 down and emits one event.
    const seed = 'union'
    const fakeBadDeploy: FaultModule<'bad_deploy'> = {
      kind: 'bad_deploy',
      activate: () => ({ onTick: ({ tick }) => ({ down: ['catalog-0'], events: [{ kind: 'deploy', target: 'catalog', note: `t${tick}` }] }) }),
    }
    const registry = { ...faultRegistry, bad_deploy: fakeBadDeploy } as FaultRegistry
    const config = shop(seed, { faults: faultsOf(seed, { kind: 'bad_deploy', target: 'catalog', startTick: 2 }) })
    const sim = createSimulationWith(config, { registry })
    sim.advance(3)
    sim.act({ kind: 'restart', target: 'catalog' })
    sim.advance(2)
    const downOf = (tick: number) =>
      recordsAt(sim, tick).flatMap((r) => (r.type === 'metric' && r.component === 'catalog' && r.instance !== undefined && r.cpu === 0 ? [r.instance] : []))
    expect(downOf(4)).toEqual(instancesOf('catalog'))
    expect(downOf(5)).toEqual(['catalog-0'])
    expect(eventsAt(sim, 4)).toEqual([
      { type: 'event', tick: 4, kind: 'deploy', target: 'catalog', note: 't4' },
      { type: 'event', tick: 4, kind: 'config', target: 'catalog', restart: true },
    ])
  })

  it('restarting a cache already cold-starting in te: one cold start (the action\'s), no duplicate event nor down', () => {
    // T2.3 (ADR-012 §4, cache rule): the configured cache_cold_start active in te is ended and the
    // induced one emits the events and the down tick; the restart emits nothing of its own.
    const seed = 'union-cache'
    const config = shop(seed, { faults: faultsOf(seed, { kind: 'cache_cold_start', target: 'redis', startTick: 4 }) })
    const sim = createSimulation(config)
    sim.advance(3)
    sim.act({ kind: 'restart', target: 'redis' })
    sim.advance(1)
    const base = createSimulation(config)
    base.advance(4)
    expect(eventsAt(sim, 4)).toEqual(eventsAt(base, 4))
    expect(eventsAt(sim, 4)).toEqual(coldStartEvents('redis', 4))
    for (const instance of instancesOf('redis')) {
      expect(recordsAt(sim, 4).find((r) => r.type === 'metric' && r.instance === instance)).toMatchObject({ rps: 0, cpu: 0, connections: 0 })
    }
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
  /** A real view without any deploy event (the restart cases never read it). */
  const view = createSimulation(shop('effect')).telemetry()

  it('restart: down = every instance of the target in world order; one config restart event', () => {
    // T2.3: caches are excluded; their restart effect is empty (cache rule, next test).
    for (const target of NON_CACHE) {
      const effect = actionEffect({ action: { kind: 'restart', target }, effectTick: 1, seq: 0 }, { tick: 1, world, lifecycle, view })
      expect(effect).toEqual({ down: instancesOf(target), events: [{ kind: 'config', target, restart: true }] })
    }
  })

  it('restart of a cache: no down nor event of its own; a cache_cold_start is induced from te (cache rule)', () => {
    const own = createFaultLifecycle([], world, createRngFactory('effect-cache'), faultRegistry)
    for (const target of CACHES) {
      const effect = actionEffect({ action: { kind: 'restart', target }, effectTick: 3, seq: 7 }, { tick: 3, world, lifecycle: own, view })
      expect(effect).toEqual({})
      const induced = own.entries.at(-1)
      expect(induced?.fault).toMatchObject({ kind: 'cache_cold_start', target, startTick: 3 })
      expect(induced?.origin).toEqual(['action', 7, 'cache_cold_start'])
      expect(hooksActiveAt(own.active, 3).onTick?.({ tick: 3, world })?.down).toEqual(instancesOf(target))
    }
  })

  it('rollback without a batch in the view: empty effect, no process replacement', () => {
    expect(actionEffect({ action: { kind: 'rollback', target: 'cart' }, effectTick: 1, seq: 0 }, { tick: 1, world, lifecycle, view })).toEqual({})
    expect(lifecycle.entries).toEqual([])
  })

  it('fails loudly on a target outside the world (validation is bypassed only by internal misuse)', () => {
    expect(() => actionEffect({ action: { kind: 'restart', target: 'nope' }, effectTick: 1, seq: 0 }, { tick: 1, world, lifecycle, view })).toThrow(
      /not a component/,
    )
  })
})

// ---------------------------------------------------------------------------
// T2.3 — FaultActionReactions (ADR-012 §5) applied by the process replacement of `restart`,
// and the cache rule (ADR-012 §4)
// ---------------------------------------------------------------------------

describe('FaultActionReactions = ADR-012 §5, row by row', () => {
  // Written out from the ADR table (columns "SP (onProcessReplacement)" and "revertedByRollback"):
  // the test does not trust the code.
  const ADR_012_TABLE = {
    service_crash_loop: { onProcessReplacement: 'clear', revertedByRollback: false },
    disk_full: { onProcessReplacement: 'none', revertedByRollback: false },
    connection_pool_exhaustion: { onProcessReplacement: 'reset', revertedByRollback: false },
    bad_deploy: { onProcessReplacement: 'none', revertedByRollback: true },
    slow_dependency: { onProcessReplacement: 'clear', revertedByRollback: false },
    cache_cold_start: { onProcessReplacement: 'reset', revertedByRollback: false },
  } as const

  it.each(faultKinds)('%s', (kind) => {
    expect(faultActionReactions[kind]).toEqual(ADR_012_TABLE[kind])
  })

  it('one row per FaultKind, in catalog order, frozen', () => {
    expect(Object.keys(faultActionReactions)).toEqual([...faultKinds])
    expect(Object.isFrozen(faultActionReactions)).toBe(true)
    for (const kind of faultKinds) expect(Object.isFrozen(faultActionReactions[kind])).toBe(true)
  })
})

/** R1 of phase 1: >= 10 seeds per cell. */
const REACTION_SEEDS = Array.from({ length: 10 }, (_, i) => `reaction-${i}`)
const START = 5
const ACT_AT = 10
const TE = ACT_AT + 1
const UNTIL = 22

/** Runs `faults` with a restart of `target` called at ACT_AT (effect in TE), up to tick UNTIL. */
function restartRun(seed: string, faults: Fault[], target: string): Simulation {
  const sim = createSimulation(shop(seed, { faults }))
  sim.advance(ACT_AT)
  sim.act({ kind: 'restart', target })
  sim.advance(UNTIL - ACT_AT)
  return sim
}
function plainRun(seed: string, faults: Fault[]): Simulation {
  const sim = createSimulation(shop(seed, { faults }))
  sim.advance(UNTIL)
  return sim
}
const from = (sim: Simulation, tick: number) => toNdjson(sim.telemetry().all().filter((r) => r.tick >= tick))
const defaultFault = (seed: string, kind: FaultKind) => faultsOf(seed, { kind, startTick: START })
const targetOf = (kind: FaultKind) => faultCatalog[kind].defaultTarget

describe('restart on the target of the fault (ADR-012 §5, column "restart no alvo"), >= 10 seeds', () => {
  it.each(['service_crash_loop', 'slow_dependency'] as const)('%s: clear — from te + 1 the run is the run without the fault', (kind) => {
    for (const seed of REACTION_SEEDS) {
      const acted = restartRun(seed, defaultFault(seed, kind), targetOf(kind))
      const withFault = plainRun(seed, defaultFault(seed, kind))
      const noFault = plainRun(seed, [])
      // The fault really was there after te in the plain run (otherwise the cell proves nothing).
      expect(from(withFault, TE + 1)).not.toBe(from(noFault, TE + 1))
      expect(from(acted, TE + 1)).toBe(from(noFault, TE + 1))
      // te: the config restart event of the action.
      expect(eventsAt(acted, TE)).toContainEqual({ type: 'event', tick: TE, kind: 'config', target: targetOf(kind), restart: true })
    }
  })

  it.each(['disk_full', 'bad_deploy'] as const)('%s: none — from te + 1 the fault is intact (same run as without acting)', (kind) => {
    for (const seed of REACTION_SEEDS) {
      const acted = restartRun(seed, defaultFault(seed, kind), targetOf(kind))
      const withFault = plainRun(seed, defaultFault(seed, kind))
      expect(from(withFault, TE + 1)).not.toBe(from(plainRun(seed, []), TE + 1))
      expect(from(acted, TE + 1)).toBe(from(withFault, TE + 1))
      for (const instance of instancesOf(targetOf(kind))) {
        expect(recordsAt(acted, TE).find((r) => r.type === 'metric' && r.instance === instance)).toMatchObject({ rps: 0, cpu: 0, connections: 0 })
      }
    }
  })

  it('connection_pool_exhaustion: reset — the leak starts over in te and the pool is exhausted again after ceil(poolSize / leakPerTick) ticks', () => {
    const acquire = (sim: Simulation, tick: number) =>
      recordsAt(sim, tick).filter((r) => r.type === 'span' && r.operation === 'db.acquire').length
    const target = targetOf('connection_pool_exhaustion')
    for (const seed of REACTION_SEEDS) {
      const faults = defaultFault(seed, 'connection_pool_exhaustion')
      const { poolSize, leakPerTick } = (faults[0] as Fault).params as { poolSize: number; leakPerTick: number }
      // leaked(s) = min(poolSize, leakPerTick × (s + 1)); the pool is exhausted from s = again - 1 on.
      const again = Math.ceil(poolSize / leakPerTick)
      const acted = restartRun(seed, faults, target)
      const withFault = plainRun(seed, faults)
      const noFault = plainRun(seed, [])
      const connections = (sim: Simulation, tick: number, instance: string) => {
        const m = recordsAt(sim, tick).find((r) => r.type === 'metric' && r.instance === instance)
        return m?.type === 'metric' ? m.connections : Number.NaN
      }
      for (const instance of instancesOf(target)) {
        // Without acting the pool stays full after te.
        expect(connections(withFault, TE + 1, instance)).toBe(poolSize)
        // After the reset, s = tick - te: the instance holds the connections of the plain traffic
        // plus leaked(s) = leakPerTick × (s + 1) of the new generation, while the pool has room
        // (no wait, so the traffic is the traffic without the fault)...
        for (let s = 1; s < again - 1; s++) {
          expect(connections(acted, TE + s, instance)).toBe(connections(noFault, TE + s, instance) + leakPerTick * (s + 1))
        }
        // ...and the pool is full again from s = again - 1 on: the cause stays, the reset only buys time.
        for (let t = TE + again - 1; t <= UNTIL; t++) expect(connections(acted, t, instance)).toBe(poolSize)
      }
      // No db.acquire wait while the pool has a free connection.
      for (let t = TE + 1; t < TE + again - 1; t++) expect(acquire(acted, t)).toBe(0)
      // And the run is the reset one, not the plain fault run.
      expect(from(acted, TE + 1)).not.toBe(from(withFault, TE + 1))
    }
  })

  it('cache_cold_start: cache rule — a new cooling from te; the module events and down once, no action event', () => {
    for (const seed of REACTION_SEEDS) {
      const acted = restartRun(seed, defaultFault(seed, 'cache_cold_start'), 'redis')
      expect(eventsAt(acted, TE)).toEqual(coldStartEvents('redis', TE))
      for (const instance of instancesOf('redis')) {
        expect(recordsAt(acted, TE).find((r) => r.type === 'metric' && r.instance === instance)).toMatchObject({ rps: 0, cpu: 0, connections: 0 })
      }
    }
  })
})

describe('restart on another component (ADR-012 §5, column "restart em outro"): the fault is intact', () => {
  /** A non-cache component other than the fault's target. */
  const otherOf = (kind: FaultKind) => (targetOf(kind) === 'cart' ? 'auth' : 'cart')

  it.each(faultKinds)('%s', (kind) => {
    for (const seed of REACTION_SEEDS) {
      const acted = restartRun(seed, defaultFault(seed, kind), otherOf(kind))
      const withFault = plainRun(seed, defaultFault(seed, kind))
      expect(from(acted, TE + 1)).toBe(from(withFault, TE + 1))
      expect(eventsAt(acted, TE)).toContainEqual({ type: 'event', tick: TE, kind: 'config', target: otherOf(kind), restart: true })
    }
  })
})

describe('cache rule (ADR-012 §4): restart of redis without any fault', () => {
  it('one cold start: the module events and down in te (one event per instance), forced misses afterwards', () => {
    const toPostgres = (sim: Simulation, tick: number) =>
      recordsAt(sim, tick).filter((r) => r.type === 'span' && r.kind === 'client' && r.peer === 'postgres').length
    for (const seed of REACTION_SEEDS) {
      const acted = restartRun(seed, [], 'redis')
      const base = plainRun(seed, [])
      expect(eventsAt(acted, TE)).toEqual(coldStartEvents('redis', TE))
      for (const instance of instancesOf('redis')) {
        expect(recordsAt(acted, TE).find((r) => r.type === 'metric' && r.instance === instance)).toMatchObject({ rps: 0, cpu: 0, connections: 0 })
      }
      // Forced misses fall through to the backing store in the following ticks (SPEC §3.4: the pain shows in postgres).
      for (let t = TE + 1; t <= TE + 5; t++) expect(toPostgres(acted, t)).toBeGreaterThan(toPostgres(base, t))
      // No further restart event.
      for (let t = TE + 1; t <= UNTIL; t++) expect(eventsAt(acted, t)).toEqual([])
    }
  })

  it('a second restart ends the first induced cold start and starts a new one: one set of events per restart', () => {
    const sim = createSimulation(shop('cache-twice'))
    sim.advance(3)
    sim.act({ kind: 'restart', target: 'redis' })
    sim.advance(5)
    sim.act({ kind: 'restart', target: 'redis' })
    sim.advance(3)
    expect(sim.telemetry().eventsIn(0, 11)).toEqual([...coldStartEvents('redis', 4), ...coldStartEvents('redis', 9)])
  })
})

describe('replaceProcess (ADR-012 §4): reactions in the life cycle, faults not yet started untouched', () => {
  const root = createRngFactory('sp')
  const ctx = (lifecycle: ReturnType<typeof createFaultLifecycle>, tick: number) => ({ tick, world, lifecycle })

  it('clear ends in te, reset adds generation 1 from te, none leaves the fault, future faults are untouched', () => {
    const faults = resolveFaults(
      [
        { kind: 'service_crash_loop', target: 'cart', startTick: 2 },
        { kind: 'connection_pool_exhaustion', target: 'cart', startTick: 3 },
        { kind: 'bad_deploy', target: 'cart', startTick: 4 },
        { kind: 'slow_dependency', target: 'cart', startTick: 50 },
      ],
      world,
    )
    const lifecycle = createFaultLifecycle(faults, world, root, faultRegistry)
    expect(replaceProcess('cart', 0, ctx(lifecycle, 10))).toBe(false)
    const [crash, pool, deploy, future] = lifecycle.entries
    expect(crash?.active.endTick).toBe(10)
    expect(pool?.active.endTick).toBe(10)
    expect(deploy?.active.endTick).toBeUndefined()
    expect(future?.active.endTick).toBeUndefined()
    expect(lifecycle.entries.length).toBe(5)
    const gen1 = lifecycle.entries[4]
    expect(gen1?.fault).toEqual({ ...faults[1], startTick: 10 })
    expect(gen1?.origin).toEqual(['fault', 1, 'connection_pool_exhaustion'])
    expect(gen1?.generation).toBe(1)
    expect(lifecycle.activeOn('cart', 10)).toEqual([deploy, gen1])
  })

  it('on a cache: the active cache_cold_start is ended (not reset) and one is induced; other faults on it react by their row', () => {
    const faults = resolveFaults(
      [
        { kind: 'cache_cold_start', target: 'redis', startTick: 2 },
        { kind: 'slow_dependency', target: 'redis', startTick: 2 },
      ],
      world,
    )
    const lifecycle = createFaultLifecycle(faults, world, root, faultRegistry)
    expect(replaceProcess('redis', 4, ctx(lifecycle, 8))).toBe(true)
    expect(lifecycle.entries.map((e) => [e.fault.kind, e.origin, e.generation, e.active.startTick, e.active.endTick])).toEqual([
      ['cache_cold_start', ['fault', 0, 'cache_cold_start'], 0, 2, 8],
      ['slow_dependency', ['fault', 1, 'slow_dependency'], 0, 2, 8],
      ['cache_cold_start', ['action', 4, 'cache_cold_start'], 0, 8, undefined],
    ])
  })
})

describe('streams of the reacted faults through the simulation (ADR-012 §6)', () => {
  /** The real modules, recording the fault, a probe draw of its stream and the hooks they return. */
  function probing(seed: string) {
    const root = createRngFactory(seed)
    const seen: { fault: Fault; probe: number; hooks: ReturnType<FaultModule['activate']> }[] = []
    const registry = Object.fromEntries(
      faultKinds.map((kind) => {
        const real = faultRegistry[kind] as FaultModule
        const module: FaultModule = {
          kind,
          activate: (fault, w, rng) => {
            const hooks = real.activate(fault, w, rng)
            seen.push({ fault, probe: rng('probe').next(), hooks })
            return hooks
          },
        }
        return [kind, module]
      }),
    ) as unknown as FaultRegistry
    return { root, seen, registry }
  }

  it("pool reset: generation g >= 1 uses ('fault', i, kind, 'gen', g); its leak in te is leakPerTick", () => {
    const seed = 'streams-pool'
    const { root, seen, registry } = probing(seed)
    const kind = 'connection_pool_exhaustion'
    const faults = faultsOf(seed, { kind: 'cache_cold_start', startTick: 1 }, { kind, startTick: 2 })
    const sim = createSimulationWith(shop(seed, { faults }), { registry })
    sim.advance(6)
    sim.act({ kind: 'restart', target: 'payment' })
    sim.advance(4)
    sim.act({ kind: 'restart', target: 'payment' })
    sim.advance(1)
    expect(seen.map((s) => [s.fault.kind, s.fault.startTick])).toEqual([
      ['cache_cold_start', 1],
      [kind, 2],
      [kind, 7],
      [kind, 11],
    ])
    expect(seen[2]?.probe).toBe(root('fault', 1, kind, 'gen', 1, 'probe').next())
    expect(seen[3]?.probe).toBe(root('fault', 1, kind, 'gen', 2, 'probe').next())
    const leakPerTick = (faults[1] as Fault).params['leakPerTick']
    expect(seen[2]?.hooks.onResources?.({ tick: 7, component: 'payment', instance: 'payment-0' })?.connectionsAdd).toBe(leakPerTick)
  })

  it("cache rule: the induced cache_cold_start uses ('action', n, 'cache_cold_start'), n = sequence number of the action", () => {
    const seed = 'streams-cache'
    const { root, seen, registry } = probing(seed)
    const sim = createSimulationWith(shop(seed), { registry })
    sim.advance(2)
    sim.act({ kind: 'restart', target: 'cart' }) // seq 0
    sim.act({ kind: 'rollback', target: 'cart' }) // seq 1
    sim.act({ kind: 'restart', target: 'redis' }) // seq 2
    sim.advance(3)
    expect(seen.map((s) => [s.fault.kind, s.fault.target, s.fault.startTick])).toEqual([['cache_cold_start', 'redis', 3]])
    expect(seen[0]?.probe).toBe(root('action', 2, 'cache_cold_start', 'probe').next())
  })
})

describe('DET with reactions: same seed + same act/advance sequence => identical NDJSON', () => {
  it.each(faultKinds)('%s: restart of its target twice, two runs, same SHA-256', (kind) => {
    for (const seed of ['det-r-1', 'det-r-2', 'det-r-3']) {
      const target = targetOf(kind)
      const steps: Step[] = [
        { advance: 8 },
        { act: { kind: 'restart', target } },
        { advance: 4 },
        { act: { kind: 'restart', target } },
        { act: { kind: 'restart', target: 'redis' } },
        { advance: 10 },
      ]
      const faults = faultsOf(seed, { kind, startTick: 5 })
      expect(sha(run(shop(seed, { faults }), steps))).toBe(sha(run(shop(seed, { faults }), steps)))
    }
  })
})

// ---------------------------------------------------------------------------
// T2.4 — rollback (ADR-012 §4, §5 columns "rollback", §6)
// ---------------------------------------------------------------------------

/** Seeds of the T2.4 cells (R1: >= 10; ENGINE_QA_SEEDS replaces the list). */
const ROLLBACK_SEEDS = signatureSeeds('rollback')
/** Log message of a request served by the bad version (ADR-005 Emenda 1), written out. */
const UNHANDLED = 'unhandled exception'
/** Message of a crash-loop instance going down (ADR-005 Emenda 1), written out. */
const EXITED = 'process exited'

/** Runs `steps` and returns the simulation. */
function sequence(config: SimulationConfig, steps: readonly Step[]): Simulation {
  const sim = createSimulation(config)
  for (const step of steps) {
    if ('act' in step) sim.act(step.act)
    else sim.advance(step.advance)
  }
  return sim
}
const rb = (target: string): { act: Action } => ({ act: { kind: 'rollback', target } })
const logsWith = (sim: Simulation, component: string, message: string, fromTick: number, toTick: number) =>
  sim.telemetry().logsOf(component, fromTick, toTick).filter((l) => l.message === message)
const allLogsWith = (sim: Simulation, message: string, tick: number) => NAMES.flatMap((n) => logsWith(sim, n, message, tick, tick))
const deployNoise = (target: string, tick: number, note?: string): NoiseEvent => ({
  kind: 'deploy',
  target,
  tick,
  ...(note !== undefined ? { note } : {}),
})
/** An instance is down in a tick when its metric is zeroed (ADR-002 §5: rps, cpu and connections = 0). */
const isDownIn = (sim: Simulation, tick: number, instance: string): boolean => {
  const metric = recordsAt(sim, tick).find((r) => r.type === 'metric' && r.instance === instance)
  if (metric === undefined || metric.type !== 'metric') throw new Error(`no metric of ${instance} in ${tick}`)
  return metric.rps === 0 && metric.cpu === 0 && metric.connections === 0
}

describe('rollback without a batch (ADR-012 §4): nothing in the telemetry', () => {
  it('no deploy on the target (faults and deploys on others): byte-identical to not acting, every target, >= 10 seeds', () => {
    for (const seed of ROLLBACK_SEEDS) {
      const faults = faultsOf(seed, { kind: 'bad_deploy', target: 'cart', startTick: 3 })
      const noise = [deployNoise('auth', 2, 'copy change')]
      const plain = run(shop(seed, { faults, noise }), [{ advance: 12 }])
      for (const target of NAMES.filter((n) => n !== 'cart' && n !== 'auth')) {
        expect(run(shop(seed, { faults, noise }), [{ advance: 6 }, rb(target), { advance: 6 }])).toBe(plain)
      }
    }
  })

  it('a deploy after world.tick of act() is not history: the rollback finds nothing (byte-identical to not acting)', () => {
    for (const seed of ROLLBACK_SEEDS.slice(0, 3)) {
      // act() at tick 6, te = 7: the bad_deploy's deploy events are in te itself, not in [0, 6].
      const faults = faultsOf(seed, { kind: 'bad_deploy', target: 'cart', startTick: 7 })
      const acted = run(shop(seed, { faults }), [{ advance: 6 }, rb('cart'), { advance: 6 }])
      expect(acted).toBe(run(shop(seed, { faults }), [{ advance: 12 }]))
    }
  })

  it('latestRevertibleBatch: undefined before tick 0 and without deploys of the target', () => {
    const view = createSimulation(shop('lrb', { noise: [deployNoise('auth', 0)] })).telemetry()
    expect(latestRevertibleBatch('auth', -1, view)).toBeUndefined()
    expect(latestRevertibleBatch('cart', 0, view)).toBeUndefined()
    expect(latestRevertibleBatch('auth', 0, view)).toBe(0)
  })
})

describe('rollback of the bad_deploy batch (ADR-012 §5, "rollback no alvo"), >= 10 seeds', () => {
  const target = targetOf('bad_deploy')

  it('the fault ends in te = tick + 1: one deploy event without instance, no down, from te on the run without the fault', () => {
    for (const seed of ROLLBACK_SEEDS) {
      const faults = defaultFault(seed, 'bad_deploy')
      const acted = sequence(shop(seed, { faults }), [{ advance: ACT_AT }, rb(target), { advance: UNTIL - ACT_AT }])
      const withFault = plainRun(seed, faults)
      const noFault = plainRun(seed, [])
      // The fault really was there, before te and (without acting) after it: otherwise the cell proves nothing.
      expect(logsWith(withFault, target, UNHANDLED, TE, UNTIL).length).toBeGreaterThan(0)
      expect(logsWith(acted, target, UNHANDLED, START, ACT_AT).length).toBeGreaterThan(0)
      // Ended in te: no request hits the bad version from te on.
      expect(logsWith(acted, target, UNHANDLED, TE, UNTIL)).toEqual([])
      expect(from(acted, TE + 1)).toBe(from(noFault, TE + 1))
      // te: exactly one deploy event, no instance, no note, no config restart (rolling).
      expect(eventsAt(acted, TE)).toEqual([{ type: 'event', tick: TE, kind: 'deploy', target }])
      // te itself carries the traffic of the run without the fault: no down, only the event differs.
      const noEvents = (sim: Simulation) => toNdjson(recordsAt(sim, TE).filter((r) => r.type !== 'event'))
      expect(noEvents(acted)).toBe(noEvents(noFault))
      expect(allLogsWith(acted, 'connection refused', TE)).toEqual([])
      for (const instance of instancesOf(target)) expect(isDownIn(acted, TE, instance)).toBe(false)
    }
  })

  it('indirect signal (SPEC §3.4): the caller sees the bad catalog; rolling back the caller changes nothing, rolling back catalog clears the caller too', () => {
    for (const seed of ROLLBACK_SEEDS) {
      const faults = faultsOf(seed, { kind: 'bad_deploy', target: 'catalog', startTick: START })
      const steps = (t: string): Step[] => [{ advance: ACT_AT }, rb(t), { advance: UNTIL - ACT_AT }]
      const gateway = (sim: Simulation) =>
        toNdjson(sim.telemetry().all().filter((r) => r.tick > TE && 'component' in r && r.component === 'gateway'))
      const withFault = plainRun(seed, faults)
      const noFault = plainRun(seed, [])
      // The caller's telemetry carries the fault (retried failed attempts) without acting.
      expect(gateway(withFault)).not.toBe(gateway(noFault))
      // Rolling back the one who shows the symptom (gateway, no deploy there) changes nothing.
      expect(run(shop(seed, { faults }), steps('gateway'))).toBe(toNdjson(withFault.telemetry().all()))
      // Rolling back the culprit: the caller's view equals the one without the fault.
      expect(gateway(sequence(shop(seed, { faults }), steps('catalog')))).toBe(gateway(noFault))
    }
  })

  it('a deploy noise on the target after the bad_deploy: the 1st rollback does not resolve, the 2nd does', () => {
    for (const seed of ROLLBACK_SEEDS) {
      const faults = defaultFault(seed, 'bad_deploy')
      const noise = [deployNoise(target, START + 2, 'harmless copy change')]
      const sim = sequence(shop(seed, { faults, noise }), [{ advance: ACT_AT }, rb(target), { advance: 4 }, rb(target), { advance: 8 }])
      const te1 = TE
      const te2 = ACT_AT + 4 + 1
      // 1st rollback reverts the noise batch: the bad version keeps failing requests after te1.
      expect(eventsAt(sim, te1)).toEqual([{ type: 'event', tick: te1, kind: 'deploy', target }])
      expect(logsWith(sim, target, UNHANDLED, te1, te2 - 1).length).toBeGreaterThan(0)
      // 2nd rollback reverts the batch of the fault: nothing fails from te2 on.
      expect(eventsAt(sim, te2)).toEqual([{ type: 'event', tick: te2, kind: 'deploy', target }])
      expect(logsWith(sim, target, UNHANDLED, te2, sim.world.tick)).toEqual([])
    }
  })

  it('the deploy events of rollbacks are not revertible: once every batch is reverted, a rollback is byte-identical to not acting', () => {
    for (const seed of ROLLBACK_SEEDS) {
      const config = shop(seed, { faults: defaultFault(seed, 'bad_deploy'), noise: [deployNoise(target, START + 2)] })
      const base: Step[] = [{ advance: ACT_AT }, rb(target), { advance: 3 }, rb(target), { advance: 3 }]
      expect(run(config, [...base, rb(target), { advance: 4 }])).toBe(run(config, [...base, { advance: 4 }]))
      // Same with only the fault's batch: the 2nd rollback finds the 1st rollback's deploy only.
      const single = shop(seed, { faults: defaultFault(seed, 'bad_deploy') })
      const once: Step[] = [{ advance: ACT_AT }, rb(target), { advance: 3 }]
      expect(run(single, [...once, rb(target), { advance: 4 }])).toBe(run(single, [...once, { advance: 4 }]))
    }
  })

  it('two rollbacks before the same advance: the 1st reverts the latest batch, the 2nd the previous one, one deploy event each', () => {
    for (const seed of ROLLBACK_SEEDS.slice(0, 3)) {
      // Fault batch at START + 2 after a noise batch at START: the 1st rollback reverts the fault.
      const faults = faultsOf(seed, { kind: 'bad_deploy', target, startTick: START + 2 })
      const both = sequence(shop(seed, { faults, noise: [deployNoise(target, START)] }), [{ advance: ACT_AT }, rb(target), rb(target), { advance: 6 }])
      expect(eventsAt(both, TE)).toEqual([
        { type: 'event', tick: TE, kind: 'deploy', target },
        { type: 'event', tick: TE, kind: 'deploy', target },
      ])
      expect(logsWith(both, target, UNHANDLED, TE, both.world.tick)).toEqual([])
      expect(latestRevertibleBatch(target, both.world.tick, both.telemetry())).toBeUndefined()
    }
  })

  it('a noise deploy in the same tick as a rollback deploy is still a batch of its own (counted, not hidden by the tick)', () => {
    const seed = 'rb-same-tick'
    const faults = faultsOf(seed, { kind: 'bad_deploy', target: 'cart', startTick: START })
    const sim = sequence(shop(seed, { faults, noise: [deployNoise('cart', TE, 'same tick')] }), [{ advance: ACT_AT }, rb('cart'), { advance: 3 }])
    // te: the action event, then the noise (ADR-005 Emenda 3).
    expect(eventsAt(sim, TE)).toEqual([
      { type: 'event', tick: TE, kind: 'deploy', target: 'cart' },
      { type: 'event', tick: TE, kind: 'deploy', target: 'cart', note: 'same tick' },
    ])
    expect(latestRevertibleBatch('cart', sim.world.tick, sim.telemetry())).toBe(TE)
    sim.act(rb('cart').act)
    sim.advance(1)
    expect(eventsAt(sim, sim.world.tick)).toEqual([{ type: 'event', tick: sim.world.tick, kind: 'deploy', target: 'cart' }])
    expect(latestRevertibleBatch('cart', sim.world.tick, sim.telemetry())).toBeUndefined()
  })

  it('"rollback em outro": a batch reverted elsewhere leaves the bad_deploy intact', () => {
    for (const seed of ROLLBACK_SEEDS) {
      const faults = faultsOf(seed, { kind: 'bad_deploy', target: 'cart', startTick: START })
      const noise = [deployNoise('auth', START + 1)]
      const acted = sequence(shop(seed, { faults, noise }), [{ advance: ACT_AT }, rb('auth'), { advance: UNTIL - ACT_AT }])
      const plain = sequence(shop(seed, { faults, noise }), [{ advance: UNTIL }])
      expect(eventsAt(acted, TE)).toEqual([{ type: 'event', tick: TE, kind: 'deploy', target: 'auth' }])
      expect(logsWith(plain, 'cart', UNHANDLED, TE, UNTIL).length).toBeGreaterThan(0)
      expect(logsWith(acted, 'cart', UNHANDLED, TE, UNTIL)).toEqual(logsWith(plain, 'cart', UNHANDLED, TE, UNTIL))
    }
  })

  it('binding by startTick = batch tick: of two bad_deploy batches on the target, the rollback ends only the latest', () => {
    for (const seed of ROLLBACK_SEEDS.slice(0, 3)) {
      const faults = faultsOf(seed, { kind: 'bad_deploy', target, startTick: START }, { kind: 'bad_deploy', target, startTick: START + 2 })
      const one = sequence(shop(seed, { faults }), [{ advance: ACT_AT }, rb(target), { advance: UNTIL - ACT_AT }])
      expect(logsWith(one, target, UNHANDLED, TE, UNTIL).length).toBeGreaterThan(0)
      expect(from(one, TE + 1)).toBe(from(plainRun(seed, faults.slice(0, 1)), TE + 1))
    }
  })
})

describe('rollback with a batch = process replacement without unavailability (ADR-012 §4, §5)', () => {
  it('service_crash_loop on the target + deploy noise: the crash loop ends in te, no down of the action, one deploy event', () => {
    const target = targetOf('service_crash_loop')
    for (const seed of ROLLBACK_SEEDS) {
      const faults = defaultFault(seed, 'service_crash_loop')
      const noise = [deployNoise(target, 2)]
      const acted = sequence(shop(seed, { faults, noise }), [{ advance: ACT_AT }, rb(target), { advance: UNTIL - ACT_AT }])
      const noFault = sequence(shop(seed, { noise }), [{ advance: UNTIL }])
      expect(logsWith(plainRun(seed, faults), target, EXITED, TE, UNTIL).length).toBeGreaterThan(0)
      expect(logsWith(acted, target, EXITED, TE, UNTIL)).toEqual([])
      expect(eventsAt(acted, TE)).toEqual([{ type: 'event', tick: TE, kind: 'deploy', target }])
      expect(from(acted, TE + 1)).toBe(from(noFault, TE + 1))
    }
  })

  it('connection_pool_exhaustion on the target + deploy noise: reset in te like restart, but the target keeps serving in te', () => {
    const target = targetOf('connection_pool_exhaustion')
    for (const seed of ROLLBACK_SEEDS) {
      const config = shop(seed, { faults: defaultFault(seed, 'connection_pool_exhaustion'), noise: [deployNoise(target, 2)] })
      const rolled = sequence(config, [{ advance: ACT_AT }, rb(target), { advance: UNTIL - ACT_AT }])
      const restarted = sequence(config, [{ advance: ACT_AT }, { act: { kind: 'restart', target } }, { advance: UNTIL - ACT_AT }])
      const plain = sequence(config, [{ advance: UNTIL }])
      const conns = (sim: Simulation, tick: number) =>
        sim.telemetry().metricsOf(target, tick, tick).filter((m) => m.instance === undefined).map((m) => m.connections)
      expect(from(rolled, TE + 1)).not.toBe(from(plain, TE + 1))
      // No down of the action in te (the restart of the same run has one).
      for (const instance of instancesOf(target)) {
        expect(isDownIn(rolled, TE, instance)).toBe(false)
        expect(isDownIn(restarted, TE, instance)).toBe(true)
      }
      expect(allLogsWith(rolled, 'connection refused', TE)).toEqual([])
      // The same generation 1 as the restart: the leak starts over from zero in te.
      expect(conns(rolled, UNTIL)).toEqual(conns(restarted, UNTIL))
    }
  })

  it('disk_full on the target + deploy noise: one deploy event, the fault intact (nothing else changes)', () => {
    const target = targetOf('disk_full')
    for (const seed of ROLLBACK_SEEDS) {
      const config = shop(seed, { faults: defaultFault(seed, 'disk_full'), noise: [deployNoise(target, 2)] })
      const acted = sequence(config, [{ advance: ACT_AT }, rb(target), { advance: UNTIL - ACT_AT }])
      const plain = sequence(config, [{ advance: UNTIL }])
      expect(eventsAt(acted, TE)).toEqual([{ type: 'event', tick: TE, kind: 'deploy', target }])
      const noEvents = (sim: Simulation) => toNdjson(sim.telemetry().all().filter((r) => r.type !== 'event'))
      expect(noEvents(acted)).toBe(noEvents(plain))
    }
  })

  it('cache rule: rollback of redis with a batch = cold start (module events and down) plus the deploy event; without a batch nothing', () => {
    for (const seed of ROLLBACK_SEEDS.slice(0, 3)) {
      const acted = sequence(shop(seed, { noise: [deployNoise('redis', 2)] }), [{ advance: ACT_AT }, rb('redis'), { advance: 4 }])
      expect(eventsAt(acted, TE)).toEqual([...coldStartEvents('redis', TE), { type: 'event', tick: TE, kind: 'deploy', target: 'redis' }])
      expect(run(shop(seed), [{ advance: ACT_AT }, rb('redis'), { advance: 4 }])).toBe(run(shop(seed), [{ advance: ACT_AT + 4 }]))
    }
  })

  it('the history is per simulation: reverted batches of one run are never seen by another', () => {
    const config = shop('rb-iso', { faults: faultsOf('rb-iso', { kind: 'bad_deploy', target: 'cart', startTick: START }) })
    const a = sequence(config, [{ advance: ACT_AT }, rb('cart'), { advance: 2 }])
    const b = sequence(config, [{ advance: ACT_AT }, rb('cart'), { advance: 2 }])
    expect(toNdjson(a.telemetry().all())).toBe(toNdjson(b.telemetry().all()))
    const view: TelemetryView = b.telemetry()
    expect(latestRevertibleBatch('cart', b.world.tick, view)).toBeUndefined()
    const fresh = sequence(config, [{ advance: ACT_AT }])
    expect(latestRevertibleBatch('cart', fresh.world.tick, fresh.telemetry())).toBe(START)
  })
})

describe('DET with rollback: same seed + same act/advance sequence => identical NDJSON (SHA-256)', () => {
  it.each(faultKinds)('%s: rollbacks of its target around deploy noise, two runs, same SHA-256', (kind) => {
    for (const seed of ['det-rb-1', 'det-rb-2', 'det-rb-3']) {
      const target = targetOf(kind)
      const steps: Step[] = [{ advance: 8 }, rb(target), { advance: 3 }, rb(target), rb('redis'), { advance: 4 }, rb(target), { advance: 6 }]
      const config = shop(seed, { faults: faultsOf(seed, { kind, startTick: 5 }), noise: [deployNoise(target, 3), deployNoise('redis', 4)] })
      expect(sha(run(config, steps))).toBe(sha(run(config, steps)))
    }
  })
})
