/**
 * parseScenario (YAML text -> Scenario) and toSimulationConfig (Scenario -> engine input).
 * FASE-2 CN-4, CN-1 (fields), DET; ADR-014 §1.1 and §2.
 *
 * - Structure first: every required field of SPEC §7 plus `impactBudget` and `review` (with
 *   `keySignalAsk`), types, `id` format, `level`, `system`, question patterns and the shape of
 *   `referencePath` steps. Unknown keys are refused, so a typo never silently drops a field.
 * - Then the injected engine (no runtime import of the engine, ADR-014 §1.1): `faults` go through
 *   `engine.resolveFaults` and `noise` through `engine.createSimulation`; an EngineError becomes a
 *   ScenarioError whose `engine` is the original error and whose message is the engine's, verbatim
 *   (F-7). The engine's field paths (`faults[0].params.poolSize`, `noise[1].target`) are already
 *   the paths in the YAML.
 * - Several faults are accepted (the campaign's scenario 8 needs two); "exactly one" (CN-2) is a
 *   property of each phase-2 YAML, checked by that scenario's tests.
 * - Pure and deterministic: same text and engine => a structurally identical Scenario.
 */
import type { Action, Fault, FaultInput, NoiseEvent, Question, SimulationConfig } from '@whodeployed/engine'
import { parseDocument } from 'yaml'
import { ScenarioError, isEngineErrorLike } from './errors.js'
import { isQuestionKind, parsePattern, questionKinds } from './patterns.js'
import type {
  EngineRuntime,
  Level,
  ParseScenario,
  QuestionPattern,
  ReferenceStep,
  ReviewSpec,
  Scenario,
  ToSimulationConfig,
} from './types.js'

/** Name of the system when the YAML omits `system` (SPEC §7 marks it optional; phase 2 has only this one). */
export const DEFAULT_SYSTEM = 'default-shop'

const CAMPAIGN_ID = /^[0-9]{2}-[a-z0-9-]+$/
const TEST_ID = /^test-[a-z0-9-]+$/

const LEVELS: readonly Level[] = ['junior', 'pleno', 'senior']

/** Every Action kind of the SPEC §6 contract; which ones a level may use is the repertoire's job (CN-5). */
const ACTION_KINDS = {
  restart: true,
  rollback: true,
  flagOff: true,
  scale: true,
  escalate: true,
  declareMitigated: true,
} as const satisfies Record<Action['kind'], true>
const actionKinds = Object.keys(ACTION_KINDS) as Action['kind'][]

const TOP_KEYS = [
  'id',
  'title',
  'level',
  'teaches',
  'trap',
  'seed',
  'system',
  'faults',
  'noise',
  'alert',
  'impactBudget',
  'referencePath',
  'rootCause',
  'review',
] as const
const FAULT_KEYS = ['kind', 'target', 'startTick', 'params'] as const
const NOISE_KEYS = ['kind', 'target', 'tick', 'instance', 'note'] as const
const ALERT_KEYS = ['tick', 'text'] as const
const REVIEW_KEYS = ['redundant', 'keySignal', 'keySignalAsk'] as const
const ACT_KEYS = ['act', 'target'] as const

type Obj = Record<string, unknown>

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value)

const has = (obj: Obj, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)

const join = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`

/** Field-level checks bound to one file. Every failure throws ScenarioError naming file and field. */
function checker(file: string) {
  const fail = (field: string, reason: string): never => {
    throw new ScenarioError({ file, field, reason })
  }

  const noUnknownKeys = (obj: Obj, path: string, allowed: readonly string[]): void => {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) fail(join(path, key), `unknown field (valid fields: ${allowed.join(', ')})`)
    }
  }

  const required = (obj: Obj, path: string, key: string): unknown => {
    const value = has(obj, key) ? obj[key] : undefined
    if (value === undefined || value === null) fail(join(path, key), 'is required')
    return value
  }

  const object = (value: unknown, field: string): Obj => {
    if (!isObject(value)) fail(field, 'must be a mapping (key: value)')
    return value as Obj
  }

  const array = (value: unknown, field: string, min: number): unknown[] => {
    if (!Array.isArray(value)) fail(field, 'must be a list')
    const list = value as unknown[]
    if (list.length < min) fail(field, `must have at least ${min} item${min === 1 ? '' : 's'}`)
    return list
  }

  const text = (value: unknown, field: string): string => {
    if (typeof value !== 'string') fail(field, `must be a string (received ${typeof value}; quote it in YAML)`)
    const s = value as string
    if (s.trim() === '') fail(field, 'must not be empty')
    return s
  }

  const integer = (value: unknown, field: string, min: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) fail(field, `must be an integer >= ${min}`)
    return value as number
  }

  return { fail, noUnknownKeys, required, object, array, text, integer }
}

/** Runs an engine call; an EngineError becomes a ScenarioError carrying it (F-7). */
function withEngine<T>(file: string, call: () => T): T {
  try {
    return call()
  } catch (error) {
    if (isEngineErrorLike(error)) throw new ScenarioError({ file, field: error.field, engine: error })
    throw error
  }
}

function parseYaml(source: string, file: string): Obj {
  const doc = parseDocument(source, { prettyErrors: true, uniqueKeys: true })
  const [first] = doc.errors
  if (first !== undefined) {
    throw new ScenarioError({ file, field: '', reason: `invalid YAML: ${first.message.split('\n')[0] ?? first.message}` })
  }
  const root: unknown = doc.toJS({ maxAliasCount: 100 })
  if (!isObject(root)) throw new ScenarioError({ file, field: '', reason: 'the document must be a mapping of scenario fields' })
  return root
}

function parseStep(raw: unknown, field: string, c: ReturnType<typeof checker>): ReferenceStep {
  const step = c.object(raw, field)
  const isAsk = has(step, 'ask')
  const isAct = has(step, 'act')
  if (isAsk === isAct) c.fail(field, 'must have exactly one of "ask" (a question) or "act" (an action)')

  if (isAsk) {
    const kind = step['ask']
    if (!isQuestionKind(kind)) {
      return c.fail(join(field, 'ask'), `unknown question kind ${JSON.stringify(kind)} (valid values: ${questionKinds.join(', ')})`)
    }
    if (has(step, 'kind')) c.fail(join(field, 'kind'), 'unknown field; the question kind goes in "ask"')
    // The other keys are the Question's own fields; their shape is checked by the engine when the
    // reference path is replayed (ADR-014 §2), not here.
    const params = Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'ask'))
    return { type: 'ask', question: { kind, ...params } as Question }
  }

  c.noUnknownKeys(step, field, ACT_KEYS)
  const kind = step['act']
  if (typeof kind !== 'string' || !has(ACTION_KINDS, kind)) {
    return c.fail(join(field, 'act'), `unknown action kind ${JSON.stringify(kind)} (valid values: ${actionKinds.join(', ')})`)
  }
  const action: Action = { kind: kind as Action['kind'] }
  if (has(step, 'target')) action.target = c.text(step['target'], join(field, 'target'))
  return { type: 'act', action }
}

function parsePatternAt(raw: unknown, field: string, components: readonly string[], c: ReturnType<typeof checker>): QuestionPattern {
  const parsed = parsePattern(raw, components)
  return typeof parsed === 'string' ? c.fail(field, parsed) : parsed
}

function componentsOf(engine: EngineRuntime, system: string): string[] {
  const definition = engine.systems[system]
  if (definition === undefined) return []
  return [...definition.services.map((s) => s.name), ...definition.deps.map((d) => d.name)]
}

export const parseScenario: ParseScenario = (source: string, file: string, engine: EngineRuntime): Scenario => {
  const c = checker(file)
  if (typeof source !== 'string') c.fail('', 'the scenario source must be a string')
  const root = parseYaml(source, file)
  c.noUnknownKeys(root, '', TOP_KEYS)

  const id = c.text(c.required(root, '', 'id'), 'id')
  const testIncident = TEST_ID.test(id)
  if (!testIncident && !CAMPAIGN_ID.test(id)) {
    c.fail('id', `'${id}' must be "NN-kebab-slug" (campaign, e.g. 03-pool-exhausted) or "test-kebab-slug" (test incident)`)
  }
  const title = c.text(c.required(root, '', 'title'), 'title')
  const level = c.required(root, '', 'level')
  if (!LEVELS.includes(level as Level)) c.fail('level', `must be one of ${LEVELS.join(', ')} (received ${JSON.stringify(level)})`)
  const teaches = c.text(c.required(root, '', 'teaches'), 'teaches')
  const trap = c.text(c.required(root, '', 'trap'), 'trap')
  const seed = c.text(c.required(root, '', 'seed'), 'seed')

  const system = has(root, 'system') ? c.text(root['system'], 'system') : DEFAULT_SYSTEM
  if (!has(engine.systems, system)) {
    c.fail('system', `unknown system '${system}' (valid values: ${Object.keys(engine.systems).join(', ')})`)
  }
  const components = componentsOf(engine, system)

  const faultList = c.array(c.required(root, '', 'faults'), 'faults', 1)
  const faultInputs = faultList.map((raw, i): FaultInput => {
    const fault = c.object(raw, `faults[${i}]`)
    c.noUnknownKeys(fault, `faults[${i}]`, FAULT_KEYS)
    // Values (kind, target, startTick, params) are the engine's to judge (F-7).
    return fault as unknown as FaultInput
  })

  const noiseList = has(root, 'noise') && root['noise'] !== null ? c.array(root['noise'], 'noise', 0) : []
  noiseList.forEach((raw, i) => c.noUnknownKeys(c.object(raw, `noise[${i}]`), `noise[${i}]`, NOISE_KEYS))

  const alertRaw = c.object(c.required(root, '', 'alert'), 'alert')
  c.noUnknownKeys(alertRaw, 'alert', ALERT_KEYS)
  const alert = {
    tick: c.integer(c.required(alertRaw, 'alert', 'tick'), 'alert.tick', 0),
    text: c.text(c.required(alertRaw, 'alert', 'text'), 'alert.text'),
  }

  const impactBudget = c.integer(c.required(root, '', 'impactBudget'), 'impactBudget', 1)

  const referencePath = c
    .array(c.required(root, '', 'referencePath'), 'referencePath', 1)
    .map((raw, i) => parseStep(raw, `referencePath[${i}]`, c))

  const rootCause = c.text(c.required(root, '', 'rootCause'), 'rootCause')

  const reviewRaw = c.object(c.required(root, '', 'review'), 'review')
  c.noUnknownKeys(reviewRaw, 'review', REVIEW_KEYS)
  const review: ReviewSpec = {
    redundant: c
      .array(c.required(reviewRaw, 'review', 'redundant'), 'review.redundant', 0)
      .map((raw, i) => parsePatternAt(raw, `review.redundant[${i}]`, components, c)),
    keySignal: c.text(c.required(reviewRaw, 'review', 'keySignal'), 'review.keySignal'),
    keySignalAsk: parsePatternAt(c.required(reviewRaw, 'review', 'keySignalAsk'), 'review.keySignalAsk', components, c),
  }

  // Engine checks (ADR-014 §1.1, §2): resolve faults against the world of (system, seed), then
  // validate noise by creating the scenario's simulation (no tick is simulated).
  const definition = engine.systems[system]
  const faults: Fault[] = withEngine(file, () => {
    const world = engine.createSimulation({ system: definition as NonNullable<typeof definition>, seed }).world
    return engine.resolveFaults(faultInputs, world)
  })

  const scenario: Scenario = {
    id,
    title,
    level: level as Level,
    teaches,
    trap,
    seed,
    system,
    faults,
    noise: noiseList as NoiseEvent[],
    alert,
    impactBudget,
    referencePath,
    rootCause,
    review,
    testIncident,
  }
  withEngine(file, () => engine.createSimulation(toSimulationConfig(scenario, engine)))
  return scenario
}

/** The engine input of a scenario and nothing else: no scenario text reaches the engine (EN-5). */
export const toSimulationConfig: ToSimulationConfig = (scenario: Scenario, engine: EngineRuntime): SimulationConfig => {
  const system = has(engine.systems, scenario.system) ? engine.systems[scenario.system] : undefined
  if (system === undefined) {
    throw new ScenarioError({
      file: scenario.id,
      field: 'system',
      reason: `unknown system '${scenario.system}' (valid values: ${Object.keys(engine.systems).join(', ')})`,
    })
  }
  return { system, seed: scenario.seed, faults: scenario.faults, noise: scenario.noise }
}
