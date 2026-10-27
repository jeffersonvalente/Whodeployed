// @vitest-environment node
/**
 * Replay (T2.29; FASE-2 PR-14, PR-17, I24-6, DET; ADR-015 §7, ADR-016 §3).
 *
 * Logs come from the session core played on fixture scenarios (test/fixtures/scenarios.ts) and
 * from the committed PR-17 fixture (test/fixtures/logs/perf-360.json, 360 ticks, 40 questions),
 * recorded on the scenarios package's loader fixture YAML. Tampered logs are edited copies of the
 * canonical JSON. The CLI is exercised as a child process for its exit codes (0, 1, 2).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inRepertoire, toSimulationConfig } from '@whodeployed/scenarios'
import type { Scenario } from '@whodeployed/scenarios'
import { loadScenarioFile } from '@whodeployed/scenarios/node'
import { describe, expect, it, vi } from 'vitest'
import { engineRuntime } from '../../src/engine-runtime'
import { parseLog, serializeLog } from '../../src/session/log'
import { replayLog } from '../../src/session/replay'
import { makeCreateSession } from '../../src/session/session'
import type { ReviewSentences, SessionLogV1 } from '../../src/session/types'
import { juniorFixture, plenoFixture } from '../fixtures/scenarios'

const webDir = fileURLToPath(new URL('../..', import.meta.url))
const perfLogPath = fileURLToPath(new URL('../fixtures/logs/perf-360.json', import.meta.url))
const perfYamlPath = fileURLToPath(new URL('../../../../packages/scenarios/test/fixtures/valid.yaml', import.meta.url))
const tsxBin = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url))

const perfText = readFileSync(perfLogPath, 'utf8')
const perfScenario = loadScenarioFile(perfYamlPath, engineRuntime)
const deps = { engine: engineRuntime }

const createSession = makeCreateSession({ inRepertoire, toSimulationConfig })

/** Plays a pleno session with questions, an action, waits and an error-free mix of inputs. */
function playPleno(): SessionLogV1 {
  const session = createSession(plenoFixture, { engine: engineRuntime, wallClock: fakeClock(), engineVersion: '0.1.0', buildSha: 'unknown' })
  session.ask({ kind: 'whatChanged', window: 30 })
  session.ask({ kind: 'dashboard', service: 'gateway' })
  session.ask({ kind: 'logs', service: 'cart', window: 30, filter: { level: 'error' } })
  session.ask({ kind: 'compare', service: 'cart', metric: 'errorPct', by: 'instance' })
  session.ask({ kind: 'trace', service: 'cart', percentile: 95 })
  session.wait()
  session.act({ kind: 'rollback', target: 'cart' })
  session.wait()
  session.ask({ kind: 'dashboard', service: 'cart' })
  return session.log()
}

function playJunior(): SessionLogV1 {
  const session = createSession(juniorFixture, { engine: engineRuntime, wallClock: fakeClock(), engineVersion: '0.1.0', buildSha: 'unknown' })
  session.ask({ kind: 'logs', service: 'catalog', window: 30 })
  session.act({ kind: 'restart', target: 'catalog' })
  session.wait()
  session.ask({ kind: 'dashboard', service: 'gateway' })
  return session.log()
}

function fakeClock(): () => number {
  let t = 0
  return () => (t += 11)
}

/** Round trip through the exported file: what the QA and CI replay. */
function exported(log: SessionLogV1): SessionLogV1 {
  return parseLog(serializeLog(log))
}

/** The parsed JSON of a log, edited freely by the tampering tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any

/** A JSON copy to tamper with. */
function tamper(log: SessionLogV1, edit: (raw: Raw) => void): SessionLogV1 {
  const raw: Raw = JSON.parse(serializeLog(log))
  edit(raw)
  return raw as SessionLogV1
}

function stepIndex(log: SessionLogV1, type: string, nth = 0): number {
  const indexes = log.steps.flatMap((step, i) => (step.type === type ? [i] : []))
  const index = indexes[nth]
  if (index === undefined) throw new Error(`no ${type} step #${nth}`)
  return index
}

describe('replayLog on untouched logs (PR-14)', () => {
  it('replays a pleno session played by the session core, after export', () => {
    const log = playPleno()
    expect(replayLog(exported(log), plenoFixture, deps)).toEqual({ ok: true, steps: log.steps.length })
  })

  it('replays a junior session, also straight from session.log() without export', () => {
    const log = playJunior()
    expect(replayLog(log, juniorFixture, deps)).toEqual({ ok: true, steps: 4 })
    expect(replayLog(exported(log), juniorFixture, deps)).toEqual({ ok: true, steps: 4 })
  })

  it('replays an empty log (export right after the alert)', () => {
    const session = createSession(juniorFixture, { engine: engineRuntime, wallClock: () => 0, engineVersion: '0.1.0', buildSha: 'unknown' })
    expect(replayLog(exported(session.log()), juniorFixture, deps)).toEqual({ ok: true, steps: 0 })
  })

  it('ignores wallMs, the only non-deterministic field (DET, PR-12)', () => {
    const log = tamper(playPleno(), (raw) => {
      for (const step of raw.steps) step.wallMs = 123456
    })
    expect(replayLog(log, plenoFixture, deps).ok).toBe(true)
  })

  it('treats a key with value undefined as an absent key (I24-6)', () => {
    const log = tamper(playJunior(), (raw) => {
      raw.steps[0].question.filter = undefined
      raw.steps[0].answer.question.filter = undefined
    })
    expect('filter' in (log.steps[0] as { question: object }).question).toBe(true)
    expect(replayLog(log, juniorFixture, deps).ok).toBe(true)
  })

  it('does not mutate the log it replays and gives the same result twice', () => {
    const log = exported(playPleno())
    const before = serializeLog(log)
    const first = replayLog(log, plenoFixture, deps)
    const second = replayLog(log, plenoFixture, deps)
    expect(first).toEqual({ ok: true, steps: log.steps.length })
    expect(second).toEqual(first)
    expect(serializeLog(log)).toBe(before)
  })
})

describe('replayLog finds the first divergent step (PR-14)', () => {
  const base = playPleno()

  it('answer: a tampered signal value', () => {
    const i = stepIndex(base, 'ask', 1)
    const log = tamper(base, (raw) => {
      raw.steps[i].answer.data = { ...raw.steps[i].answer.data, tampered: true }
    })
    expect(replayLog(log, plenoFixture, deps)).toMatchObject({ ok: false, seq: i + 1, field: 'answer' })
  })

  it('answer: a different question (compared on the canonical JSON)', () => {
    const i = stepIndex(base, 'ask', 1)
    const log = tamper(base, (raw) => {
      raw.steps[i].question.service = 'auth'
    })
    expect(replayLog(log, plenoFixture, deps)).toMatchObject({ ok: false, seq: i + 1, field: 'answer' })
  })

  it('answer: a different action result', () => {
    const i = stepIndex(base, 'act')
    const log = tamper(base, (raw) => {
      raw.steps[i].result.tick += 1
    })
    expect(replayLog(log, plenoFixture, deps)).toMatchObject({ ok: false, seq: i + 1, field: 'answer' })
  })

  it('tickCost', () => {
    const i = stepIndex(base, 'wait')
    const log = tamper(base, (raw) => {
      raw.steps[i].tickCost = 2
    })
    expect(replayLog(log, plenoFixture, deps)).toMatchObject({ ok: false, seq: i + 1, field: 'tickCost' })
  })

  it('impactAfter', () => {
    const last = base.steps.length - 1
    const log = tamper(base, (raw) => {
      raw.steps[last].impactAfter -= 1
    })
    expect(replayLog(log, plenoFixture, deps)).toMatchObject({ ok: false, seq: last + 1, field: 'impactAfter' })
  })

  it('tickBefore, when a step was removed from the middle (seqs renumbered)', () => {
    const log = tamper(base, (raw) => {
      raw.steps.splice(1, 1)
      raw.steps.forEach((step: { seq: number }, i: number) => (step.seq = i + 1))
    })
    expect(replayLog(log, plenoFixture, deps)).toMatchObject({ ok: false, seq: 2, field: 'tickBefore' })
  })

  it('format: a seq out of order', () => {
    const log = tamper(base, (raw) => {
      raw.steps[2].seq = 7
    })
    expect(replayLog(log, plenoFixture, deps)).toMatchObject({ ok: false, seq: 3, field: 'format' })
  })

  it('format: unknown format or version, or a log of another scenario (seq 0)', () => {
    expect(replayLog(tamper(base, (raw) => (raw.version = 2)), plenoFixture, deps)).toMatchObject({ ok: false, seq: 0, field: 'format' })
    expect(replayLog(tamper(base, (raw) => (raw.format = 'x')), plenoFixture, deps)).toMatchObject({ ok: false, seq: 0, field: 'format' })
    expect(replayLog(base, juniorFixture, deps)).toMatchObject({ ok: false, seq: 0, field: 'format' })
    const otherSeed: Scenario = { ...plenoFixture, seed: 'another-seed' }
    expect(replayLog(base, otherSeed, deps)).toMatchObject({ ok: false, seq: 0, field: 'format' })
  })

  it('answer: a question outside the level repertoire is refused by the session (PR-6)', () => {
    const log = tamper(playJunior(), (raw) => {
      raw.steps[0].type = 'ask'
      raw.steps[0].question = { kind: 'trace', service: 'catalog', percentile: 95 }
    })
    expect(replayLog(log, juniorFixture, deps)).toMatchObject({ ok: false, seq: 1, field: 'answer' })
  })

  it('format: a notebook step the session refuses (discard citing no previous answer)', () => {
    const log = tamper(playJunior(), (raw) => {
      raw.steps.push({ seq: 5, tickBefore: raw.steps[3].tickBefore + raw.steps[3].tickCost, type: 'discard', hypothesisSeq: 99, citedSeqs: [99], tickCost: 0, impactAfter: raw.steps[3].impactAfter, wallMs: 0 })
    })
    expect(replayLog(log, juniorFixture, deps)).toMatchObject({ ok: false, seq: 5, field: 'format' })
  })
})

describe('PR-17 fixture: 360 ticks, 40 questions', () => {
  const log = parseLog(perfText)

  it('is a session of 360 ticks with 40 questions, ended by the tick limit, with a dashboard at tick >= 300', () => {
    const asks = log.steps.filter((step) => step.type === 'ask')
    expect(asks).toHaveLength(40)
    expect(asks.some((step) => step.tickBefore >= 300 && step.question.kind === 'dashboard')).toBe(true)
    expect(log.steps.at(-1)).toMatchObject({ type: 'end', reason: 'tickLimit', tickBefore: 360 })
    expect(log.scenario).toEqual({ id: perfScenario.id, seed: perfScenario.seed })
  })

  it('is canonical JSON (the exported file format)', () => {
    expect(serializeLog(log)).toBe(perfText)
  })

  it('replays ok', () => {
    expect(replayLog(log, perfScenario, deps)).toEqual({ ok: true, steps: log.steps.length })
  })

  it('fails when the tick-360 end step is missing or a step follows it', () => {
    const noEnd = tamper(log, (raw) => raw.steps.pop())
    expect(replayLog(noEnd, perfScenario, deps)).toMatchObject({ ok: false, seq: log.steps.length, field: 'format' })
    const afterEnd = tamper(log, (raw) => {
      raw.steps.push({ seq: raw.steps.length + 1, tickBefore: 360, type: 'wait', tickCost: 0, impactAfter: 0, wallMs: 0 })
    })
    expect(replayLog(afterEnd, perfScenario, deps)).toMatchObject({ ok: false, seq: log.steps.length + 1, field: 'format' })
  })

  it('review: checked with the injected builder; never passed unchecked', () => {
    const sentences: ReviewSentences = ['One.', 'Two.', 'Three.']
    const reviewed = tamper(log, (raw) => (raw.review = [...sentences]))
    const review = vi.fn(() => sentences)
    expect(replayLog(reviewed, perfScenario, { engine: engineRuntime, review })).toEqual({ ok: true, steps: log.steps.length })
    expect(review).toHaveBeenCalledTimes(1)
    expect(replayLog(reviewed, perfScenario, { engine: engineRuntime, review: () => ['One.', 'Two.', 'Other.'] })).toMatchObject({
      ok: false,
      seq: log.steps.length,
      field: 'review',
    })
    expect(replayLog(reviewed, perfScenario, deps)).toMatchObject({ ok: false, field: 'review' })
  })

  it('format: finalHypothesis that does not match the end step', () => {
    const wrong = tamper(log, (raw) => (raw.finalHypothesis = { kind: 'active', hypothesisSeq: 1 }))
    expect(replayLog(wrong, perfScenario, deps)).toMatchObject({ ok: false, field: 'format' })
  })
})

describe('scripts/replay.ts (PR-14 exit codes)', () => {
  function run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(tsxBin, ['scripts/replay.ts', ...args], { cwd: webDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, stdout, stderr: '' }
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string }
      return { code: e.status, stdout: e.stdout, stderr: e.stderr }
    }
  }

  it('exits 0 on the PR-17 fixture, with `--` passed through by pnpm', () => {
    const result = run(['--', perfLogPath, perfYamlPath])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`replay: ok ${parseLog(perfText).steps.length} steps`)
  }, 30_000)

  it('exits 1 naming the seq and field of the first divergent step', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'wd-replay-'))
    const bad = tamper(parseLog(perfText), (raw) => (raw.steps[5].impactAfter += 1))
    const file = join(dir, 'bad.json')
    writeFileSync(file, serializeLog(bad))
    const result = run([file, perfYamlPath])
    rmSync(dir, { recursive: true, force: true })
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('replay: FAIL seq 6 field impactAfter')
  }, 30_000)

  it('exits 2 on usage error', () => {
    expect(run([]).code).toBe(2)
    expect(run([perfLogPath, '/nonexistent/scenario.yaml']).code).toBe(2)
    expect(run(['/nonexistent/log.json', perfYamlPath]).code).toBe(2)
  }, 60_000)
})
