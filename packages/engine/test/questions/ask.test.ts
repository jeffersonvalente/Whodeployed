/**
 * T1.16 — ask() dispatcher (ADR-006 with Emenda 1, ADR-003 §4; PRD Q-1, Q-2, Q-3, Q-8 seed,
 * Q-10, DET) and the answer fixtures consumed by the UI (fixtures/answers/<kind>.json).
 *
 * createSimulation is wrapped (not replaced) so the tests can count how many lastWeek runs the
 * dispatcher creates: every call goes to the real implementation.
 *
 * Regenerate the fixtures (only when the engine output changes on purpose):
 *   UPDATE_FIXTURES=1 corepack pnpm --filter ./packages/engine exec vitest run test/questions/ask.test.ts
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError } from '../../src/errors.js'
import { lastWeekConfig, lastWeekSeed, tickCostTable } from '../../src/questions/ask.js'
import { toNdjson } from '../../src/sim/serialize.js'
import { createSimulation, simulate } from '../../src/sim/simulation.js'
import type {
  Answer,
  CompareSignal,
  MetricName,
  Question,
  QuestionKind,
  Simulation,
  SimulationConfig,
  TelemetryRecord,
} from '../../src/types.js'
import { defaultShop } from '../../src/world/default-shop.js'

vi.mock('../../src/sim/simulation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sim/simulation.js')>()
  return { ...actual, createSimulation: vi.fn(actual.createSimulation) }
})

const createSpy = vi.mocked(createSimulation)
const lastWeekRuns = (): SimulationConfig[] =>
  createSpy.mock.calls.map(([cfg]) => cfg).filter((cfg) => cfg.seed.endsWith(':lastWeek'))

beforeEach(() => {
  createSpy.mockClear()
})

const KINDS: readonly QuestionKind[] = ['dashboard', 'logs', 'trace', 'whatChanged', 'compare', 'askNpc']
const COMPONENTS = ['gateway', 'auth', 'catalog', 'cart', 'payment', 'orders-worker', 'postgres', 'redis', 'queue']
const METRICS: readonly MetricName[] = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']

/** One question of every kind, two for compare (both modes). */
const oneOfEach: readonly Question[] = [
  { kind: 'dashboard', service: 'gateway' },
  { kind: 'logs', service: 'payment', window: 30 },
  { kind: 'trace', service: 'payment', percentile: 95 },
  { kind: 'whatChanged', window: 30 },
  { kind: 'compare', service: 'payment', metric: 'p95', by: 'instance' },
  { kind: 'compare', service: 'payment', metric: 'p95', by: 'lastWeek' },
  { kind: 'askNpc', role: 'oncall' },
]

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function simAt(config: SimulationConfig, tick: number): Simulation {
  const sim = createSimulation(config)
  sim.advance(tick)
  return sim
}

/** Deterministic test PRNG (LCG): the questions of Q-3 are reproducible (DET). */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomQuestion(rand: () => number): Question {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
  const kind = pick(KINDS)
  const service = pick(COMPONENTS)
  switch (kind) {
    case 'dashboard':
      return { kind, service }
    case 'logs':
      return rand() < 0.5
        ? { kind, service, window: 1 + Math.floor(rand() * 60) }
        : { kind, service, window: 1 + Math.floor(rand() * 60), filter: { level: pick(['info', 'warn', 'error']) } }
    case 'trace':
      return { kind, service, percentile: pick([50, 95, 99] as const) }
    case 'whatChanged':
      return { kind, window: 1 + Math.floor(rand() * 60) }
    case 'compare':
      return { kind, service, metric: pick(METRICS), by: pick(['instance', 'lastWeek'] as const) }
    case 'askNpc':
      return { kind, role: pick(['dev', 'dba', 'oncall'] as const) }
  }
}

const noisyConfig: SimulationConfig = {
  system: defaultShop,
  seed: 'ask-q3',
  noise: [
    { kind: 'deploy', target: 'catalog', tick: 10, note: 'harmless frontend copy change' },
    { kind: 'config', target: 'redis', tick: 33 },
  ],
}

// ---------------------------------------------------------------------------------------------

describe('ask() — Q-1: every kind, in a fresh world, no level parameter', () => {
  it('answers the 6 kinds at tick 0 of a just-created simulation', () => {
    const sim = createSimulation({ system: defaultShop, seed: 'fresh' })
    expect(sim.world.tick).toBe(0)
    const seen = new Set<QuestionKind>()
    for (const question of oneOfEach) {
      const answer = sim.ask(question)
      expect(answer.data.kind).toBe(question.kind)
      expect(answer.question).toStrictEqual(question)
      expect(Number.isInteger(answer.tickCost) && answer.tickCost >= 1).toBe(true)
      seen.add(question.kind)
    }
    expect([...seen].sort()).toEqual([...KINDS].sort())
  })

  it('rejects a level-like parameter instead of honouring it', () => {
    const sim = createSimulation({ system: defaultShop, seed: 'fresh' })
    const withLevel = { kind: 'dashboard', service: 'gateway', playerLevel: 'senior' } as unknown as Question
    expect(() => sim.ask(withLevel)).toThrow(EngineError)
  })
})

describe('ask() — Q-2: echo and tickCost', () => {
  it('tickCost is the ADR-006 table', () => {
    expect(tickCostTable).toStrictEqual({ dashboard: 1, logs: 1, whatChanged: 1, trace: 2, compare: 2, askNpc: 3 })
    expect(Object.isFrozen(tickCostTable)).toBe(true)
    const sim = simAt({ system: defaultShop, seed: 'cost' }, 12)
    for (const question of oneOfEach) expect(sim.ask(question).tickCost).toBe(tickCostTable[question.kind])
  })

  it('tickCost depends only on the kind, never on the parameters', () => {
    const sim = simAt({ system: defaultShop, seed: 'cost' }, 12)
    const costs = (qs: readonly Question[]) => qs.map((q) => sim.ask(q).tickCost)
    expect(new Set(costs([1, 5, 30, 360].map((window) => ({ kind: 'logs', service: 'gateway', window }) as const)))).toEqual(new Set([1]))
    expect(new Set(costs([1, 30, 360].map((window) => ({ kind: 'whatChanged', window }) as const)))).toEqual(new Set([1]))
    expect(new Set(costs(([50, 95, 99] as const).map((percentile) => ({ kind: 'trace', service: 'payment', percentile }) as const)))).toEqual(new Set([2]))
    expect(new Set(costs((['dev', 'dba', 'oncall'] as const).map((role) => ({ kind: 'askNpc', role }) as const)))).toEqual(new Set([3]))
  })

  it('echoes the question deeply, as a copy the caller cannot change afterwards', () => {
    const sim = simAt({ system: defaultShop, seed: 'echo' }, 3)
    const question = { kind: 'logs' as const, service: 'payment', window: 30, filter: { level: 'error' } }
    const answer = sim.ask(question)
    expect(answer.question).toStrictEqual(question)
    expect(answer.question).not.toBe(question)
    question.filter.level = 'info'
    expect(answer.question).toStrictEqual({ kind: 'logs', service: 'payment', window: 30, filter: { level: 'error' } })
  })

  it('Answer has exactly the keys question, data, tickCost (SPEC §6)', () => {
    const answer = createSimulation({ system: defaultShop, seed: 'keys' }).ask({ kind: 'whatChanged', window: 5 })
    expect(Object.keys(answer)).toEqual(['question', 'data', 'tickCost'])
  })
})

describe('ask() — Q-3: asking never changes the simulation', () => {
  it('20 PRNG questions interleaved over 60 ticks: NDJSON byte-identical to a run without questions', () => {
    const rand = lcg(1601)
    const askTicks = new Set<number>()
    while (askTicks.size < 20) askTicks.add(Math.floor(rand() * 60))
    const asked: { tick: number; question: Question; answer: Answer }[] = []

    const withQuestions = createSimulation(noisyConfig)
    for (let tick = 0; tick < 60; tick++) {
      if (tick > 0) withQuestions.advance()
      if (askTicks.has(tick)) {
        const question = randomQuestion(rand)
        const before = withQuestions.telemetry().all().length
        const answer = withQuestions.ask(question)
        expect(withQuestions.world.tick).toBe(tick) // ask() does not advance the clock
        expect(withQuestions.telemetry().all().length).toBe(before)
        // Same question, same tick, same simulation => same Answer.
        expect(withQuestions.ask(question)).toStrictEqual(answer)
        asked.push({ tick, question, answer })
      }
    }
    const without = simulate(noisyConfig, 60)
    expect(toNdjson(withQuestions.telemetry().all() as TelemetryRecord[])).toBe(toNdjson(without))
    expect(new Set(asked.map((a) => a.question.kind)).size).toBeGreaterThanOrEqual(4)
    expect(asked.some((a) => a.question.kind === 'askNpc' || (a.question.kind === 'compare' && a.question.by === 'lastWeek'))).toBe(true)

    // Same question at the same tick of an independent run => same Answer, byte for byte. The
    // fresh runs build their lastWeek in one go; the run above advanced it step by step.
    for (const { tick, question, answer } of asked) {
      expect(JSON.stringify(simAt(noisyConfig, tick).ask(question))).toBe(JSON.stringify(answer))
    }
  })

  it('an invalid question throws EngineError and leaves the telemetry untouched', () => {
    const sim = simAt(noisyConfig, 15)
    const before = toNdjson(sim.telemetry().all() as TelemetryRecord[])
    expect(() => sim.ask({ kind: 'trace', service: 'payment', percentile: 90 as 95 })).toThrow(EngineError)
    expect(() => sim.ask({ kind: 'compare', service: 'nope', metric: 'p95', by: 'lastWeek' })).toThrow(EngineError)
    expect(toNdjson(sim.telemetry().all() as TelemetryRecord[])).toBe(before)
    expect(lastWeekRuns()).toHaveLength(0)
  })

  it.todo('writing to answer.data.records[0] throws TypeError (enable once T1.31 freezes store records, ADR-010)')
})

describe('ask() — Q-10: validation runs before the handler', () => {
  it('propagates EngineError with code, field and valid values', () => {
    const sim = createSimulation({ system: defaultShop, seed: 'q10' })
    const cases: [unknown, string, string][] = [
      [{ kind: 'dashboard', service: 'billing' }, 'unknown_service', 'question.service'],
      [{ kind: 'compare', service: 'payment', metric: 'latency', by: 'instance' }, 'unknown_metric', 'question.metric'],
      [{ kind: 'logs', service: 'payment', window: 0 }, 'invalid_window', 'question.window'],
      [{ kind: 'trace', service: 'payment', percentile: 90 }, 'invalid_percentile', 'question.percentile'],
      [{ kind: 'askNpc', role: 'cto' }, 'invalid_role', 'question.role'],
      [{ kind: 'logs', service: 'payment', window: 5, filter: { a: 1 } }, 'invalid_filter', 'question.filter.a'],
      [{ kind: 'nope' }, 'invalid_question', 'question.kind'],
    ]
    for (const [question, code, field] of cases) {
      let error: unknown
      try {
        sim.ask(question as Question)
      } catch (e) {
        error = e
      }
      expect(error, JSON.stringify(question)).toBeInstanceOf(EngineError)
      expect((error as EngineError).code).toBe(code)
      expect((error as EngineError).field).toBe(field)
    }
  })
})

describe('ask() — lastWeek (ADR-003 §4, ADR-006 Emenda 1, Q-8 seed)', () => {
  const lwq: Question = { kind: 'compare', service: 'payment', metric: 'p95', by: 'lastWeek' }
  const series = (answer: Answer, label: string) => (answer.data as CompareSignal).series.find((s) => s.label === label)?.points ?? []

  it('compare by lastWeek at tick 5, advance, ask at tick 40: full window and a single lastWeek run', () => {
    const config: SimulationConfig = { ...noisyConfig, seed: 'lw' }
    const sim = simAt(config, 5)
    const early = sim.ask(lwq)
    expect(series(early, 'lastWeek').map((p) => p.tick)).toEqual([0, 1, 2, 3, 4, 5])

    sim.advance(35)
    expect(sim.world.tick).toBe(40)
    const late = sim.ask(lwq)
    const window = Array.from({ length: 31 }, (_, i) => 10 + i) // [40 - 30, 40]
    expect(series(late, 'current').map((p) => p.tick)).toEqual(window)
    expect(series(late, 'lastWeek').map((p) => p.tick)).toEqual(window)
    expect(lastWeekRuns()).toHaveLength(1)
    expect(lastWeekRuns()[0]?.seed).toBe('lw:lastWeek')

    // Q-8: the lastWeek series is the aggregate of `simulate --seed 'lw:lastWeek'` with no faults
    // and no noise (built here by hand, independently of lastWeekConfig).
    const reference = simulate({ system: defaultShop, seed: 'lw:lastWeek' }, 41)
      .filter((r) => r.type === 'metric' && r.component === 'payment' && r.instance === undefined && r.tick >= 10)
      .map((r) => ({ tick: r.tick, value: r.type === 'metric' ? r.p95 : NaN }))
    expect(series(late, 'lastWeek')).toEqual(reference)
    // Different seed => not a copy of the current run (ADR-003 alternatives).
    expect(series(late, 'lastWeek')).not.toEqual(series(late, 'current'))
  })

  it('askNpc and compare share the same memoized lastWeek run', () => {
    const sim = simAt({ system: defaultShop, seed: 'share' }, 8)
    sim.ask({ kind: 'askNpc', role: 'dev' })
    sim.ask(lwq)
    sim.advance(3)
    sim.ask({ kind: 'askNpc', role: 'dba' })
    expect(lastWeekRuns()).toHaveLength(1)
  })

  it('questions that do not need lastWeek never simulate it', () => {
    const sim = simAt({ system: defaultShop, seed: 'lazy' }, 10)
    for (const question of oneOfEach) {
      if (question.kind === 'askNpc' || (question.kind === 'compare' && question.by === 'lastWeek')) continue
      sim.ask(question)
    }
    expect(lastWeekRuns()).toHaveLength(0)
  })

  it('is memoized per simulation (AskEnvironment), not shared between simulations', () => {
    const a = simAt({ system: defaultShop, seed: 'same' }, 4)
    const b = simAt({ system: defaultShop, seed: 'same' }, 4)
    a.ask(lwq)
    b.ask(lwq)
    a.ask(lwq)
    expect(lastWeekRuns()).toHaveLength(2)
    expect(a.ask(lwq)).toStrictEqual(b.ask(lwq))
  })

  it('lastWeekConfig keeps the system and drops faults and noise; seed is `${seed}:lastWeek`', () => {
    const config: SimulationConfig = {
      system: defaultShop,
      seed: 'cfg',
      faults: [{ kind: 'disk_full', target: 'postgres', startTick: 2, params: {} }],
      noise: [{ kind: 'deploy', target: 'catalog', tick: 1 }],
    }
    expect(lastWeekSeed('cfg')).toBe('cfg:lastWeek')
    const lw = lastWeekConfig(config)
    expect(lw).toStrictEqual({ system: defaultShop, seed: 'cfg:lastWeek', faults: [], noise: [] })
    expect(lw.system).toBe(config.system)
  })
})

describe('ask() — DET', () => {
  it('two runs with the same seed give the same answers, byte for byte', () => {
    const run = () => {
      const sim = createSimulation(noisyConfig)
      const out: Answer[] = []
      for (const tick of [0, 7, 19, 35]) {
        sim.advance(tick - sim.world.tick)
        for (const question of oneOfEach) out.push(sim.ask(question))
      }
      return sha256(JSON.stringify(out))
    }
    expect(run()).toBe(run())
  })
})

// --- fixtures/answers/<kind>.json (consumed by the UI) ----------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/answers/', import.meta.url))
const FIXTURE_SEED = 'fixture'
const FIXTURE_TICK = 30

const fixtureQuestions: { readonly [K in QuestionKind]: readonly Question[] } = {
  dashboard: [
    { kind: 'dashboard', service: 'gateway' },
    { kind: 'dashboard', service: 'payment' },
    { kind: 'dashboard', service: 'postgres' },
  ],
  logs: [
    { kind: 'logs', service: 'payment', window: 30 },
    { kind: 'logs', service: 'gateway', window: 30, filter: { level: 'error' } },
  ],
  trace: [
    { kind: 'trace', service: 'payment', percentile: 50 },
    { kind: 'trace', service: 'payment', percentile: 95 },
    { kind: 'trace', service: 'payment', percentile: 99 },
  ],
  whatChanged: [{ kind: 'whatChanged', window: 30 }],
  compare: [
    { kind: 'compare', service: 'payment', metric: 'p95', by: 'instance' },
    { kind: 'compare', service: 'payment', metric: 'p95', by: 'lastWeek' },
  ],
  askNpc: [
    { kind: 'askNpc', role: 'dev' },
    { kind: 'askNpc', role: 'dba' },
    { kind: 'askNpc', role: 'oncall' },
  ],
}

/** Baseline (no faults, no noise), seed `fixture`, asked at tick 30. */
function fixtureText(kind: QuestionKind): string {
  const sim = simAt({ system: defaultShop, seed: FIXTURE_SEED }, FIXTURE_TICK)
  const answers = fixtureQuestions[kind].map((q) => sim.ask(q))
  return `${JSON.stringify(answers, null, 2)}\n`
}

describe('fixtures/answers (regeneration)', () => {
  if (process.env['UPDATE_FIXTURES'] === '1') {
    mkdirSync(FIXTURE_DIR, { recursive: true })
    for (const kind of KINDS) writeFileSync(join(FIXTURE_DIR, `${kind}.json`), fixtureText(kind))
  }

  it('has exactly one fixture per question kind', () => {
    expect(readdirSync(FIXTURE_DIR).sort()).toEqual(KINDS.map((k) => `${k}.json`).sort())
  })

  for (const kind of KINDS) {
    it(`${kind}.json is byte-identical to a fresh regeneration`, () => {
      const onDisk = readFileSync(join(FIXTURE_DIR, `${kind}.json`), 'utf8')
      expect(onDisk).toBe(fixtureText(kind))
      const parsed = JSON.parse(onDisk) as Answer[]
      expect(parsed.length).toBeGreaterThan(0)
      for (const answer of parsed) {
        expect(answer.question.kind).toBe(kind)
        expect(answer.data.kind).toBe(kind)
        expect(answer.tickCost).toBe(tickCostTable[kind])
      }
    })
  }
})
