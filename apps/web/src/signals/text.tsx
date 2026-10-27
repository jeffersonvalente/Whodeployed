/**
 * Shared text of the signal views (PR-7, ADR-015 §3). Phase 2 is unstyled HTML (PR-2): plain
 * semantic elements and default browser rendering only.
 *
 * Every number the player sees comes verbatim from Answer.data (`String(value)`, no rounding):
 * the UI adds no simulation logic and no value of its own (SPEC §3.3, PR-7).
 * UI strings live in this module so that the phase 3 i18n file can replace them in one place.
 */
import type { Answer, MetricName, Question } from '@whodeployed/engine'

/** The 8 metrics in the order of SPEC §4 / ADR-005 (the order of MetricValues). */
export const METRIC_NAMES: readonly MetricName[] = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']

export const text = {
  ticks: (n: number) => (n === 1 ? '1 tick' : `${n} ticks`),
  askedAt: (tick: number) => `Asked at tick ${tick}`,
  cost: (n: number) => `cost ${text.ticks(n)}`,
  range: (from: number, to: number) => `ticks ${from}-${to}`,
  tick: 'tick',
  noValue: 'no value',
  dashboard: {
    caption: (service: string, from: number, to: number) => `Dashboard of ${service}, ${text.range(from, to)}`,
    empty: 'No metric records in this window.',
  },
  compare: {
    caption: (service: string, metric: string, by: string, from: number, to: number) =>
      `${metric} of ${service} by ${by}, ${text.range(from, to)}`,
    empty: 'No series in this window.',
  },
  logs: {
    caption: (service: string, from: number, to: number, count: number) =>
      `${count} log ${count === 1 ? 'entry' : 'entries'} of ${service}, ${text.range(from, to)}`,
    trace: (traceId: string) => `trace ${traceId}`,
  },
  trace: {
    caption: (service: string, percentile: number, tick: number) => `Trace of a p${percentile} request of ${service} at tick ${tick}`,
    traceId: (traceId: string) => `trace ${traceId}`,
    empty: (service: string, tick: number) => `No requests served by ${service} at tick ${tick}.`,
    start: (ms: number) => `start ${ms} ms`,
    duration: (ms: number) => `duration ${ms} ms`,
    calls: (peer: string) => `calls ${peer}`,
    span: (spanId: string) => `span ${spanId}`,
    focus: 'focus span',
  },
  whatChanged: {
    caption: (from: number, to: number, count: number) =>
      `${count} ${count === 1 ? 'change' : 'changes'} (deploy or config), ${text.range(from, to)}`,
    empty: 'No deploys or config changes in this window.',
    instance: (instance: string) => `instance ${instance}`,
    restart: 'restart',
    note: (note: string) => `note: ${note}`,
  },
  askNpc: {
    caption: (role: string, tick: number, count: number) =>
      `${role}: ${count} ${count === 1 ? 'anomaly' : 'anomalies'} at tick ${tick}`,
    empty: 'Nothing deviates from last week.',
    current: (value: number) => `current ${value}`,
    usual: (value: number) => `usual ${value}`,
  },
} as const

/** One-line, identifier-only description of a question, as the player asked it. */
export function describeQuestion(question: Question): string {
  switch (question.kind) {
    case 'dashboard':
      return `dashboard ${question.service}`
    case 'logs': {
      const filter = Object.entries(question.filter ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
      return `logs ${question.service} window ${question.window}${filter === '' ? '' : ` filter ${filter}`}`
    }
    case 'trace':
      return `trace ${question.service} p${question.percentile}`
    case 'whatChanged':
      return `whatChanged window ${question.window}`
    case 'compare':
      return `compare ${question.service} ${question.metric} by ${question.by}`
    case 'askNpc':
      return `askNpc ${question.role}`
  }
}

export interface AnswerHeaderProps {
  answer: Answer
  /** World tick at which the question was asked (SessionStep.tickBefore). */
  askedAt: number
}

/** Heading of every answer: the question, the tick it was asked at and its tickCost (PR-7). */
export function AnswerHeader({ answer, askedAt }: AnswerHeaderProps) {
  return (
    <header>
      <h3>{describeQuestion(answer.question)}</h3>
      <p>
        {text.askedAt(askedAt)}, {text.cost(answer.tickCost)}
      </p>
    </header>
  )
}
