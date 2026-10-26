/**
 * T1.18 / T1.36 — fault `disk_full` (ADR-004 and its Emendas 2 and 3; PRD F-1, F-2, F-3 row 2, F-4; DET).
 *
 * Signature assertions follow the seed aggregation rule R1–R5 and the F-4 eligibility rules
 * E1–E4 (PRD Emenda 2) through test/support/signature.ts: window means over the seeds of
 * `signatureSeeds` (replaceable with ENGINE_QA_SEEDS), never per-trace or per-instance equality
 * against the baseline while the fault is active (ADR-003 §8).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { faultCatalog } from '../../src/faults/catalog.js'
import { DISK_USAGE_HIGH, FILL_START_PCT, NO_SPACE_LEFT, diskFull, usagePct } from '../../src/faults/disk_full.js'
import { faultRegistry } from '../../src/faults/registry.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { serializeRecord, toNdjson } from '../../src/sim/serialize.js'
import { simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import { assertEligibleF4, assertPass, effect, everySeed, signatureSeeds, signatureWindow, windowMean } from '../support/signature.js'
import type { FaultInput, LogRecord, ServeContext, SystemDefinition, TelemetryRecord } from '../../src/types.js'

const KIND = 'disk_full'
const START = faultCatalog[KIND].defaultStartTick
const TARGET = faultCatalog[KIND].defaultTarget
const FAIL_RATIO = faultCatalog[KIND].params['failRatio']!.default
const WINDOW = signatureWindow(START)
const TICKS = START + 12
const SEEDS = signatureSeeds('disk')
/**
 * The fixed dependent of F-3 row 2 and pair of F-4 (ADR-004 Emenda 2 §2, Emenda 3): orders-worker calls
 * postgres directly (retries: 2), with no cache on the path.
 */
const DEPENDENT = 'orders-worker'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

function run(seed: string, inputs: readonly FaultInput[] = [{ kind: KIND }], ticks = TICKS, system: SystemDefinition = defaultShop) {
  const faults = resolveFaults(inputs, buildWorld(system, seed))
  return simulate({ system, seed, faults }, ticks)
}

const baseline = (seed: string, ticks = TICKS) => simulate({ system: defaultShop, seed }, ticks)

const serve = (tick: number, traceId: string, component = TARGET): ServeContext => ({
  tick,
  component,
  instance: `${component}-0`,
  operation: 'db.query',
  traceId,
})

describe('module semantics (ADR-004)', () => {
  const world = buildWorld(defaultShop, 'sem')
  const [fault] = resolveFaults([{ kind: KIND }], world)
  const fillTicks = fault!.params['fillTicks'] as number

  it('is the registered module of its kind', () => {
    expect(faultRegistry[KIND]).toBe(diskFull)
    expect(diskFull.kind).toBe(KIND)
  })

  it('usagePct rises while filling and is 100 once full', () => {
    expect(usagePct(0, 3)).toBe(FILL_START_PCT)
    expect([0, 1, 2].map((s) => usagePct(s, 3))).toEqual([95, 96, 97])
    expect(usagePct(3, 3)).toBe(100)
    expect(usagePct(0, 0)).toBe(100)
    for (let s = 0; s < 30; s++) expect(usagePct(s, 30)).toBeLessThan(100)
  })

  it('one warn per instance per tick while filling, then one error per instance per tick', () => {
    const hooks = diskFull.activate(fault!, world, createRngFactory('logs'))
    for (let s = 0; s < 12; s++) {
      const logs = hooks.onTick?.({ tick: START + s, world })?.logs ?? []
      expect(logs).toHaveLength(1)
      const [log] = logs
      expect(log).toEqual({
        component: TARGET,
        instance: `${TARGET}-0`,
        level: s < fillTicks ? 'warn' : 'error',
        message: s < fillTicks ? DISK_USAGE_HIGH : NO_SPACE_LEFT,
        attrs: { usagePct: usagePct(s, fillTicks) },
      })
    }
  })

  it('requests fail only on the target, only once full, with probability ~failRatio and fresh draws per span', () => {
    const hooks = diskFull.activate(fault!, world, createRngFactory('serve'))
    expect(hooks.onServe?.(serve(START + fillTicks, 't0r0', 'payment'))).toBeUndefined()
    for (let s = 0; s < fillTicks; s++) expect(hooks.onServe?.(serve(START + s, `t${START + s}r0`))).toBeUndefined()
    let failed = 0
    let total = 0
    let mixed = 0
    for (let s = fillTicks; s < fillTicks + 20; s++) {
      for (let r = 0; r < 50; r++) {
        // Two spans of the same trace (a retry) draw independently.
        const a = hooks.onServe?.(serve(START + s, `t${START + s}r${r}`))
        const b = hooks.onServe?.(serve(START + s, `t${START + s}r${r}`))
        for (const e of [a, b]) {
          total += 1
          if (e !== undefined) {
            expect(e).toEqual({ fail: { message: NO_SPACE_LEFT } })
            failed += 1
          }
        }
        if ((a === undefined) !== (b === undefined)) mixed += 1
      }
    }
    expect(failed / total).toBeGreaterThan(FAIL_RATIO - 0.05)
    expect(failed / total).toBeLessThan(FAIL_RATIO + 0.05)
    expect(mixed).toBeGreaterThan(0)
  })

  it('the draw of a request is the same whatever other traces did (per-trace stream)', () => {
    const tick = START + fillTicks + 1
    const alone = diskFull.activate(fault!, world, createRngFactory('iso'))
    const busy = diskFull.activate(fault!, world, createRngFactory('iso'))
    for (let r = 0; r < 30; r++) busy.onServe?.(serve(tick, `t${tick}r${r + 100}`))
    for (let r = 0; r < 30; r++) expect(busy.onServe?.(serve(tick, `t${tick}r${r}`))).toEqual(alone.onServe?.(serve(tick, `t${tick}r${r}`)))
  })

  it('fillTicks = 0 is full from startTick; failRatio = 1 fails every request', () => {
    const [f] = resolveFaults([{ kind: KIND, params: { fillTicks: 0, failRatio: 1 } }], world)
    const hooks = diskFull.activate(f!, world, createRngFactory('zero'))
    expect(hooks.onTick?.({ tick: START, world })?.logs?.[0]).toMatchObject({ level: 'error', message: NO_SPACE_LEFT })
    for (let r = 0; r < 20; r++) expect(hooks.onServe?.(serve(START, `t${START}r${r}`))).toEqual({ fail: { message: NO_SPACE_LEFT } })
  })

  it('a target that is not in the world gets no hooks', () => {
    expect(diskFull.activate({ ...fault!, target: 'nowhere' }, world, createRngFactory('x'))).toEqual({})
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

describe(`F-3 row 2 / F-4 — ${SEEDS.length} seeds, defaults (R1–R5, E1–E4)`, () => {
  const faulted = SEEDS.map((seed) => run(seed))
  const base = SEEDS.map((seed) => baseline(seed))
  const errorPct = (runs: readonly (readonly TelemetryRecord[])[], component: string) => runs.map((records) => windowMean(records, component, 'errorPct', WINDOW))

  it('default failRatio is 0.9 and fillTicks 3 (ADR-004 Emenda 3): the whole window is full', () => {
    expect(FAIL_RATIO).toBe(0.9)
    const fillTicks = faultCatalog[KIND].params['fillTicks']!.default
    expect(fillTicks).toBe(3)
    expect(WINDOW[0]! - START).toBeGreaterThanOrEqual(fillTicks)
  })

  it('R4: error-level logs in postgres in every tick of the window, in every seed', () => {
    assertPass(
      everySeed(SEEDS, (_seed, i) => {
        const missing = WINDOW.filter((tick) => !faulted[i]!.some((r) => r.type === 'log' && r.component === TARGET && r.tick === tick && r.level === 'error'))
        return missing.length === 0 || `no error log of ${TARGET} at ticks ${missing.join(', ')}`
      }),
      'postgres error logs',
    )
  })

  it('R3: error % of postgres >= baseline + 10 p.p. (>= +7.5 p.p. in every seed)', () => {
    assertPass(effect(errorPct(faulted, TARGET), errorPct(base, TARGET), { ppAtLeast: 10 }, SEEDS), 'postgres error %')
  })

  it(`R3: error % of the fixed dependent ${DEPENDENT} >= baseline + 5 p.p. (>= +3.75 p.p. in every seed)`, () => {
    assertPass(effect(errorPct(faulted, DEPENDENT), errorPct(base, DEPENDENT), { ppAtLeast: 5 }, SEEDS), `${DEPENDENT} error %`)
  })

  it(`F-4: fixed eligible pair (${DEPENDENT}, errorPct), in every seed (E1–E4)`, () => {
    const r = assertEligibleF4({ component: DEPENDENT, metric: 'errorPct' }, base, faulted, TARGET, { window: WINDOW, seeds: SEEDS })
    expect(r.direction).toBe('rise')
  })

  it('callers log the symptom (`upstream error`, `dependency call failed`), never the disk message', () => {
    for (const records of faulted) {
      const callerLogs = records.filter((r): r is LogRecord => r.type === 'log' && r.tick >= START && r.component !== TARGET && r.level === 'error')
      expect(callerLogs.some((l) => l.message === 'upstream error' && l.attrs?.['peer'] === TARGET)).toBe(true)
      expect(callerLogs.some((l) => l.message === NO_SPACE_LEFT)).toBe(false)
    }
    expect(faulted.some((records) => records.some((r) => r.type === 'log' && r.message === 'dependency call failed'))).toBe(true)
  })

  it('while filling (s < fillTicks) only warnings: no request fails', () => {
    for (const records of faulted) {
      const filling = records.filter((r) => r.tick >= START && r.tick < START + 3)
      expect(filling.some((r) => r.type === 'span' && r.status === 'error')).toBe(false)
      const targetLogs = filling.filter((r): r is LogRecord => r.type === 'log' && r.component === TARGET)
      expect(targetLogs.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([DISK_USAGE_HIGH, DISK_USAGE_HIGH, DISK_USAGE_HIGH])
      expect(targetLogs.some((l) => l.level === 'error')).toBe(false)
    }
  })
})

describe('P-1/P-2/P-3/S-3 — verify-coherence.mjs over the faulted NDJSON', () => {
  it.each(['qa', 'disk-coh'])('seed %s, 60 ticks', (seed) => {
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
