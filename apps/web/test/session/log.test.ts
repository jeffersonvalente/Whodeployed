/**
 * T2.24 — session log v1, canonical JSON (ADR-016 §2, I24-6, PR-13) and manual export.
 *   - serialization in ADR-016 order (golden string of a short log), whatever the input key order;
 *   - `undefined` omitted (I24-6), `discard.text` omitted when empty;
 *   - only the declared top-level and step keys are written (no forbidden field, PR-13);
 *   - comparison of logs ignores only `wallMs` (PR-12);
 *   - DET: same log => same string; parse + serialize is the identity on canonical text;
 *   - export: download and clipboard write exactly the canonical text (PR-13).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Answer } from '@whodeployed/engine'
import { describe, expect, it, vi } from 'vitest'
import { copyLog, downloadLog, exportFileName } from '../../src/review/export'
import { LogFormatError, canonicalLog, logsEqual, parseLog, serializeLog, withoutWallMs } from '../../src/session/log'
import type { SessionLogV1, SessionStep } from '../../src/session/types'

/** A short log with one step of each type, built in ADR-016 order. */
function shortLog(): SessionLogV1 {
  return {
    format: 'whodeployed-session-log',
    version: 1,
    scenario: { id: '91-fixture-junior', seed: 'fixture-junior-01' },
    engine: { version: '0.1.0' },
    build: { sha: 'unknown' },
    steps: [
      {
        seq: 1,
        tickBefore: 14,
        type: 'ask',
        question: { kind: 'whatChanged', window: 30 },
        answer: {
          question: { kind: 'whatChanged', window: 30 },
          data: { kind: 'whatChanged', from: 0, to: 14, events: [] },
          tickCost: 1,
        },
        tickCost: 1,
        impactAfter: 0,
        wallMs: 1200,
      },
      { seq: 2, tickBefore: 15, type: 'hypothesis', component: 'catalog', text: 'catalog crashes', tickCost: 0, impactAfter: 0, wallMs: 5000 },
      { seq: 3, tickBefore: 15, type: 'discard', hypothesisSeq: 2, citedSeqs: [1], text: 'nothing changed', tickCost: 0, impactAfter: 0, wallMs: 6000 },
      { seq: 4, tickBefore: 15, type: 'wait', tickCost: 1, impactAfter: 1, wallMs: 7000 },
      {
        seq: 5,
        tickBefore: 16,
        type: 'act',
        action: { kind: 'restart', target: 'catalog' },
        result: { action: { kind: 'restart', target: 'catalog' }, tick: 16, tickCost: 3 },
        tickCost: 3,
        impactAfter: 2,
        wallMs: 9000,
      },
      { seq: 6, tickBefore: 19, type: 'end', final: { kind: 'new', component: 'catalog', text: 'crash loop' }, reason: 'player', tickCost: 0, impactAfter: 2, wallMs: 9500 },
    ],
    finalHypothesis: { kind: 'new', component: 'catalog', text: 'crash loop' },
    review: ['Sentence one.', 'Sentence two.', 'Sentence three.'],
  }
}

const GOLDEN =
  '{"format":"whodeployed-session-log","version":1,' +
  '"scenario":{"id":"91-fixture-junior","seed":"fixture-junior-01"},' +
  '"engine":{"version":"0.1.0"},"build":{"sha":"unknown"},"steps":[' +
  '{"seq":1,"tickBefore":14,"type":"ask","question":{"kind":"whatChanged","window":30},' +
  '"answer":{"question":{"kind":"whatChanged","window":30},"data":{"kind":"whatChanged","from":0,"to":14,"events":[]},"tickCost":1},' +
  '"tickCost":1,"impactAfter":0,"wallMs":1200},' +
  '{"seq":2,"tickBefore":15,"type":"hypothesis","component":"catalog","text":"catalog crashes","tickCost":0,"impactAfter":0,"wallMs":5000},' +
  '{"seq":3,"tickBefore":15,"type":"discard","hypothesisSeq":2,"citedSeqs":[1],"text":"nothing changed","tickCost":0,"impactAfter":0,"wallMs":6000},' +
  '{"seq":4,"tickBefore":15,"type":"wait","tickCost":1,"impactAfter":1,"wallMs":7000},' +
  '{"seq":5,"tickBefore":16,"type":"act","action":{"kind":"restart","target":"catalog"},' +
  '"result":{"action":{"kind":"restart","target":"catalog"},"tick":16,"tickCost":3},"tickCost":3,"impactAfter":2,"wallMs":9000},' +
  '{"seq":6,"tickBefore":19,"type":"end","final":{"kind":"new","component":"catalog","text":"crash loop"},"reason":"player","tickCost":0,"impactAfter":2,"wallMs":9500}' +
  '],"finalHypothesis":{"kind":"new","component":"catalog","text":"crash loop"},' +
  '"review":["Sentence one.","Sentence two.","Sentence three."]}\n'

/**
 * Same content, every object built with its keys in reverse order, except Signal payloads
 * (`answer.data`), which are kept as the engine returned them (ADR-016 §2).
 */
function reversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedKeys) as T
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([k, v]) => [k, k === 'data' ? v : reversedKeys(v)]),
  ) as T
}

/** packages/engine/fixtures/answers, found from the working directory (the repo root or apps/web). */
function answersDir(): string {
  let dir = process.cwd()
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error('repository root not found')
    dir = parent
  }
  return join(dir, 'packages', 'engine', 'fixtures', 'answers')
}

const TOP_LEVEL_KEYS = ['format', 'version', 'scenario', 'engine', 'build', 'steps', 'finalHypothesis', 'review']
const STEP_KEYS: Record<SessionStep['type'], string[]> = {
  ask: ['seq', 'tickBefore', 'type', 'question', 'answer', 'tickCost', 'impactAfter', 'wallMs'],
  act: ['seq', 'tickBefore', 'type', 'action', 'result', 'tickCost', 'impactAfter', 'wallMs'],
  wait: ['seq', 'tickBefore', 'type', 'tickCost', 'impactAfter', 'wallMs'],
  hypothesis: ['seq', 'tickBefore', 'type', 'component', 'text', 'tickCost', 'impactAfter', 'wallMs'],
  discard: ['seq', 'tickBefore', 'type', 'hypothesisSeq', 'citedSeqs', 'text', 'tickCost', 'impactAfter', 'wallMs'],
  end: ['seq', 'tickBefore', 'type', 'final', 'reason', 'tickCost', 'impactAfter', 'wallMs'],
}

describe('serializeLog: canonical JSON (ADR-016 §2)', () => {
  it('writes the golden string of a short log: ADR-016 key order, no whitespace, one trailing newline', () => {
    expect(serializeLog(shortLog())).toBe(GOLDEN)
  })

  it('writes the same string whatever the key order of the input objects', () => {
    expect(serializeLog(reversedKeys(shortLog()))).toBe(GOLDEN)
  })

  it('writes null for finalHypothesis and review before the end (export at any time)', () => {
    const log = { ...shortLog(), steps: shortLog().steps.slice(0, 1), finalHypothesis: null, review: null }
    expect(serializeLog(log)).toMatch(/,"finalHypothesis":null,"review":null}\n$/)
  })

  it('omits keys whose value is undefined (I24-6: filter undefined = no filter)', () => {
    const base = shortLog()
    const withUndefined: SessionLogV1 = {
      ...base,
      steps: [
        {
          seq: 1,
          tickBefore: 14,
          type: 'ask',
          question: { kind: 'logs', service: 'catalog', window: 30, filter: undefined } as never,
          answer: {
            question: { kind: 'logs', service: 'catalog', window: 30, filter: undefined } as never,
            data: { kind: 'logs', service: 'catalog', from: 0, to: 14, entries: [] },
            tickCost: 2,
          },
          tickCost: 2,
          impactAfter: 0,
          wallMs: 0,
        },
        { seq: 2, tickBefore: 16, type: 'act', action: { kind: 'restart', target: undefined } as never, result: { action: { kind: 'restart' }, tick: 16, tickCost: 3 }, tickCost: 3, impactAfter: 0, wallMs: 0 },
      ],
    }
    const absent: SessionLogV1 = {
      ...withUndefined,
      steps: [
        { ...(withUndefined.steps[0] as SessionStep & { type: 'ask' }), question: { kind: 'logs', service: 'catalog', window: 30 }, answer: { ...(withUndefined.steps[0] as SessionStep & { type: 'ask' }).answer, question: { kind: 'logs', service: 'catalog', window: 30 } } },
        { ...(withUndefined.steps[1] as SessionStep & { type: 'act' }), action: { kind: 'restart' } },
      ],
    }
    const text = serializeLog(withUndefined)
    expect(text).not.toContain('filter')
    expect(text).not.toContain('undefined')
    expect(text).toContain('"action":{"kind":"restart"},"result"')
    expect(text).toBe(serializeLog(absent))
  })

  it('keeps the filter of a logs question, after window', () => {
    const log = shortLog()
    const step = {
      ...(log.steps[0] as SessionStep & { type: 'ask' }),
      question: { filter: { level: 'error' }, window: 30, service: 'catalog', kind: 'logs' } as const,
    }
    expect(serializeLog({ ...log, steps: [step] })).toContain('"question":{"kind":"logs","service":"catalog","window":30,"filter":{"level":"error"}},')
  })

  it('omits discard.text when undefined or empty (ADR-016 §1)', () => {
    const log = shortLog()
    const discard = log.steps[2] as SessionStep & { type: 'discard' }
    const withoutText: SessionStep = { ...discard }
    delete withoutText.text
    const noText = serializeLog({ ...log, steps: [withoutText] })
    const emptyText = serializeLog({ ...log, steps: [{ ...discard, text: '' }] })
    expect(noText).toContain('"citedSeqs":[1],"tickCost":0')
    expect(emptyText).toBe(noText)
  })

  it('writes only the declared top-level and step keys (no forbidden field, PR-13)', () => {
    const polluted = {
      ...shortLog(),
      player: 'Ana',
      userAgent: 'Mozilla/5.0',
      startedAt: '2026-10-27T10:00:00Z',
      steps: shortLog().steps.map((step) => ({ ...step, date: '2026-10-27', language: 'pt-BR' })),
      scenario: { id: '91-fixture-junior', seed: 'fixture-junior-01', title: 'x' },
    } as unknown as SessionLogV1
    const parsed = JSON.parse(serializeLog(polluted)) as Record<string, unknown> & { steps: Record<string, unknown>[] }
    expect(Object.keys(parsed)).toEqual(TOP_LEVEL_KEYS)
    expect(Object.keys(parsed['scenario'] as object)).toEqual(['id', 'seed'])
    for (const step of parsed.steps) {
      expect(Object.keys(step)).toEqual(STEP_KEYS[step['type'] as SessionStep['type']])
    }
    expect(parsed.steps.map((s) => s['type'])).toEqual(['ask', 'hypothesis', 'discard', 'wait', 'act', 'end'])
    expect(serializeLog(polluted)).toBe(GOLDEN)
  })

  it('keeps every engine answer of the fixtures byte for byte (answer.data in engine order)', () => {
    const kinds = ['dashboard', 'logs', 'trace', 'whatChanged', 'compare', 'askNpc'] as const
    for (const kind of kinds) {
      const path = join(answersDir(), `${kind}.json`)
      const answers = JSON.parse(readFileSync(path, 'utf8')) as Answer[]
      expect(answers.length).toBeGreaterThan(0)
      const steps: SessionStep[] = answers.map((answer, i) => ({
        seq: i + 1,
        tickBefore: 30,
        type: 'ask',
        question: answer.question,
        answer,
        tickCost: answer.tickCost,
        impactAfter: 0,
        wallMs: 0,
      }))
      const log: SessionLogV1 = { ...shortLog(), steps, finalHypothesis: null, review: null }
      const written = JSON.parse(serializeLog(log)) as { steps: { answer: unknown }[] }
      expect(written.steps.map((s) => JSON.stringify(s.answer))).toEqual(answers.map((a) => JSON.stringify(a)))
    }
  })
})

describe('determinism (DET)', () => {
  it('same log => same string, and serializing does not change the input', () => {
    const log = shortLog()
    const before = JSON.stringify(log)
    expect(serializeLog(log)).toBe(serializeLog(log))
    expect(serializeLog(log)).toBe(serializeLog(shortLog()))
    expect(JSON.stringify(log)).toBe(before)
  })

  it('parse + serialize is the identity on canonical text', () => {
    expect(serializeLog(parseLog(GOLDEN))).toBe(GOLDEN)
  })

  it('canonicalLog is the parsed canonical string', () => {
    expect(canonicalLog(shortLog())).toEqual(JSON.parse(GOLDEN))
  })
})

describe('logsEqual: canonical strings, ignoring only wallMs (PR-12)', () => {
  it('equal when only wallMs differs', () => {
    const other = { ...shortLog(), steps: shortLog().steps.map((s, i) => ({ ...s, wallMs: 99_999 + i })) }
    expect(logsEqual(shortLog(), other)).toBe(true)
    expect(serializeLog(shortLog())).not.toBe(serializeLog(other))
  })

  it('equal when only key order differs', () => {
    expect(logsEqual(shortLog(), reversedKeys(shortLog()))).toBe(true)
  })

  it('different when any other field differs', () => {
    const variants: ((s: SessionStep) => SessionStep)[] = [
      (s) => ({ ...s, tickCost: s.tickCost + 1 }),
      (s) => ({ ...s, impactAfter: s.impactAfter + 1 }),
      (s) => ({ ...s, tickBefore: s.tickBefore + 1 }),
      (s) => ({ ...s, seq: s.seq + 10 }),
    ]
    for (const change of variants) {
      const steps = shortLog().steps.map((s, i) => (i === 0 ? change(s) : s))
      expect(logsEqual(shortLog(), { ...shortLog(), steps })).toBe(false)
    }
    const ask = shortLog().steps[0] as SessionStep & { type: 'ask' }
    const otherAnswer = { ...ask, answer: { ...ask.answer, data: { kind: 'whatChanged' as const, from: 1, to: 14, events: [] } } }
    expect(logsEqual(shortLog(), { ...shortLog(), steps: [otherAnswer, ...shortLog().steps.slice(1)] })).toBe(false)
    expect(logsEqual(shortLog(), { ...shortLog(), review: null })).toBe(false)
    expect(logsEqual(shortLog(), { ...shortLog(), build: { sha: 'a'.repeat(40) } })).toBe(false)
  })

  it('withoutWallMs zeroes every wallMs without touching the input', () => {
    const log = shortLog()
    expect(withoutWallMs(log).steps.map((s) => s.wallMs)).toEqual([0, 0, 0, 0, 0, 0])
    expect(log.steps.map((s) => s.wallMs)).toEqual([1200, 5000, 6000, 7000, 9000, 9500])
  })
})

describe('parseLog', () => {
  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['another format', JSON.stringify({ ...JSON.parse(GOLDEN), format: 'other' })],
    ['version 2', JSON.stringify({ ...JSON.parse(GOLDEN), version: 2 })],
    ['no scenario seed', JSON.stringify({ ...JSON.parse(GOLDEN), scenario: { id: 'x' } })],
    ['steps not an array', JSON.stringify({ ...JSON.parse(GOLDEN), steps: {} })],
    ['review with 2 sentences', JSON.stringify({ ...JSON.parse(GOLDEN), review: ['a', 'b'] })],
  ])('rejects %s with LogFormatError', (_name, text) => {
    expect(() => parseLog(text)).toThrow(LogFormatError)
  })
})

/** jsdom's Blob has no text(); FileReader reads it. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsText(blob)
  })
}

describe('export (PR-13): download and clipboard write the canonical text', () => {
  it('downloads a JSON file named after the scenario, then cleans up', async () => {
    const blobs: Blob[] = []
    const deferred: (() => void)[] = []
    const revoke = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('whodeployed-91-fixture-junior.json')
      expect(this.href).toBe('blob:test/1')
      expect(document.body.contains(this)).toBe(true)
    })
    downloadLog(shortLog(), {
      document,
      createObjectURL: (blob) => {
        blobs.push(blob)
        return 'blob:test/1'
      },
      revokeObjectURL: revoke,
      defer: (task) => deferred.push(task),
    })
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
    expect(document.querySelectorAll('a')).toHaveLength(0)
    expect(blobs).toHaveLength(1)
    expect(blobs[0]?.type).toBe('application/json')
    expect(await readBlob(blobs[0] as Blob)).toBe(GOLDEN)
    expect(revoke).not.toHaveBeenCalled()
    for (const task of deferred) task()
    expect(revoke).toHaveBeenCalledWith('blob:test/1')
  })

  it('file name carries only the scenario id (no date, no player data)', () => {
    expect(exportFileName(shortLog())).toBe('whodeployed-91-fixture-junior.json')
    expect(exportFileName({ ...shortLog(), scenario: { id: '../a b', seed: 's' } })).toBe('whodeployed-.._a_b.json')
  })

  it('copies the canonical text to the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    await expect(copyLog(shortLog(), { writeText })).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith(GOLDEN)
  })

  it('reports a missing or refusing clipboard without throwing', async () => {
    await expect(copyLog(shortLog(), undefined)).resolves.toBe('unavailable')
    await expect(copyLog(shortLog(), { writeText: () => Promise.reject(new Error('denied')) })).resolves.toBe('failed')
  })
})
