/**
 * Text rendering of answers (T2.26, PR-7). One describe per kind of the Pleno repertoire
 * (dashboard, logs, trace, whatChanged, compare by instance), over the engine fixtures in
 * packages/engine/fixtures/answers/*.json: the rendered text holds every value of Answer.data,
 * verbatim (`String(value)`), plus the tick of the question and its tickCost. No `style`,
 * `<svg>` or `<canvas>` in the markup (PR-2).
 *
 * The whatChanged fixture has no events, so a second whatChanged answer is produced by the real
 * engine (public API only) with a fault and two noise events.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, within } from '@testing-library/react'
import { createSimulation, defaultShop, resolveFaults } from '@whodeployed/engine'
import type {
  Answer,
  CompareSignal,
  DashboardSignal,
  LogsSignal,
  NpcSignal,
  Question,
  SpanRecord,
  TraceSignal,
  WhatChangedSignal,
} from '@whodeployed/engine'
import { afterEach, describe, expect, it } from 'vitest'
import { AnswerView } from '../../src/signals/answer-view'
import { METRIC_NAMES, describeQuestion } from '../../src/signals/text'

afterEach(cleanup)

// Vitest's __dirname (import.meta.url is not a file: URL under jsdom).
const answersDir = join(__dirname, '..', '..', '..', '..', 'packages', 'engine', 'fixtures', 'answers')

function fixture(name: string): Answer[] {
  return JSON.parse(readFileSync(join(answersDir, `${name}.json`), 'utf8')) as Answer[]
}

function signalOf<T>(answer: Answer): T {
  return answer.data as T
}

/** Renders the answer and returns its <article>, after checking the common header (PR-7). */
function renderAnswer(answer: Answer, askedAt: number): HTMLElement {
  const { container } = render(<AnswerView answer={answer} askedAt={askedAt} />)
  expect(container.innerHTML).not.toMatch(/style=|<style|<svg|<canvas/i)
  const article = within(container).getByRole('article', { name: describeQuestion(answer.question) })
  const cost = answer.tickCost === 1 ? 'cost 1 tick' : `cost ${answer.tickCost} ticks`
  expect(within(article).getByText(`Asked at tick ${askedAt}, ${cost}`)).toBeTruthy()
  expect(within(article).getByRole('heading', { level: 3 }).textContent).toBe(describeQuestion(answer.question))
  return article
}

function cellTexts(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent ?? '')
}

/** Text of a list item without its nested lists (the span's own line in the trace tree). */
function ownText(li: Element): string {
  return Array.from(li.childNodes)
    .filter((node) => node.nodeName !== 'UL')
    .map((node) => node.textContent ?? '')
    .join('')
}

describe('dashboard (tick x metric table)', () => {
  const answers = fixture('dashboard')

  it('has the 3 fixture answers', () => {
    expect(answers.map((a) => a.question)).toEqual([
      { kind: 'dashboard', service: 'gateway' },
      { kind: 'dashboard', service: 'payment' },
      { kind: 'dashboard', service: 'postgres' },
    ])
  })

  it.each(answers.map((a) => [signalOf<DashboardSignal>(a).service, a] as const))('renders every value of %s', (service, answer) => {
    const signal = signalOf<DashboardSignal>(answer)
    const article = renderAnswer(answer, signal.to)
    const table = within(article).getByRole('table')
    expect(within(table).getByText(`Dashboard of ${service}, ticks ${signal.from}-${signal.to}`)).toBeTruthy()
    const [head, ...rows] = within(table).getAllByRole('row')
    expect(cellTexts(head as HTMLElement)).toEqual(['tick', ...METRIC_NAMES])
    expect(rows).toHaveLength(signal.records.length)
    signal.records.forEach((record, index) => {
      // No field of the record is left out: besides the discriminators, only the 8 metrics.
      expect(Object.keys(record).filter((key) => !['type', 'tick', 'component'].includes(key)).sort()).toEqual([...METRIC_NAMES].sort())
      expect(record.component).toBe(service)
      expect(cellTexts(rows[index] as HTMLElement)).toEqual([String(record.tick), ...METRIC_NAMES.map((m) => String(record[m]))])
    })
  })

  it('shows 3 sample values exactly as in the JSON (QA spot check)', () => {
    const payment = answers[1] as Answer
    const records = signalOf<DashboardSignal>(payment).records
    const article = renderAnswer(payment, 30)
    const rows = within(article).getAllByRole('row').slice(1)
    for (const [tick, metric] of [[0, 'p95'], [15, 'cpu'], [30, 'connections']] as const) {
      const record = records.find((r) => r.tick === tick)
      expect(record).toBeDefined()
      const cells = cellTexts(rows[records.indexOf(record as (typeof records)[number])] as HTMLElement)
      expect(cells[1 + METRIC_NAMES.indexOf(metric)]).toBe(String(record?.[metric]))
    }
  })
})

describe('compare by instance (tick x instance table)', () => {
  const [byInstance, byLastWeek] = fixture('compare') as [Answer, Answer]

  it.each([
    ['instance', byInstance],
    ['lastWeek', byLastWeek],
  ] as const)('renders every point of every series (by %s)', (by, answer) => {
    const signal = signalOf<CompareSignal>(answer)
    expect(signal.by).toBe(by)
    const article = renderAnswer(answer, signal.to)
    const table = within(article).getByRole('table')
    expect(
      within(table).getByText(`${signal.metric} of ${signal.service} by ${by}, ticks ${signal.from}-${signal.to}`),
    ).toBeTruthy()
    const [head, ...rows] = within(table).getAllByRole('row')
    expect(cellTexts(head as HTMLElement)).toEqual(['tick', ...signal.series.map((s) => s.label)])
    const ticks = (signal.series[0]?.points ?? []).map((p) => p.tick)
    expect(rows).toHaveLength(ticks.length)
    signal.series.forEach((series, column) => {
      expect(series.points.map((p) => p.tick)).toEqual(ticks)
      series.points.forEach((point, row) => {
        const cells = cellTexts(rows[row] as HTMLElement)
        expect(cells[0]).toBe(String(point.tick))
        expect(cells[1 + column]).toBe(String(point.value))
      })
    })
  })

  it('shows "no value" for a tick missing from one series, never an invented number', () => {
    const signal = signalOf<CompareSignal>(byInstance)
    const [first, ...others] = signal.series
    const gapped: Answer = {
      ...byInstance,
      data: { ...signal, series: [{ label: first?.label ?? '', points: (first?.points ?? []).slice(1) }, ...others] },
    }
    const article = renderAnswer(gapped, signal.to)
    const firstRow = within(article).getAllByRole('row')[1] as HTMLElement
    expect(cellTexts(firstRow)[1]).toBe('no value')
  })
})

describe('logs (one line per entry)', () => {
  const [all, filtered] = fixture('logs') as [Answer, Answer]

  it('renders one list item per entry with every field and attr', () => {
    const signal = signalOf<LogsSignal>(all)
    expect(signal.entries.length).toBeGreaterThan(0)
    const article = renderAnswer(all, signal.to)
    expect(within(article).getByText(`${signal.entries.length} log entries of payment, ticks ${signal.from}-${signal.to}`)).toBeTruthy()
    const items = within(article).getAllByRole('listitem')
    expect(items).toHaveLength(signal.entries.length)
    signal.entries.forEach((entry, index) => {
      const fields = (items[index]?.textContent ?? '').split(' | ')
      const expected = [`tick ${entry.tick}`, entry.component, entry.instance, entry.level, entry.message]
      if (entry.traceId !== undefined) expected.push(`trace ${entry.traceId}`)
      for (const [key, value] of Object.entries(entry.attrs ?? {})) expected.push(`${key}=${String(value)}`)
      expect(fields).toEqual(expected)
    })
  })

  it('shows the filter in the question and an empty result as a count of 0', () => {
    const signal = signalOf<LogsSignal>(filtered)
    expect(signal.entries).toEqual([])
    const article = renderAnswer(filtered, signal.to)
    expect(within(article).getByRole('heading', { level: 3 }).textContent).toBe('logs gateway window 30 filter level=error')
    expect(within(article).getByText(`0 log entries of gateway, ticks ${signal.from}-${signal.to}`)).toBeTruthy()
    expect(within(article).queryAllByRole('listitem')).toEqual([])
  })
})

describe('trace (indented span tree)', () => {
  const answers = fixture('trace')

  it.each(answers.map((a) => [signalOf<TraceSignal>(a).percentile, a] as const))('renders every span of the p%s trace in its place', (percentile, answer) => {
    const signal = signalOf<TraceSignal>(answer)
    expect(signal.spans.length).toBeGreaterThan(0)
    const article = renderAnswer(answer, signal.tick)
    const traceIds = [...new Set(signal.spans.map((s) => s.traceId))]
    expect(
      within(article).getByText(`Trace of a p${percentile} request of payment at tick ${signal.tick}, ${traceIds.map((t) => `trace ${t}`).join(', ')}`),
    ).toBeTruthy()

    const items = within(article).getAllByRole('listitem')
    expect(items).toHaveLength(signal.spans.length)
    const bySpanId = new Map<string, Element>()
    for (const li of items) {
      const fields = ownText(li).replace(/ \(focus span\)$/, '').split(' | ')
      bySpanId.set((fields.at(-1) ?? '').replace(/^span /, ''), li)
    }
    for (const span of signal.spans) {
      const li = bySpanId.get(span.spanId)
      expect(li, span.spanId).toBeDefined()
      const expected = [span.component, span.instance, span.operation, span.kind]
      if (span.peer !== undefined) expected.push(`calls ${span.peer}`)
      expected.push(`start ${span.startMs} ms`, `duration ${span.durationMs} ms`, span.status, `span ${span.spanId}`)
      const line = ownText(li as Element)
      const isFocus = span.spanId === signal.focusSpanId
      expect(line.endsWith(' (focus span)')).toBe(isFocus)
      expect(line.replace(/ \(focus span\)$/, '').split(' | ')).toEqual(expected)
      // Indentation = nesting: the enclosing list item is the parent span's.
      const parentLi = li?.parentElement?.closest('li') ?? null
      expect(parentLi === null ? undefined : [...bySpanId].find(([, el]) => el === parentLi)?.[0]).toBe(span.parentId)
    }
    const focus = signal.spans.find((s: SpanRecord) => s.spanId === signal.focusSpanId)
    expect(focus?.kind).toBe('server')
    expect(within(article).getByText(/\(focus span\)$/).tagName).toBe('STRONG')
  })

  it('says when the service served nothing in the tick', () => {
    const answer = answers[0] as Answer
    const empty: Answer = { ...answer, data: { ...signalOf<TraceSignal>(answer), focusSpanId: null, spans: [] } }
    const article = renderAnswer(empty, 30)
    expect(within(article).getByText('No requests served by payment at tick 30.')).toBeTruthy()
  })
})

describe('whatChanged (list of events)', () => {
  it('renders the empty fixture with its window', () => {
    const [answer] = fixture('whatChanged') as [Answer]
    const signal = signalOf<WhatChangedSignal>(answer)
    expect(signal.events).toEqual([])
    const article = renderAnswer(answer, signal.to)
    expect(within(article).getByText(`No deploys or config changes in this window. (ticks ${signal.from}-${signal.to})`)).toBeTruthy()
  })

  it('renders every event the engine returns, without telling fault from noise', () => {
    const world = createSimulation({ system: defaultShop, seed: 't2.26-what-changed' }).world
    const sim = createSimulation({
      system: defaultShop,
      seed: 't2.26-what-changed',
      faults: resolveFaults([{ kind: 'bad_deploy', target: 'catalog', startTick: 12 }], world),
      noise: [
        { kind: 'deploy', target: 'cart', tick: 5, note: 'copy change' },
        { kind: 'config', target: 'auth', tick: 8, instance: 'auth-1' },
      ],
    })
    sim.advance(30)
    const question: Question = { kind: 'whatChanged', window: 30 }
    const answer = sim.ask(question)
    const signal = signalOf<WhatChangedSignal>(answer)
    expect(signal.events.length).toBeGreaterThanOrEqual(3)

    const article = renderAnswer(answer, sim.world.tick)
    expect(within(article).getByText(`${signal.events.length} changes (deploy or config), ticks ${signal.from}-${signal.to}`)).toBeTruthy()
    const items = within(article).getAllByRole('listitem')
    expect(items).toHaveLength(signal.events.length)
    signal.events.forEach((event, index) => {
      const expected = [`tick ${event.tick}`, event.kind, event.target]
      if (event.instance !== undefined) expected.push(`instance ${event.instance}`)
      if (event.restart === true) expected.push('restart')
      if (event.note !== undefined) expected.push(`note: ${event.note}`)
      expect((items[index]?.textContent ?? '').split(' | ')).toEqual(expected)
    })
    expect(article.textContent).not.toMatch(/fault|noise|bad_deploy/i)
  })
})

describe('askNpc (structured hints, Senior repertoire)', () => {
  it.each(fixture('askNpc').map((a) => [signalOf<NpcSignal>(a).role, a] as const))('renders every hint of %s', (role, answer) => {
    const signal = signalOf<NpcSignal>(answer)
    const article = renderAnswer(answer, signal.tick)
    const items = within(article).queryAllByRole('listitem')
    expect(items).toHaveLength(signal.hints.length)
    expect(article.textContent).toContain(`${role}: `)
    signal.hints.forEach((hint, index) => {
      const expected: string[] = [hint.component]
      if (hint.instance !== undefined) expected.push(hint.instance)
      expected.push(hint.metric, `current ${hint.current}`, `usual ${hint.usual}`)
      expect((items[index]?.textContent ?? '').split(' | ')).toEqual(expected)
    })
  })
})

describe('header', () => {
  it('shows the tick of the question given by the step, not one taken from the signal', () => {
    const [answer] = fixture('dashboard') as [Answer]
    renderAnswer(answer, 17)
  })
})
