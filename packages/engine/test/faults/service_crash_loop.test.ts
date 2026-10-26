/**
 * T1.17, T1.34 — fault `service_crash_loop` (ADR-004 and its Emenda 2; PRD F-1, F-2, F-3 row 1,
 * F-4; DET).
 *
 * Signature assertions read window means (signature window = ticks startTick+6 .. startTick+11)
 * over the seeds of `signatureSeeds` with the aggregation rule R1–R5 of PRD Emenda 2, through the
 * T1.33 helper: size-of-effect conditions on the mean (R2) and with a 75% floor in every seed (R3),
 * existence conditions in every seed (R4). Never per-trace or per-instance equality against the
 * baseline while the fault is active (ADR-003 §8). QA can repeat the run with another seed list
 * through ENGINE_QA_SEEDS (R1).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { faultCatalog } from '../../src/faults/catalog.js'
import { faultRegistry } from '../../src/faults/registry.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { EXIT_CODES, PROCESS_EXITED, crashCount, serviceCrashLoop } from '../../src/faults/service_crash_loop.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { serializeRecord, toNdjson } from '../../src/sim/serialize.js'
import { simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type { FaultInput, LogRecord, MetricRecord, SystemDefinition, TelemetryRecord, TickEffect } from '../../src/types.js'
import { assertEligibleF4, assertPass, effect, everySeed, signatureSeeds, signatureWindow, windowMean } from '../support/signature.js'

const KIND = 'service_crash_loop'
const START = faultCatalog[KIND].defaultStartTick
const TARGET = faultCatalog[KIND].defaultTarget
const WINDOW = signatureWindow(START)
const TICKS = START + 12
const SEEDS = signatureSeeds('crash')

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function run(seed: string, inputs: readonly FaultInput[] = [{ kind: KIND }], ticks = TICKS, system: SystemDefinition = defaultShop) {
  const faults = resolveFaults(inputs, buildWorld(system, seed))
  return simulate({ system, seed, faults }, ticks)
}

const baseline = (seed: string, ticks = TICKS, system: SystemDefinition = defaultShop) => simulate({ system, seed }, ticks)

const aggregate = (records: readonly TelemetryRecord[], component: string, tick: number): MetricRecord => {
  const m = records.find((r): r is MetricRecord => r.type === 'metric' && r.component === component && r.instance === undefined && r.tick === tick)
  if (m === undefined) throw new Error(`no aggregate metric for ${component} at ${tick}`)
  return m
}

const downOf = (effect: TickEffect | undefined): string[] => effect?.down ?? []

describe('crashCount (closed form)', () => {
  it('matches a tick-by-tick count for every phase, uptime and period', () => {
    for (let up = 1; up <= 4; up++) {
      for (let restart = 1; restart <= 4; restart++) {
        const period = up + restart
        for (let phase = 0; phase < period; phase++) {
          let count = 0
          let wasUp = true
          for (let s = 0; s < 40; s++) {
            const isUp = (s + phase) % period < up
            if (!isUp && (s === 0 || wasUp)) count += 1
            wasUp = isUp
            expect(crashCount(s, phase, up, period)).toBe(count)
          }
        }
      }
    }
  })
})

describe('module semantics (ADR-004)', () => {
  const world = buildWorld(defaultShop, 'sem')
  const [fault] = resolveFaults([{ kind: KIND }], world)

  it('is the registered module of its kind', () => {
    expect(faultRegistry[KIND]).toBe(serviceCrashLoop)
    expect(serviceCrashLoop.kind).toBe(KIND)
  })

  it('with the defaults every instance is up uptimeTicks per cycle and >= 1 instance is down in every tick', () => {
    const { uptimeTicks, restartTicks } = fault!.params as { uptimeTicks: number; restartTicks: number }
    const period = uptimeTicks + restartTicks
    const instances = world.services.find((s) => s.name === TARGET)!.instances
    for (const seed of SEEDS) {
      const hooks = serviceCrashLoop.activate(fault!, world, createRngFactory(seed))
      const upTicks = new Map(instances.map((i) => [i, 0]))
      for (let s = 0; s < period * 5; s++) {
        const down = downOf(hooks.onTick?.({ tick: START + s, world }))
        expect(down.length).toBeGreaterThanOrEqual(1)
        expect(down.every((i) => instances.includes(i))).toBe(true)
        for (const i of instances) if (!down.includes(i)) upTicks.set(i, (upTicks.get(i) ?? 0) + 1)
      }
      for (const i of instances) expect(upTicks.get(i)).toBe(uptimeTicks * 5)
    }
  })

  it('with the defaults and 3 replicas: in 3 of every 4 ticks exactly one instance is up, in 1 of every 4 none (ADR-004 Emenda 2 §4)', () => {
    const { uptimeTicks, restartTicks } = fault!.params as { uptimeTicks: number; restartTicks: number }
    expect(uptimeTicks + restartTicks).toBe(4)
    const instances = world.services.find((s) => s.name === TARGET)!.instances
    expect(instances).toHaveLength(3)
    for (const seed of SEEDS) {
      const hooks = serviceCrashLoop.activate(fault!, world, createRngFactory(seed))
      for (let cycle = 0; cycle < 5; cycle++) {
        const upCounts = Array.from({ length: 4 }, (_, k) => instances.length - downOf(hooks.onTick?.({ tick: START + cycle * 4 + k, world })).length)
        expect([...upCounts].sort(), seed).toEqual([0, 1, 1, 1])
      }
    }
  })

  it('one error log `process exited` per down instance per tick, with exitCode fixed and restartCount growing', () => {
    const hooks = serviceCrashLoop.activate(fault!, world, createRngFactory('logs'))
    const lastCount = new Map<string, number>()
    let exitCode: unknown
    for (let s = 0; s < 20; s++) {
      const effect = hooks.onTick?.({ tick: START + s, world })
      const down = downOf(effect)
      expect(effect?.logs?.map((l) => l.instance)).toEqual(down)
      for (const log of effect?.logs ?? []) {
        expect(log).toMatchObject({ component: TARGET, level: 'error', message: PROCESS_EXITED })
        expect(log.traceId).toBeUndefined()
        expect(Object.keys(log.attrs ?? {})).toEqual(['exitCode', 'restartCount'])
        exitCode ??= log.attrs?.['exitCode']
        expect(log.attrs?.['exitCode']).toBe(exitCode)
        const count = log.attrs?.['restartCount'] as number
        expect(count).toBeGreaterThanOrEqual(lastCount.get(log.instance) ?? 1)
        lastCount.set(log.instance, count)
      }
    }
    expect(EXIT_CODES).toContain(exitCode)
    // Default cycle of 4 ticks over 20 ticks: 5 crashes, 6 when the instance starts down and
    // its first up tick comes before the end of the first cycle.
    expect(lastCount.size).toBe(3)
    for (const count of lastCount.values()) expect([5, 6]).toContain(count)
  })

  it('down instances come in world order and only the onTick hook is defined', () => {
    const hooks = serviceCrashLoop.activate(fault!, world, createRngFactory('order'))
    expect(Object.keys(hooks)).toEqual(['onTick'])
    const instances = world.services.find((s) => s.name === TARGET)!.instances
    for (let s = 0; s < 8; s++) {
      const down = downOf(hooks.onTick?.({ tick: START + s, world }))
      expect(down).toEqual(instances.filter((i) => down.includes(i)))
    }
  })

  it('the phase of each instance depends on the seed (which instance is up changes)', () => {
    const upAtStart = new Set<string>()
    for (const seed of SEEDS) {
      const hooks = serviceCrashLoop.activate(fault!, world, createRngFactory(seed))
      const down = downOf(hooks.onTick?.({ tick: START, world }))
      upAtStart.add(world.services.find((s) => s.name === TARGET)!.instances.filter((i) => !down.includes(i)).join(','))
    }
    expect(upAtStart.size).toBeGreaterThan(1)
  })

  it('a target that is not a service of the world gets no hooks', () => {
    expect(serviceCrashLoop.activate({ ...fault!, target: 'postgres' }, world, createRngFactory('x'))).toEqual({})
  })
})

describe('F-2 — before startTick the fault is invisible', () => {
  it.each(SEEDS.slice(0, 4))('ticks < startTick are byte-identical to the baseline (seed %s)', (seed) => {
    const before = (records: readonly TelemetryRecord[]) => records.filter((r) => r.tick < START).map(serializeRecord).join('\n')
    const faulted = run(seed)
    const base = baseline(seed)
    expect(before(faulted)).toBe(before(base))
    expect(faulted.filter((r) => r.tick >= START).map(serializeRecord)).not.toEqual(base.filter((r) => r.tick >= START).map(serializeRecord))
  })
})

describe(`F-3 row 1 and F-4 — signature in the window, ${SEEDS.length} seeds, defaults (R1–R5)`, () => {
  const faulted = SEEDS.map((seed) => run(seed))
  const base = SEEDS.map((seed) => baseline(seed))
  /** Per-seed window means of an aggregate metric: [faulted, baseline]. */
  const series = (component: string, metric: 'rps' | 'errorPct') =>
    [faulted.map((r) => windowMean(r, component, metric, WINDOW)), base.map((r) => windowMean(r, component, metric, WINDOW))] as const

  // Row 1 offers "error % >= baseline + 20 p.p. OR served RPS <= 50% of the baseline". The
  // alternative is declared here and read the same way in every seed (T1.34): the target never
  // reports a request error itself (callers see `connection refused`), so it is the RPS branch.
  const TARGET_BRANCH = 'rps <= 50%' as const

  it(`target (${TARGET_BRANCH}): served RPS <= 0.5x on the mean, <= 0.625x in every seed (R2, R3)`, () => {
    expect(TARGET_BRANCH).toBe('rps <= 50%')
    const [f, b] = series(TARGET, 'rps')
    assertPass(effect(f, b, { ratioAtMost: 0.5 }, SEEDS), `${TARGET} rps`)
  })

  it('target: >= 1 error log in every tick of the window, in every seed (R4)', () => {
    const result = everySeed(SEEDS, (_, i) => {
      const missing = WINDOW.filter(
        (tick) => !faulted[i]!.some((r): r is LogRecord => r.type === 'log' && r.component === TARGET && r.tick === tick && r.level === 'error'),
      )
      return missing.length === 0 || `no error log of ${TARGET} at ticks ${missing.join(', ')}`
    })
    assertPass(result, `${TARGET} error logs`)
  })

  it('indirect: error % of the direct caller (gateway) >= +5 p.p. on the mean, >= +3.75 p.p. in every seed (R2, R3)', () => {
    const [f, b] = series('gateway', 'errorPct')
    assertPass(effect(f, b, { ppAtLeast: 5 }, SEEDS), 'gateway errorPct')
  })

  it('F-4: fixed pair (gateway, errorPct) is an eligible indirect signal in every seed (E1–E4)', () => {
    const r = assertEligibleF4({ component: 'gateway', metric: 'errorPct' }, base, faulted, TARGET, { window: WINDOW, seeds: SEEDS })
    expect(r.direction).toBe('rise')
    expect(r.result.pass).toBe(true)
  })

  it('the caller sees `connection refused`; the target itself reports no request error', () => {
    for (const records of faulted) {
      const refused = records.filter((r) => r.type === 'log' && r.tick >= START && r.component === 'gateway' && r.message === 'connection refused')
      expect(refused.length).toBeGreaterThan(0)
      expect(records.some((r) => r.type === 'span' && r.component === TARGET && r.status === 'error')).toBe(false)
    }
  })
})

describe('other targets and parameters', () => {
  it('an ingress service (gateway) loses requests at the edge: its callees serve less (F-4)', () => {
    const faulted = SEEDS.map((seed) => run(seed, [{ kind: KIND, target: 'gateway' }]))
    const base = SEEDS.map((seed) => baseline(seed))
    const rps = (runs: readonly (readonly TelemetryRecord[])[], component: string) => runs.map((r) => windowMean(r, component, 'rps', WINDOW))
    assertPass(effect(rps(faulted, 'gateway'), rps(base, 'gateway'), { ratioAtMost: 0.5 }, SEEDS), 'gateway rps')
    assertPass(effect(rps(faulted, 'auth'), rps(base, 'auth'), { ratioAtMost: 0.75 }, SEEDS), 'auth rps')
  })

  it('a single-replica service in a minimal world is down restartTicks of every cycle', () => {
    const tiny: SystemDefinition = {
      name: 'tiny',
      services: [
        {
          name: 'front',
          replicas: 1,
          latencyP50Ms: 5,
          latencyP99Ms: 20,
          cpuBasePct: 2,
          cpuPerRequestPct: 1,
          memBaseMb: 100,
          ingress: { ratePerTick: 4, operation: 'http.request' },
          calls: [{ target: 'back', operation: 'back.run', ratio: 1, timeoutMs: 300, retries: 0 }],
          dbPoolSize: 2,
        },
        { name: 'back', replicas: 1, latencyP50Ms: 5, latencyP99Ms: 20, cpuBasePct: 2, cpuPerRequestPct: 1, memBaseMb: 100, calls: [], dbPoolSize: 2 },
      ],
      deps: [],
    }
    const records = run('tiny', [{ kind: KIND, target: 'back', startTick: 2, params: { uptimeTicks: 2, restartTicks: 1 } }], 14, tiny)
    const downTicks = new Set(records.filter((r) => r.type === 'log' && r.message === PROCESS_EXITED).map((r) => r.tick))
    expect(downTicks.size).toBe(4) // ticks 2..13 = 12 ticks = 4 cycles of 3
    for (const tick of downTicks) {
      expect(records.some((r) => r.type === 'span' && r.component === 'back' && r.kind === 'server' && r.tick === tick)).toBe(false)
      expect(aggregate(records, 'front', tick).errorPct).toBe(100)
    }
  })
})

describe('P-1/P-2/P-3/S-3 — verify-coherence.mjs over the faulted NDJSON', () => {
  it.each(['qa', 'crash-coh'])('seed %s, 60 ticks', (seed) => {
    const text = toNdjson(run(seed, [{ kind: KIND }], 60))
    const r = spawnSync(process.execPath, [verifier], { input: text, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})

describe('DET — same seed and fault => byte-identical NDJSON', () => {
  it('two runs give the same hash; different seeds give different hashes', () => {
    const a = sha(toNdjson(run('det', [{ kind: KIND }], 40)))
    expect(sha(toNdjson(run('det', [{ kind: KIND }], 40)))).toBe(a)
    expect(sha(toNdjson(run('det-2', [{ kind: KIND }], 40)))).not.toBe(a)
  })
})
