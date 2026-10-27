/**
 * Session log v1: canonical JSON (ADR-016 §2, I24-6, PR-13).
 *
 * - Keys of the log and of each step in the order of ADR-016 §1; inside `question`, `action`,
 *   `answer` and `result`, in the engine contract order (ADR-006, ADR-012). Signal payloads
 *   (`answer.data`) are kept in the order the engine returned them.
 * - Only the declared keys are written, so no other field (player name, date, user agent,
 *   anything from the environment) can reach the exported file (PR-13, SPEC §3.6).
 * - A key whose value is `undefined` is omitted (`undefined` = absent, I24-6); `discard.text`
 *   is also omitted when empty (ADR-016 §1).
 * - Numbers as JSON.stringify; no whitespace; one trailing newline.
 *
 * Equality of logs = equality of canonical strings; `logsEqual` zeroes `wallMs` first (PR-12).
 * Pure functions: no DOM, no clock; the same code runs in the browser and in the Node scripts.
 */
import type { Action, ActionResult, Answer, Question } from '@whodeployed/engine'
import type { FinalHypothesis, SessionLogV1, SessionStep } from './types'

export const LOG_FORMAT = 'whodeployed-session-log'
export const LOG_VERSION = 1

type Plain = { [key: string]: unknown }

/** Copy of `source` with exactly `keys`, in that order; absent and undefined values are omitted. */
function pick(source: object, keys: readonly string[]): Plain {
  const record = source as Plain
  const entries: [string, unknown][] = []
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined) entries.push([key, value])
  }
  // Object.fromEntries defines own data properties (no prototype setter for odd keys).
  return Object.fromEntries(entries)
}

/** Keys of each Question kind in contract order (SPEC §6, ADR-006). */
const QUESTION_KEYS: { readonly [K in Question['kind']]: readonly string[] } = {
  dashboard: ['kind', 'service'],
  logs: ['kind', 'service', 'window', 'filter'],
  trace: ['kind', 'service', 'percentile'],
  whatChanged: ['kind', 'window'],
  compare: ['kind', 'service', 'metric', 'by'],
  askNpc: ['kind', 'role'],
}

const ACTION_KEYS = ['kind', 'target'] as const
const ANSWER_KEYS = ['question', 'data', 'tickCost'] as const
const ACTION_RESULT_KEYS = ['action', 'tick', 'tickCost'] as const
const LOG_KEYS = ['format', 'version', 'scenario', 'engine', 'build', 'steps', 'finalHypothesis', 'review'] as const
const STEP_HEAD = ['seq', 'tickBefore', 'type'] as const
const STEP_TAIL = ['tickCost', 'impactAfter', 'wallMs'] as const

/** Fields of each step type, between the head and the tail (ADR-016 §1). */
const STEP_FIELDS: { readonly [T in SessionStep['type']]: readonly string[] } = {
  ask: ['question', 'answer'],
  act: ['action', 'result'],
  wait: [],
  hypothesis: ['component', 'text'],
  discard: ['hypothesisSeq', 'citedSeqs', 'text'],
  end: ['final', 'reason'],
}

/** Canonical copy of a Question (I24-6: `filter: undefined` is the same as no filter). */
export function canonicalQuestion(question: Question): Plain {
  const keys = QUESTION_KEYS[question.kind] as readonly string[] | undefined
  // An unknown kind is kept as it came (the replay reports it; the serializer never invents data).
  return keys === undefined ? pick(question, Object.keys(question)) : pick(question, keys)
}

export function canonicalAction(action: Action): Plain {
  return pick(action, ACTION_KEYS)
}

function canonicalAnswer(answer: Answer): Plain {
  const copy = pick(answer, ANSWER_KEYS)
  if (answer.question !== undefined) copy['question'] = canonicalQuestion(answer.question)
  return copy
}

function canonicalResult(result: ActionResult): Plain {
  const copy = pick(result, ACTION_RESULT_KEYS)
  if (result.action !== undefined) copy['action'] = canonicalAction(result.action)
  return copy
}

function canonicalFinal(final: FinalHypothesis): Plain {
  switch (final.kind) {
    case 'active':
      return pick(final, ['kind', 'hypothesisSeq'])
    case 'new':
      return pick(final, ['kind', 'component', 'text'])
    default:
      return pick(final, ['kind'])
  }
}

function canonicalStep(step: SessionStep): Plain {
  const fields = STEP_FIELDS[step.type] as readonly string[] | undefined
  const copy = pick(step, [...STEP_HEAD, ...(fields ?? []), ...STEP_TAIL])
  switch (step.type) {
    case 'ask':
      copy['question'] = canonicalQuestion(step.question)
      copy['answer'] = canonicalAnswer(step.answer)
      break
    case 'act':
      copy['action'] = canonicalAction(step.action)
      copy['result'] = canonicalResult(step.result)
      break
    case 'discard':
      if (step.text === '') delete copy['text']
      break
    case 'end':
      copy['final'] = canonicalFinal(step.final)
      break
    default:
      break
  }
  return copy
}

/** Canonical object of a log: declared keys only, in ADR-016 order. */
export function canonicalLog(log: SessionLogV1): Plain {
  const copy = pick(log, LOG_KEYS)
  copy['scenario'] = pick(log.scenario, ['id', 'seed'])
  copy['engine'] = pick(log.engine, ['version'])
  copy['build'] = pick(log.build, ['sha'])
  copy['steps'] = log.steps.map(canonicalStep)
  copy['finalHypothesis'] = log.finalHypothesis === null ? null : canonicalFinal(log.finalHypothesis)
  copy['review'] = log.review === null ? null : [...log.review]
  return copy
}

/** The exported file text: canonical JSON, no whitespace, one trailing newline (ADR-016 §2). */
export function serializeLog(log: SessionLogV1): string {
  return `${JSON.stringify(canonicalLog(log))}\n`
}

/** Copy of the log with every `wallMs` set to 0, the only non-deterministic field (PR-12). */
export function withoutWallMs(log: SessionLogV1): SessionLogV1 {
  return { ...log, steps: log.steps.map((step) => ({ ...step, wallMs: 0 })) }
}

/** Equality of logs = equality of canonical strings, ignoring `wallMs` (ADR-016 §2, PR-12). */
export function logsEqual(a: SessionLogV1, b: SessionLogV1): boolean {
  return serializeLog(withoutWallMs(a)) === serializeLog(withoutWallMs(b))
}

/** Error of `parseLog`: the text is not a session log this build can read. */
export class LogFormatError extends Error {
  override readonly name = 'LogFormatError'
}

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a log back (local storage, a file). Checks the envelope only (format, version, the
 * object/array shape of the top-level fields); step by step verification is the replay's job
 * (PR-14). Throws LogFormatError.
 */
export function parseLog(text: string): SessionLogV1 {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new LogFormatError('not JSON')
  }
  if (!isPlain(value)) throw new LogFormatError('a session log is a JSON object')
  if (value['format'] !== LOG_FORMAT) throw new LogFormatError(`format is not "${LOG_FORMAT}"`)
  if (value['version'] !== LOG_VERSION) throw new LogFormatError(`unsupported version: ${String(value['version'])}`)
  const { scenario, engine, build, steps, finalHypothesis, review } = value
  if (!isPlain(scenario) || typeof scenario['id'] !== 'string' || typeof scenario['seed'] !== 'string') {
    throw new LogFormatError('scenario must be { id, seed }')
  }
  if (!isPlain(engine) || typeof engine['version'] !== 'string') throw new LogFormatError('engine must be { version }')
  if (!isPlain(build) || typeof build['sha'] !== 'string') throw new LogFormatError('build must be { sha }')
  if (!Array.isArray(steps) || !steps.every(isPlain)) throw new LogFormatError('steps must be an array of objects')
  if (finalHypothesis !== null && !isPlain(finalHypothesis)) throw new LogFormatError('finalHypothesis must be null or an object')
  if (review !== null && !(Array.isArray(review) && review.length === 3 && review.every((s) => typeof s === 'string'))) {
    throw new LogFormatError('review must be null or 3 sentences')
  }
  return value as unknown as SessionLogV1
}
