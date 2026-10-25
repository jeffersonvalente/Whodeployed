/**
 * T1.20 — fault `bad_deploy` (ADR-004; PRD F-1, F-2, F-3 row 4, F-4, F-5, S-4; SPEC §3.3, §3.4).
 *
 * Signature assertions compare window means (ticks startTick+6..startTick+11) over >= 10 seeds
 * against the baseline, never trace-by-trace equality during the fault (ADR-003 §8).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { UNHANDLED_EXCEPTION, badDeploy, pickDistinct } from '../../src/faults/bad_deploy.js'
import { faultCatalog } from '../../src/faults/catalog.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { whatChanged } from '../../src/questions/whatChanged.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { toNdjson } from '../../src/sim/serialize.js'
import { createSimulation, simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type { EventRecord, Fault, FaultInput, MetricRecord, MetricName, TelemetryRecord } from '../../src/types.js'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')

const TICKS = 30
const SEEDS = Array.from({ length: 12 }, (_, i) => `bad-deploy-${i}`)
const world = buildWorld(defaultShop, 'resolve')
const resolve = (input: Omit<FaultInput, 'kind'> = {}): Fault[] => resolveFaults([{ kind: 'bad_deploy', ...input }], world)

const [DEFAULT] = resolve()
const START = DEFAULT!.startTick
const inWindow = (tick: number) => tick >= START + 6 && tick <= START + 11

const run = (seed: string, faults: readonly Fault[] = []) => simulate({ system: defaultShop, seed, faults }, TICKS)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** Window mean of one metric of a component (aggregate when instance is undefined). */
function windowMean(records: readonly TelemetryRecord[], component: string, metric: MetricName, instance?: string): number {
  const values = records
    .filter((r): r is MetricRecord => r.type === 'metric' && r.component === component && r.instance === instance && inWindow(r.tick))
    .map((r) => r[metric])
  expect(values).toHaveLength(6)
  return mean(values)
}

const deployEvents = (records: readonly TelemetryRecord[]) => records.filter((r): r is EventRecord => r.type === 'event' && r.kind === 'deploy')

describe('bad_deploy — defaults (ADR-004)', () => {
  it('targets one instance of gateway with errorRatio 0.9 from tick 10', () => {
    expect(DEFAULT).toEqual({ kind: 'bad_deploy', target: 'gateway', startTick: 10, params: { affectedInstances: 1, errorRatio: 0.9 } })
    expect(faultCatalog.bad_deploy.defaultTarget).toBe('gateway')
  })
})

describe('F-3 row 4 and F-5 — the bad instance is hidden by the aggregate', () => {
  const rows = SEEDS.map((seed) => {
    const base = run(seed)
    const fault = run(seed, [DEFAULT!])
    const events = deployEvents(fault)
    const affected = events[0]?.instance as string
    const others = world.services.find((s) => s.name === 'gateway')!.instances.filter((i) => i !== affected)
    return {
      seed,
      events,
      affected,
      affectedBase: windowMean(base, 'gateway', 'errorPct', affected),
      affectedFault: windowMean(fault, 'gateway', 'errorPct', affected),
      others: others.map((i) => ({ base: windowMean(base, 'gateway', 'errorPct', i), fault: windowMean(fault, 'gateway', 'errorPct', i) })),
      aggBase: windowMean(base, 'gateway', 'errorPct'),
      aggFault: windowMean(fault, 'gateway', 'errorPct'),
    }
  })

  it('emits exactly one deploy event, with target and instance, at startTick (S-4)', () => {
    for (const row of rows) {
      expect(row.events).toEqual([{ type: 'event', tick: START, kind: 'deploy', target: 'gateway', instance: row.affected }])
      expect(row.affected).toMatch(/^gateway-[0-2]$/)
    }
  })

  it('affected instance error % >= baseline + 10 p.p. (every seed)', () => {
    for (const row of rows) expect(row.affectedFault, row.seed).toBeGreaterThanOrEqual(row.affectedBase + 10)
  })

  it('every other instance stays within 2 p.p. of the baseline (every seed)', () => {
    for (const row of rows) for (const o of row.others) expect(Math.abs(o.fault - o.base), row.seed).toBeLessThanOrEqual(2)
  })

  it('service aggregate error % rises >= 1 p.p. but stays <= half of the affected instance (every seed)', () => {
    for (const row of rows) {
      expect(row.aggFault, row.seed).toBeGreaterThanOrEqual(row.aggBase + 1)
      expect(row.aggFault, row.seed).toBeLessThanOrEqual(row.affectedFault / 2)
    }
  })

  it('window means over the seeds (numbers reported in the PR)', () => {
    const affected = mean(rows.map((r) => r.affectedFault))
    const agg = mean(rows.map((r) => r.aggFault))
    const othersDelta = Math.max(...rows.flatMap((r) => r.others.map((o) => Math.abs(o.fault - o.base))))
    expect(affected).toBeGreaterThan(80)
    expect(agg).toBeLessThan(affected / 2)
    expect(othersDelta).toBe(0)
  })

  it('the affected instance depends on the seed (not a fixed index)', () => {
    expect(new Set(rows.map((r) => r.affected)).size).toBeGreaterThan(1)
  })
})

describe('F-4 — the fault shows outside the target', () => {
  const downstream = ['auth', 'redis'] as const

  it.each(downstream)('RPS of %s drops >= 25% vs baseline (window mean over the seeds)', (component) => {
    const base = mean(SEEDS.map((seed) => windowMean(run(seed), component, 'rps')))
    const fault = mean(SEEDS.map((seed) => windowMean(run(seed, [DEFAULT!]), component, 'rps')))
    expect((base - fault) / base).toBeGreaterThanOrEqual(0.25)
  })
})

describe('non-default target behind a caller with retries (SPEC §3.4)', () => {
  const faults = resolve({ target: 'catalog' })

  it('catalog: the bad instance shows per instance, while gateway errors stay at the baseline (retries absorb it)', () => {
    const affected: number[] = []
    const aggregate: number[] = []
    for (const seed of SEEDS) {
      const base = run(seed)
      const fault = run(seed, faults)
      const instance = deployEvents(fault)[0]!.instance!
      affected.push(windowMean(fault, 'catalog', 'errorPct', instance) - windowMean(base, 'catalog', 'errorPct', instance))
      aggregate.push(windowMean(fault, 'catalog', 'errorPct'))
      expect(windowMean(fault, 'gateway', 'errorPct')).toBe(windowMean(base, 'gateway', 'errorPct'))
    }
    expect(mean(affected)).toBeGreaterThanOrEqual(10)
    expect(mean(aggregate)).toBeLessThanOrEqual(mean(affected) / 2)
  })
})

describe('F-2 — invisible before startTick', () => {
  it.each(SEEDS.slice(0, 4))('records with tick < startTick are byte-identical to the baseline (seed %s)', (seed) => {
    const before = (records: readonly TelemetryRecord[]) => toNdjson(records.filter((r) => r.tick < START))
    const fault = run(seed, [DEFAULT!])
    expect(before(fault)).toBe(before(run(seed)))
    expect(toNdjson(fault)).not.toBe(toNdjson(run(seed)))
  })
})

describe('signals of the failed requests', () => {
  const records = run('signals', [DEFAULT!])
  const affected = deployEvents(records)[0]!.instance!

  it('only server spans of the affected instance fail with unhandled exception, with a version attr', () => {
    const errorLogs = records.filter((r) => r.type === 'log' && r.message === UNHANDLED_EXCEPTION)
    expect(errorLogs.length).toBeGreaterThan(0)
    for (const log of errorLogs) {
      expect(log).toMatchObject({ component: 'gateway', instance: affected, level: 'error' })
      expect(log.type === 'log' && log.tick >= START).toBe(true)
      expect(log.type === 'log' && log.attrs).toMatchObject({ version: expect.stringMatching(/^[0-9a-f]{7}$/) })
    }
    const versions = new Set(errorLogs.map((l) => (l.type === 'log' ? l.attrs?.['version'] : undefined)))
    expect(versions.size).toBe(1)
    const failedRoots = records.filter((r) => r.type === 'span' && r.kind === 'server' && r.component === 'gateway' && r.status === 'error')
    expect(failedRoots.every((s) => s.type === 'span' && s.instance === affected)).toBe(true)
    expect(failedRoots).toHaveLength(errorLogs.length)
  })

  it('a failed request makes no downstream call (single-span trace)', () => {
    const failed = records.filter((r) => r.type === 'span' && r.kind === 'server' && r.component === 'gateway' && r.status === 'error')
    for (const root of failed) {
      if (root.type !== 'span') continue
      expect(records.filter((r) => r.type === 'span' && r.traceId === root.traceId)).toHaveLength(1)
    }
  })

  it('whatChanged sees the deploy (fault events look like any other change)', () => {
    const sim = createSimulation({ system: defaultShop, seed: 'signals', faults: [DEFAULT!] })
    sim.advance(START + 2)
    const view = sim.telemetry()
    const signal = whatChanged({ kind: 'whatChanged', window: 5 }, { view, lastWeek: () => view })
    expect(signal.events).toEqual([{ type: 'event', tick: START, kind: 'deploy', target: 'gateway', instance: affected }])
  })

  it('the version label varies with the seed', () => {
    const versionOf = (seed: string) => {
      const log = run(seed, [DEFAULT!]).find((r) => r.type === 'log' && r.message === UNHANDLED_EXCEPTION)
      return log?.type === 'log' ? log.attrs?.['version'] : undefined
    }
    expect(new Set(SEEDS.slice(0, 5).map(versionOf)).size).toBeGreaterThan(1)
  })
})

describe('parameters', () => {
  it('affectedInstances = 2 deploys to two distinct instances, events in world order', () => {
    const records = run('two', resolve({ params: { affectedInstances: 2 } }))
    const events = deployEvents(records)
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.tick === START)).toBe(true)
    const ids = events.map((e) => e.instance!)
    expect(new Set(ids).size).toBe(2)
    expect([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ids)
  })

  it('errorRatio = 1 fails every request of the affected instance; the others never fail', () => {
    const records = run('all', resolve({ params: { errorRatio: 1 } }))
    const affected = deployEvents(records)[0]!.instance!
    const roots = records.filter((r) => r.type === 'span' && r.kind === 'server' && r.component === 'gateway' && r.tick >= START)
    expect(roots.length).toBeGreaterThan(0)
    for (const s of roots) if (s.type === 'span') expect(s.status).toBe(s.instance === affected ? 'error' : 'ok')
  })

  // #44: the affected instance fails with probability errorRatio (ADR-004), one independent draw
  // per request. Kills `.chance(errorRatio)` -> `.chance(1)` (pooled fraction ~1) and
  // `rng('serve', tick, traceId)` -> `rng('serve')` (every request of a seed draws the same number,
  // so each seed is all-or-nothing). Server spans of the affected instance from startTick to the
  // end of the run (~80 per seed), 12 seeds.
  it.each([0.3, 0.5])('errorRatio = %s: the affected instance fails that fraction of its requests (pooled ±0.05, per seed ±0.2)', (errorRatio) => {
    const faults = resolve({ params: { errorRatio } })
    let failed = 0
    let total = 0
    for (const seed of SEEDS) {
      const records = run(seed, faults)
      const affected = deployEvents(records)[0]!.instance!
      const served = records.filter((r) => r.type === 'span' && r.kind === 'server' && r.component === 'gateway' && r.instance === affected && r.tick >= START)
      const errors = served.filter((s) => s.type === 'span' && s.status === 'error').length
      expect(served.length, seed).toBeGreaterThanOrEqual(40)
      const fraction = errors / served.length
      expect(fraction, seed).toBeGreaterThanOrEqual(errorRatio - 0.2)
      expect(fraction, seed).toBeLessThanOrEqual(errorRatio + 0.2)
      failed += errors
      total += served.length
    }
    expect(failed / total).toBeGreaterThanOrEqual(errorRatio - 0.05)
    expect(failed / total).toBeLessThanOrEqual(errorRatio + 0.05)
  })

  it('a later startTick moves the deploy event', () => {
    expect(deployEvents(run('late', resolve({ startTick: 20 })))).toMatchObject([{ tick: 20 }])
  })
})

describe('module', () => {
  it('pickDistinct returns distinct items in original order and clamps the count', () => {
    const rng = createRngFactory('pick')
    for (let i = 0; i < 20; i++) {
      const picked = pickDistinct(['a', 'b', 'c', 'd'], 2, rng('k', i))
      expect(new Set(picked).size).toBe(2)
      expect(['a', 'b', 'c', 'd'].filter((x) => picked.includes(x))).toEqual(picked)
    }
    expect(pickDistinct(['a', 'b'], 5, rng('x'))).toEqual(['a', 'b'])
    expect(pickDistinct(['a', 'b'], 0, rng('x'))).toEqual([])
  })

  it('activate rejects a target that is not a service (internal invariant)', () => {
    const fault: Fault = { kind: 'bad_deploy', target: 'redis', startTick: 0, params: { affectedInstances: 1, errorRatio: 1 } }
    expect(() => badDeploy.activate(fault, world, createRngFactory('x'))).toThrow(/not a service/)
  })

  it('onTick only emits on startTick; onServe ignores other components and instances', () => {
    const hooks = badDeploy.activate(DEFAULT!, world, createRngFactory('unit'))
    expect(hooks.onTick!({ tick: START + 1, world })).toBeUndefined()
    const event = hooks.onTick!({ tick: START, world })!.events![0]!
    const ctx = { tick: START, operation: 'http.request', traceId: `t${START}r0` }
    expect(hooks.onServe!({ ...ctx, component: 'catalog', instance: 'catalog-0' })).toBeUndefined()
    const healthy = world.services[0]!.instances.find((i) => i !== event.instance)!
    expect(hooks.onServe!({ ...ctx, component: 'gateway', instance: healthy })).toBeUndefined()
  })
})

describe('coherence and determinism with the fault active', () => {
  it('verify-coherence.mjs accepts the NDJSON (P-1/P-2/P-3/S-3)', () => {
    for (const seed of ['coh-0', 'coh-1']) {
      const r = spawnSync(process.execPath, [verifier], { input: toNdjson(simulate({ system: defaultShop, seed, faults: [DEFAULT!] }, 60)), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    }
  })

  it('DET: two runs with the same seed give the same NDJSON hash; different seeds differ', () => {
    const a = sha(toNdjson(run('det', [DEFAULT!])))
    expect(sha(toNdjson(run('det', [DEFAULT!])))).toBe(a)
    expect(sha(toNdjson(run('det-2', [DEFAULT!])))).not.toBe(a)
  })
})
