/**
 * T1.15 — orchestrator: createSimulation / advance / simulate (ADR-002 §3–4, ADR-003, ADR-005;
 * PRD W-3, W-4, F-2, F-6 (composition), S-4, D-1, D-2, P-4).
 *
 * Coherence of the whole pipeline is checked with the independent verifier
 * scripts/verify-coherence.mjs (T1.13) over the serialized NDJSON, for the default-shop and for a
 * minimal 2 services + 1 dependency world.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError } from '../../src/errors.js'
import { faultRegistry } from '../../src/faults/registry.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { ask } from '../../src/questions/ask.js'
import { toNdjson } from '../../src/sim/serialize.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { MAX_TICKS, createSimulation, createSimulationWith, simulate, validateNoise } from '../../src/sim/simulation.js'
import { generateTraffic } from '../../src/sim/traffic.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import * as publicApi from '../../src/index.js'
import type {
  Fault,
  FaultModule,
  FaultRegistry,
  NoiseEvent,
  Question,
  SimulationConfig,
  SystemDefinition,
  TelemetryRecord,
  World,
} from '../../src/types.js'

// ask() is still the T1.1 stub (its body is T1.16); the orchestrator only has to call it with the
// question and one AskEnvironment per Simulation, so it is replaced by a recorder here.
vi.mock('../../src/questions/ask.js', () => ({
  ask: vi.fn((question: Question) => ({ question, data: { kind: 'whatChanged', from: 0, to: 0, events: [] }, tickCost: 1 })),
}))

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')
const tsx = join(pkgDir, 'node_modules', '.bin', 'tsx')

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const ndjson = (records: readonly TelemetryRecord[]) => toNdjson(records)

function verify(text: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [verifier], { input: text, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** W-3: a world unlike default-shop, 2 services + 1 dependency, built in the test. */
const minimal: SystemDefinition = {
  name: 'minimal',
  services: [
    {
      name: 'edge',
      replicas: 2,
      latencyP50Ms: 6,
      latencyP99Ms: 30,
      cpuBasePct: 2,
      cpuPerRequestPct: 1,
      memBaseMb: 128,
      ingress: { ratePerTick: 5, operation: 'http.request' },
      calls: [{ target: 'core', operation: 'core.run', ratio: 0.8, timeoutMs: 300, retries: 1 }],
      dbPoolSize: 4,
    },
    {
      name: 'core',
      replicas: 3,
      latencyP50Ms: 12,
      latencyP99Ms: 80,
      cpuBasePct: 3,
      cpuPerRequestPct: 0.5,
      memBaseMb: 200,
      calls: [{ target: 'ledger', operation: 'db.query', ratio: 1, timeoutMs: 150, retries: 1 }],
      dbPoolSize: 4,
    },
  ],
  deps: [
    { name: 'ledger', kind: 'database', replicas: 1, latencyP50Ms: 3, latencyP99Ms: 20, cpuBasePct: 5, cpuPerRequestPct: 0.2, memBaseMb: 512, maxConnections: 30 },
  ],
}

const RANK = { event: 0, span: 1, log: 2, metric: 3 } as const

function byTick(records: readonly TelemetryRecord[]): Map<number, TelemetryRecord[]> {
  const out = new Map<number, TelemetryRecord[]>()
  for (const r of records) {
    const list = out.get(r.tick)
    if (list) list.push(r)
    else out.set(r.tick, [r])
  }
  return out
}

/** Canonical NDJSON order of ADR-005, checked against the world. */
function expectCanonicalOrder(records: readonly TelemetryRecord[], world: World, ticks: number) {
  let lastTick = -1
  for (const r of records) {
    expect(r.tick).toBeGreaterThanOrEqual(lastTick)
    lastTick = r.tick
  }
  const ticksSeen = byTick(records)
  expect([...ticksSeen.keys()]).toEqual(Array.from({ length: ticks }, (_, i) => i))
  const expectedMetricKeys = [...world.services, ...world.deps].flatMap((c) => [...c.instances.map((i) => `${c.name}/${i}`), `${c.name}/*`])
  for (const list of ticksSeen.values()) {
    const ranks = list.map((r) => RANK[r.type])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    const metricKeys = list.flatMap((r) => (r.type === 'metric' ? [`${r.component}/${r.instance ?? '*'}`] : []))
    expect(metricKeys).toEqual(expectedMetricKeys)
  }
}

// --- test fault modules -----------------------------------------------------------------------

const calls = { activate: 0, beforeStart: 0 }

/**
 * Fake fault: picks one instance of the target from its own stream, deploys it at startTick,
 * slows and sometimes fails it (own stream per request), makes its database calls wait, raises
 * its cpu and caps its connections, and logs a warning every tick.
 */
const spiky: FaultModule = {
  kind: 'service_crash_loop',
  activate(fault, world, rng) {
    calls.activate += 1
    const target = [...world.services, ...world.deps].find((c) => c.name === fault.target)!
    const picked = rng('pick').pick(target.instances)
    const databases = new Set(world.deps.filter((d) => d.kind === 'database').map((d) => d.name))
    const gate = (tick: number) => {
      if (tick < fault.startTick) calls.beforeStart += 1
    }
    return {
      onTick: ({ tick }) => {
        gate(tick)
        return {
          ...(tick === fault.startTick ? { events: [{ kind: 'deploy' as const, target: fault.target, instance: picked }] } : {}),
          logs: [{ component: fault.target, instance: picked, level: 'warn' as const, message: 'fault tick', attrs: { tick } }],
        }
      },
      onServe: ({ tick, component, instance, traceId }) => {
        gate(tick)
        if (component !== fault.target || instance !== picked) return undefined
        const r = rng(tick, traceId)
        return { addLatencyMs: 50 + r.int(0, 10), ...(r.chance(0.3) ? { fail: { message: 'fault failure' } } : {}) }
      },
      onCall: ({ tick, caller, target: callee }) => {
        gate(tick)
        return caller === fault.target && databases.has(callee) ? { waitMs: 20, waitOperation: 'db.acquire' } : undefined
      },
      onResources: ({ tick, instance }) => {
        gate(tick)
        return instance === picked ? { cpuPctAdd: 20, connectionsCap: 1 } : undefined
      },
    }
  },
}

/** Fake fault: takes one instance of the target down every tick and emits a restart event. */
const downer: FaultModule = {
  kind: 'bad_deploy',
  activate(fault, world) {
    const target = [...world.services, ...world.deps].find((c) => c.name === fault.target)!
    const victim = target.instances[target.instances.length - 1]!
    return {
      onTick: ({ tick }) => ({
        down: [victim],
        ...(tick === fault.startTick ? { events: [{ kind: 'config' as const, target: fault.target, restart: true as const }] } : {}),
      }),
    }
  },
}

const registry = { ...faultRegistry, service_crash_loop: spiky, bad_deploy: downer } as FaultRegistry

function faultsFor(system: SystemDefinition, inputs: { kind: Fault['kind']; target: string; startTick: number }[]): Fault[] {
  return resolveFaults(inputs, buildWorld(system, 'resolve'))
}

const run = (config: SimulationConfig, ticks: number): TelemetryRecord[] => {
  const sim = createSimulationWith(config, { registry })
  sim.advance(ticks - 1)
  return [...sim.telemetry().all()]
}

beforeEach(() => {
  calls.activate = 0
  calls.beforeStart = 0
  vi.mocked(ask).mockClear()
})

// --- tests ------------------------------------------------------------------------------------

describe('createSimulation / advance / simulate (ADR-002 §3)', () => {
  it('createSimulation simulates tick 0', () => {
    const sim = createSimulation({ system: defaultShop, seed: 's' })
    expect(sim.world.tick).toBe(0)
    expect(sim.telemetry().now).toBe(0)
    const all = sim.telemetry().all()
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((r) => r.tick === 0)).toBe(true)
    expect(all.some((r) => r.type === 'span')).toBe(true)
    expect(all.some((r) => r.type === 'metric')).toBe(true)
  })

  it('advance accumulates and returns only the new ticks', () => {
    const sim = createSimulation({ system: defaultShop, seed: 's' })
    const before = sim.telemetry().all().length
    const a = sim.advance()
    expect(new Set(a.map((r) => r.tick))).toEqual(new Set([1]))
    const b = sim.advance(3)
    expect(new Set(b.map((r) => r.tick))).toEqual(new Set([2, 3, 4]))
    expect(sim.world.tick).toBe(4)
    expect(sim.telemetry().now).toBe(4)
    expect(sim.telemetry().world.tick).toBe(4)
    expect(sim.telemetry().all().length).toBe(before + a.length + b.length)
    expect(sim.telemetry().all().slice(before)).toEqual([...a, ...b])
    expect(sim.advance(0)).toEqual([])
    expect(sim.world.tick).toBe(4)
  })

  it('simulate(cfg, n) = ticks [0, n), equal to createSimulation + advance(n - 1)', () => {
    const cfg = { system: defaultShop, seed: 'eq' }
    const records = simulate(cfg, 12)
    expect(new Set(records.map((r) => r.tick))).toEqual(new Set(Array.from({ length: 12 }, (_, i) => i)))
    const sim = createSimulation(cfg)
    sim.advance(11)
    expect(ndjson(records)).toBe(ndjson(sim.telemetry().all()))
    // Advancing in other step sizes gives the same telemetry.
    const steps = createSimulation(cfg)
    for (const n of [1, 4, 0, 6]) steps.advance(n)
    expect(ndjson(steps.telemetry().all())).toBe(ndjson(records))
    expect(simulate(cfg, 1).every((r) => r.tick === 0)).toBe(true)
  })

  it('rejects invalid tick counts with EngineError(invalid_ticks)', () => {
    const sim = createSimulation({ system: defaultShop, seed: 's' })
    for (const bad of [-1, 1.5, Number.NaN, MAX_TICKS + 1, '2' as unknown as number]) {
      expect(() => sim.advance(bad)).toThrow(EngineError)
    }
    for (const bad of [0, -3, 2.5, MAX_TICKS + 1]) {
      try {
        simulate({ system: defaultShop, seed: 's' }, bad)
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError)
        expect((e as EngineError).code).toBe('invalid_ticks')
        expect((e as EngineError).message).toContain('ticks')
      }
    }
  })

  it('rejects invalid config, system, seed and faults with EngineError', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError)
        return (e as EngineError).code
      }
      return 'no error'
    }
    expect(codeOf(() => createSimulation(null as unknown as SimulationConfig))).toBe('invalid_system')
    expect(codeOf(() => createSimulation({ system: defaultShop, seed: '' }))).toBe('invalid_seed')
    expect(codeOf(() => createSimulation({ system: { name: 'x', services: [], deps: [] }, seed: 's' }))).toBe('invalid_system')
    expect(codeOf(() => createSimulation({ system: defaultShop, seed: 's', faults: {} as unknown as Fault[] }))).toBe('invalid_system')
    const bad: Fault = { kind: 'disk_full', target: 'nowhere', startTick: 1, params: {} }
    expect(codeOf(() => createSimulation({ system: defaultShop, seed: 's', faults: [bad] }))).toBe('unknown_target')
    expect(codeOf(() => createSimulation({ system: defaultShop, seed: 's', faults: [{ ...bad, target: 'postgres', startTick: -1 }] }))).toBe(
      'invalid_start_tick',
    )
  })

  it('the world snapshot is frozen and inputs are copied (mutating them later changes nothing)', () => {
    const system = structuredClone(minimal)
    const noise: NoiseEvent[] = [{ kind: 'deploy', target: 'core', tick: 2, note: 'n' }]
    const sim = createSimulation({ system, seed: 'copy', noise })
    system.services[0]!.ingress!.ratePerTick = 50
    noise[0]!.tick = 1
    noise.push({ kind: 'config', target: 'edge', tick: 1 })
    sim.advance(4)
    expect(ndjson(sim.telemetry().all())).toBe(ndjson(simulate({ system: minimal, seed: 'copy', noise: [{ kind: 'deploy', target: 'core', tick: 2, note: 'n' }] }, 5)))
    expect(Object.isFrozen(sim.world)).toBe(true)
    expect(Object.isFrozen(sim.world.services[0])).toBe(true)
    expect(() => {
      ;(sim.world as { tick: number }).tick = 99
    }).toThrow(TypeError)
  })

  it('ask() is forwarded with one AskEnvironment per Simulation (same object on every call)', () => {
    const cfg = { system: defaultShop, seed: 'ask', noise: [{ kind: 'deploy' as const, target: 'catalog', tick: 1 }] }
    const sim = createSimulation(cfg)
    const q1: Question = { kind: 'whatChanged', window: 5 }
    const q2: Question = { kind: 'dashboard', service: 'payment' }
    expect(sim.ask(q1).question).toBe(q1)
    sim.advance(2)
    sim.ask(q2)
    const mocked = vi.mocked(ask)
    expect(mocked).toHaveBeenCalledTimes(2)
    const [[a1, env1], [a2, env2]] = mocked.mock.calls as unknown as [[Question, { view: unknown; config: SimulationConfig }], [Question, { view: unknown; config: SimulationConfig }]]
    expect(a1).toBe(q1)
    expect(a2).toBe(q2)
    expect(env1).toBe(env2)
    expect(env1.view).toBe(sim.telemetry())
    expect(env1.config.seed).toBe('ask')
    expect(env1.config.system).toEqual(defaultShop)
    expect(env1.config.faults).toEqual([])
    expect(env1.config.noise).toEqual(cfg.noise)
    // A second simulation gets its own environment.
    createSimulation(cfg).ask(q1)
    expect(mocked.mock.calls[2]![1]).not.toBe(env1)
  })

  it('the view handed to ask() is read-only: no appendTick, reads delegate to the store', () => {
    const sim = createSimulation({ system: minimal, seed: 'view' })
    sim.advance(3)
    const view = sim.telemetry()
    expect('appendTick' in view).toBe(false)
    const all = view.all()
    expect(view.metricsOf('core', 0, 3)).toEqual(all.filter((r) => r.type === 'metric' && r.component === 'core'))
    expect(view.logsOf('edge', 1, 2)).toEqual(all.filter((r) => r.type === 'log' && r.component === 'edge' && r.tick >= 1 && r.tick <= 2))
    const spans = view.spansOf('edge', 2)
    expect(spans).toEqual(all.filter((r) => r.type === 'span' && r.component === 'edge' && r.tick === 2))
    expect(view.traceOf(spans[0]!.traceId)).toEqual(all.filter((r) => r.type === 'span' && r.traceId === spans[0]!.traceId))
    expect(view.eventsIn(0, 3)).toEqual([])
  })
})

describe('canonical order and pipeline (ADR-005, ADR-002 §3)', () => {
  it('records per tick: events, spans, logs, metrics; metrics in world order (default-shop)', () => {
    const cfg = { system: defaultShop, seed: 'order', noise: [{ kind: 'config' as const, target: 'redis', tick: 3 }] }
    const records = simulate(cfg, 10)
    expectCanonicalOrder(records, buildWorld(defaultShop, 'order'), 10)
  })

  it('baseline spans of each tick are exactly generateTraffic of that tick with the root factory', () => {
    const records = simulate({ system: defaultShop, seed: 'traffic' }, 5)
    const world = buildWorld(defaultShop, 'traffic')
    for (let tick = 0; tick < 5; tick++) {
      const expected = generateTraffic({ world: { ...world, tick }, tick, rng: createRngFactory('traffic'), down: new Set(), hooks: {} }).spans
      expect(records.filter((r) => r.type === 'span' && r.tick === tick)).toEqual(expected)
    }
  })

  it('with faults: fault events then noise events; fault logs before request logs', () => {
    const faults = faultsFor(minimal, [
      { kind: 'service_crash_loop', target: 'core', startTick: 2 },
      { kind: 'bad_deploy', target: 'edge', startTick: 2 },
    ])
    const noise: NoiseEvent[] = [
      { kind: 'deploy', target: 'edge', tick: 2, note: 'noise a' },
      { kind: 'config', target: 'core', tick: 2, instance: 'core-1' },
    ]
    const records = run({ system: minimal, seed: 'order', faults, noise }, 6)
    expectCanonicalOrder(records, buildWorld(minimal, 'order'), 6)
    const events = records.filter((r) => r.type === 'event')
    expect(events.map((e) => [e.tick, e.kind, e.target, e.note ?? null])).toEqual([
      [2, 'deploy', 'core', null],
      [2, 'config', 'edge', null],
      [2, 'deploy', 'edge', 'noise a'],
      [2, 'config', 'core', null],
    ])
    expect(events[1]).toEqual({ type: 'event', tick: 2, kind: 'config', target: 'edge', restart: true })
    expect(events[3]).toEqual({ type: 'event', tick: 2, kind: 'config', target: 'core', instance: 'core-1' })
    for (let tick = 2; tick < 6; tick++) {
      const logs = records.filter((r) => r.type === 'log' && r.tick === tick)
      expect(logs[0]).toMatchObject({ level: 'warn', message: 'fault tick', component: 'core', attrs: { tick } })
      expect(logs.slice(1).every((l) => l.type === 'log' && l.message !== 'fault tick')).toBe(true)
    }
  })
})

describe('W-3 — arbitrary world (2 services + 1 dependency, 30 ticks)', () => {
  it('only the components of that world appear in the telemetry, and it is coherent (P-4)', () => {
    for (const seed of ['w3-a', 'w3-b', 'w3-c']) {
      const records = simulate({ system: minimal, seed }, 30)
      const names = new Set<string>()
      for (const r of records) {
        if (r.type === 'event') names.add(r.target)
        else names.add(r.component)
        if (r.type === 'span' && r.peer !== undefined) names.add(r.peer)
      }
      expect([...names].sort()).toEqual(['core', 'edge', 'ledger'])
      expect(records.every((r) => Number.isInteger(r.tick) && r.tick >= 0 && r.tick < 30)).toBe(true)
      expectCanonicalOrder(records, buildWorld(minimal, seed), 30)
      const result = verify(ndjson(records))
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
    }
  })
})

describe('coherence of the whole pipeline (P-1/P-2/P-3/S-3 via verify-coherence.mjs)', () => {
  const seeds = Array.from({ length: 4 }, (_, i) => `coh-${i}`)

  it.each(seeds)('default-shop baseline, seed %s, 30 ticks', (seed) => {
    const result = verify(ndjson(simulate({ system: defaultShop, seed }, 30)))
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it.each(seeds)('default-shop with composed test faults (errors, waits, down) and noise, seed %s', (seed) => {
    const faults = faultsFor(defaultShop, [
      { kind: 'service_crash_loop', target: 'payment', startTick: 5 },
      { kind: 'bad_deploy', target: 'catalog', startTick: 8 },
    ])
    const records = run({ system: defaultShop, seed, faults, noise: [{ kind: 'deploy', target: 'cart', tick: 4 }] }, 30)
    expect(records.some((r) => r.type === 'span' && r.status === 'error')).toBe(true)
    expect(records.some((r) => r.type === 'span' && r.operation === 'db.acquire')).toBe(true)
    const result = verify(ndjson(records))
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('minimal world with composed test faults', () => {
    const faults = faultsFor(minimal, [
      { kind: 'service_crash_loop', target: 'core', startTick: 3 },
      { kind: 'bad_deploy', target: 'core', startTick: 6 },
    ])
    const result = verify(ndjson(run({ system: minimal, seed: 'min-f', faults }, 30)))
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

describe('F-2 — gating by startTick with a test FaultModule', () => {
  const START = 10
  const faults = faultsFor(defaultShop, [{ kind: 'service_crash_loop', target: 'payment', startTick: START }])

  it('records before startTick are byte-identical to the baseline; from startTick on they differ', () => {
    const baseline = byTick(simulate({ system: defaultShop, seed: 'f2' }, 20))
    const faulted = byTick(run({ system: defaultShop, seed: 'f2', faults }, 20))
    for (let tick = 0; tick < START; tick++) expect(ndjson(faulted.get(tick)!)).toBe(ndjson(baseline.get(tick)!))
    expect(ndjson(faulted.get(START)!)).not.toBe(ndjson(baseline.get(START)!))
    expect(faulted.get(START)![0]).toMatchObject({ type: 'event', kind: 'deploy', target: 'payment' })
    expect(calls.activate).toBe(1)
    expect(calls.beforeStart).toBe(0)
  })

  it('the fault effect is visible in its own signals (latency, wait spans, cpu)', () => {
    const records = run({ system: defaultShop, seed: 'f2', faults }, 16)
    const event = records.find((r) => r.type === 'event')!
    expect(event.type === 'event' && event.instance).toMatch(/^payment-\d$/)
    const picked = event.type === 'event' ? event.instance! : ''
    expect(records.some((r) => r.type === 'span' && r.tick >= START && r.operation === 'db.acquire' && r.component === 'payment')).toBe(true)
    expect(records.some((r) => r.type === 'span' && r.tick < START && r.operation === 'db.acquire')).toBe(false)
    const cpu = (tick: number) => records.find((r) => r.type === 'metric' && r.tick === tick && r.instance === picked)
    expect(cpu(START)).toMatchObject({ connections: expect.any(Number) })
    expect((cpu(START) as { connections: number }).connections).toBeLessThanOrEqual(1)
  })

  it('a down instance (from onTick) serves nothing and reports zero cpu', () => {
    const f = faultsFor(minimal, [{ kind: 'bad_deploy', target: 'core', startTick: 4 }])
    const records = run({ system: minimal, seed: 'down', faults: f }, 10)
    expect(records.some((r) => r.type === 'span' && r.instance === 'core-2' && r.kind === 'server' && r.tick < 4)).toBe(true)
    expect(records.some((r) => r.type === 'span' && r.instance === 'core-2' && r.kind === 'server' && r.tick >= 4)).toBe(false)
    expect(
      records.filter((r) => r.type === 'metric' && r.instance === 'core-2' && r.tick >= 4).every((m) => m.type === 'metric' && m.cpu === 0 && m.rps === 0),
    ).toBe(true)
    expect(records.some((r) => r.type === 'log' && r.level === 'error' && r.message === 'connection refused')).toBe(true)
  })

  it('the real registry is the default (no-op stubs today: faulted run = baseline)', () => {
    const real = resolveFaults([{ kind: 'disk_full' }], buildWorld(defaultShop, 'x'))
    expect(ndjson(simulate({ system: defaultShop, seed: 'stub', faults: real }, 8))).toBe(ndjson(simulate({ system: defaultShop, seed: 'stub' }, 8)))
  })
})

describe('F-6 — several faults are composed (ADR-002 §4)', () => {
  it('two faults on different targets both act, and the run is deterministic', () => {
    const faults = faultsFor(minimal, [
      { kind: 'service_crash_loop', target: 'edge', startTick: 2 },
      { kind: 'bad_deploy', target: 'core', startTick: 4 },
    ])
    const cfg = { system: minimal, seed: 'f6', faults }
    const a = run(cfg, 12)
    expect(ndjson(run(cfg, 12))).toBe(ndjson(a))
    expect(a.filter((r) => r.type === 'event').map((e) => e.type === 'event' && e.target)).toEqual(['edge', 'core'])
    expect(a.some((r) => r.type === 'span' && r.instance === 'core-2' && r.kind === 'server' && r.tick >= 4)).toBe(false)
    expect(a.some((r) => r.type === 'log' && r.message === 'fault tick' && r.component === 'edge')).toBe(true)
  })

  it('a fault does not change what another fault does with its own streams', () => {
    const one = faultsFor(defaultShop, [{ kind: 'service_crash_loop', target: 'payment', startTick: 3 }])
    const two = faultsFor(defaultShop, [
      { kind: 'service_crash_loop', target: 'payment', startTick: 3 },
      { kind: 'service_crash_loop', target: 'cart', startTick: 3 },
    ])
    const deployOf = (records: TelemetryRecord[]) => records.find((r) => r.type === 'event' && r.target === 'payment')
    expect(deployOf(run({ system: defaultShop, seed: 'iso', faults: two }, 5))).toEqual(deployOf(run({ system: defaultShop, seed: 'iso', faults: one }, 5)))
  })

  it('the same kind twice gets distinct streams (fault index is part of the key)', () => {
    const picks = new Set<string>()
    for (const seed of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']) {
      const faults = faultsFor(defaultShop, [
        { kind: 'service_crash_loop', target: 'payment', startTick: 1 },
        { kind: 'service_crash_loop', target: 'payment', startTick: 1 },
      ])
      const events = run({ system: defaultShop, seed, faults }, 2).filter((r) => r.type === 'event')
      picks.add(events.map((e) => (e.type === 'event' ? e.instance : '')).join('|'))
    }
    expect(picks.size).toBeGreaterThan(1)
  })
})

describe('S-4 — noise only produces events', () => {
  const noise: NoiseEvent[] = [
    { kind: 'deploy', target: 'catalog', tick: 4, note: 'harmless frontend copy change' },
    { kind: 'config', target: 'postgres', tick: 7, instance: 'postgres-0' },
  ]

  it('telemetry without event records is byte-identical to a run without noise', () => {
    for (const seed of ['s4-a', 's4-b']) {
      const withNoise = simulate({ system: defaultShop, seed, noise }, 15)
      const without = simulate({ system: defaultShop, seed }, 15)
      expect(ndjson(withNoise.filter((r) => r.type !== 'event'))).toBe(ndjson(without))
      expect(withNoise.filter((r) => r.type === 'event')).toEqual([
        { type: 'event', tick: 4, kind: 'deploy', target: 'catalog', note: 'harmless frontend copy change' },
        { type: 'event', tick: 7, kind: 'config', target: 'postgres', instance: 'postgres-0' },
      ])
    }
  })

  it('noise after the last simulated tick is not emitted (yet); it is emitted when reached', () => {
    const sim = createSimulation({ system: defaultShop, seed: 'late', noise: [{ kind: 'deploy', target: 'auth', tick: 5 }] })
    sim.advance(3)
    expect(sim.telemetry().eventsIn(0, 3)).toEqual([])
    const more = sim.advance(2)
    expect(more.filter((r) => r.type === 'event')).toEqual([{ type: 'event', tick: 5, kind: 'deploy', target: 'auth' }])
  })

  it('invalid noise is rejected with EngineError(invalid_noise) naming the field', () => {
    const world = buildWorld(defaultShop, 'n')
    const cases: [unknown, string][] = [
      [{}, 'noise'],
      [[null], 'noise[0]'],
      [[[1]], 'noise[0]'],
      [[{ kind: 'restart', target: 'auth', tick: 1 }], 'noise[0].kind'],
      [[{ kind: 'deploy', target: 'nope', tick: 1 }], 'noise[0].target'],
      [[{ kind: 'deploy', target: 'auth', tick: -1 }], 'noise[0].tick'],
      [[{ kind: 'deploy', target: 'auth', tick: 1.5 }], 'noise[0].tick'],
      [[{ kind: 'deploy', target: 'auth', tick: '1' }], 'noise[0].tick'],
      [[{ kind: 'deploy', target: 'auth', tick: 1, instance: 'cart-0' }], 'noise[0].instance'],
      [[{ kind: 'deploy', target: 'auth', tick: 1, note: 3 }], 'noise[0].note'],
    ]
    for (const [input, field] of cases) {
      try {
        validateNoise(input, world)
        expect.unreachable(field)
      } catch (e) {
        expect(e).toBeInstanceOf(EngineError)
        expect((e as EngineError).code).toBe('invalid_noise')
        expect((e as EngineError).field).toBe(field)
        expect((e as EngineError).message).toContain(field)
      }
    }
    expect(() => createSimulation({ system: defaultShop, seed: 's', noise: [{ kind: 'deploy', target: 'x', tick: 0 }] })).toThrow(/noise\[0\]\.target.*gateway/)
  })

  it('valid noise is normalized (unknown keys dropped)', () => {
    const world = buildWorld(defaultShop, 'n')
    expect(validateNoise(undefined, world)).toEqual([])
    expect(validateNoise([{ note: 'n', tick: 2, target: 'auth', kind: 'config', extra: 1 }], world)).toEqual([
      { kind: 'config', target: 'auth', tick: 2, note: 'n' },
    ])
  })
})

describe('DET — same seed and config => byte-identical NDJSON', () => {
  it('two in-process runs give the same hash; different seeds give different hashes', () => {
    const a = sha(ndjson(simulate({ system: defaultShop, seed: 'det' }, 40)))
    expect(sha(ndjson(simulate({ system: defaultShop, seed: 'det' }, 40)))).toBe(a)
    expect(sha(ndjson(simulate({ system: defaultShop, seed: 'det2' }, 40)))).not.toBe(a)
    const f = faultsFor(defaultShop, [{ kind: 'service_crash_loop', target: 'payment', startTick: 5 }])
    expect(sha(ndjson(run({ system: defaultShop, seed: 'det', faults: f }, 40)))).toBe(sha(ndjson(run({ system: defaultShop, seed: 'det', faults: f }, 40))))
  })

  it('separate processes with different TZ/LANG give the same hash as in-process (D-1, D-2)', () => {
    const code = [
      "import { createHash } from 'node:crypto'",
      "import { simulate, toNdjson, defaultShop } from './src/index.ts'",
      "const noise = [{ kind: 'deploy', target: 'catalog', tick: 3, note: 'n' }]",
      "process.stdout.write(createHash('sha256').update(toNdjson(simulate({ system: defaultShop, seed: 'proc', noise }, 30))).digest('hex'))",
    ].join('\n')
    const hashIn = (env: Record<string, string>) => {
      const r = spawnSync(tsx, ['--eval', code], { cwd: pkgDir, encoding: 'utf8', env: { ...process.env, ...env } })
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
      return r.stdout
    }
    const utc = hashIn({ TZ: 'UTC', LANG: 'C', LC_ALL: 'C' })
    const tokyo = hashIn({ TZ: 'Asia/Tokyo', LANG: 'pt_BR.UTF-8', LC_ALL: 'pt_BR.UTF-8' })
    expect(utc).toMatch(/^[0-9a-f]{64}$/)
    expect(tokyo).toBe(utc)
    const local = sha(ndjson(simulate({ system: defaultShop, seed: 'proc', noise: [{ kind: 'deploy', target: 'catalog', tick: 3, note: 'n' }] }, 30)))
    expect(local).toBe(utc)
  }, 60_000)
})

describe('public API (src/index.ts)', () => {
  it('exports the runtime values of the simulation API', () => {
    expect(publicApi.createSimulation).toBe(createSimulation)
    expect(publicApi.simulate).toBe(simulate)
    expect(typeof publicApi.serializeRecord).toBe('function')
    expect(typeof publicApi.toNdjson).toBe('function')
    expect(publicApi.resolveFaults).toBe(resolveFaults)
    expect(publicApi.EngineError).toBe(EngineError)
    expect(typeof publicApi.isEngineError).toBe('function')
    expect(publicApi.defaultShop).toBe(defaultShop)
    expect(publicApi.faultKinds).toHaveLength(6)
  })

  it('does not leak internals (SPI, test seams)', () => {
    const names = Object.keys(publicApi)
    for (const internal of ['createSimulationWith', 'generateTraffic', 'deriveMetrics', 'generateLogs', 'createTelemetryStore', 'composeHooks', 'faultRegistry', 'ask']) {
      expect(names).not.toContain(internal)
    }
  })
})

describe('onResources wiring (ADR-002 §3 step 4; issue #29)', () => {
  const START = 3
  const seen: { tick: number; component: string; instance: string }[] = []
  /** Fake fault: a resource effect on one instance of the target, nothing else. */
  const resourcer: FaultModule = {
    kind: 'slow_dependency',
    activate(fault) {
      return {
        onResources: (ctx) => {
          seen.push({ ...ctx })
          if (ctx.component !== fault.target || ctx.instance !== `${fault.target}-1`) return undefined
          return { cpuPctAdd: 30, memMbAdd: 100, connectionsAdd: 50, connectionsCap: 7 }
        },
      }
    },
  }
  const withResources = { ...faultRegistry, slow_dependency: resourcer } as FaultRegistry
  const resFaults = faultsFor(minimal, [{ kind: 'slow_dependency', target: 'core', startTick: START }])
  const runWith = (ticks: number) => {
    const sim = createSimulationWith({ system: minimal, seed: 'res', faults: resFaults }, { registry: withResources })
    sim.advance(ticks - 1)
    return [...sim.telemetry().all()]
  }
  type Metric = Extract<TelemetryRecord, { type: 'metric' }>
  const metric = (records: readonly TelemetryRecord[], component: string, tick: number, instance?: string): Metric =>
    records.find((r) => r.type === 'metric' && r.component === component && r.tick === tick && r.instance === instance) as Metric

  it('is called once per instance of every component, in world order, only from startTick on', () => {
    seen.length = 0
    runWith(6)
    const world = buildWorld(minimal, 'res')
    const order = [...world.services, ...world.deps].flatMap((c) => c.instances.map((instance) => ({ component: c.name, instance })))
    expect(seen).toEqual([START, START + 1, START + 2].flatMap((tick) => order.map((o) => ({ tick, ...o }))))
  })

  it('the returned effect reaches the metrics of that instance (and of its database), nothing else', () => {
    const faulted = runWith(8)
    const base = simulate({ system: minimal, seed: 'res' }, 8)
    const spans = (rs: readonly TelemetryRecord[]) => ndjson(rs.filter((r) => r.type === 'span'))
    expect(spans(faulted)).toBe(spans(base))
    for (let tick = 0; tick < 8; tick++) {
      const f = metric(faulted, 'core', tick, 'core-1')
      const b = metric(base, 'core', tick, 'core-1')
      if (tick < START) {
        expect(f).toEqual(b)
        continue
      }
      expect(f.cpu - b.cpu).toBeGreaterThan(29.8)
      expect(f.cpu - b.cpu).toBeLessThan(30.2)
      expect(f.mem - b.mem).toBeGreaterThan(99.8)
      expect(f.mem - b.mem).toBeLessThan(100.2)
      expect(f.connections).toBe(7)
      expect(metric(faulted, 'ledger', tick).connections).toBe(metric(base, 'ledger', tick).connections - b.connections + 7)
      for (const other of ['core-0', 'core-2']) expect(metric(faulted, 'core', tick, other)).toEqual(metric(base, 'core', tick, other))
      expect(metric(faulted, 'edge', tick, 'edge-0')).toEqual(metric(base, 'edge', tick, 'edge-0'))
    }
  })
})

