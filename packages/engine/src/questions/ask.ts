/**
 * ask() dispatcher (ADR-002 §3, ADR-006 with Emenda 1).
 *
 * 1. Validates the question against the world (Q-10, src/questions/validate.ts).
 * 2. Builds the QuestionContext `{ view, lastWeek() }` from the AskEnvironment on every call.
 * 3. Dispatches to questionRegistry and returns `{ question, data, tickCost }`, where `question`
 *    is the validated copy (deep-equal to what was asked, Q-2) and `tickCost` comes from the
 *    ADR-006 table, a function of the kind only. ask() never advances the clock.
 *
 * lastWeek (ADR-003 §4, ADR-006 Emenda 1): the same system with `faults: []`, `noise: []` and
 * seed `${seed}:lastWeek`. It is created only the first time a handler calls `ctx.lastWeek()`
 * and memoized per AskEnvironment (the orchestrator passes the same environment object on every
 * call of one Simulation). Before handing it out it is advanced to at least `view.now`, so it
 * always covers ticks [0, view.now]; advancing equals re-simulating because a tick never depends
 * on later ticks. The lastWeek run has its own RngFactory, so asking never touches the streams
 * of the running simulation (Q-3).
 *
 * Calling convention (internal, not part of the public API): the orchestrator creates one
 * AskEnvironment per Simulation and passes the same object on every call.
 */
import { createSimulation } from '../sim/simulation.js'
import type {
  Answer,
  Question,
  QuestionContext,
  QuestionHandler,
  QuestionKind,
  Signal,
  Simulation,
  SimulationConfig,
  TelemetryView,
  TickCostTable,
} from '../types.js'
import { questionRegistry } from './registry.js'
import { validateQuestion } from './validate.js'

export interface AskEnvironment {
  /** Telemetry of the running simulation; read only (Q-3). */
  readonly view: TelemetryView
  /** Config of the running simulation; the lastWeek run reuses its system with a derived seed. */
  readonly config: SimulationConfig
}

/** tickCost per kind (ADR-006, Q-2). */
export const tickCostTable: TickCostTable = Object.freeze({
  dashboard: 1,
  logs: 1,
  whatChanged: 1,
  trace: 2,
  compare: 2,
  askNpc: 3,
})

/** Seed of the lastWeek run for a given seed (ADR-003 §4). */
export const lastWeekSeed = (seed: string): string => `${seed}:lastWeek`

/** Config of the lastWeek run: same system, no faults, no noise, derived seed (ADR-003 §4). */
export function lastWeekConfig(config: SimulationConfig): SimulationConfig {
  return { system: config.system, seed: lastWeekSeed(config.seed), faults: [], noise: [] }
}

const lastWeekRuns = new WeakMap<AskEnvironment, Simulation>()

/** The memoized lastWeek view of `env`, simulated up to at least `env.view.now`. */
function lastWeekOf(env: AskEnvironment): TelemetryView {
  let run = lastWeekRuns.get(env)
  if (run === undefined) {
    run = createSimulation(lastWeekConfig(env.config))
    lastWeekRuns.set(env, run)
  }
  const now = env.view.now
  if (run.world.tick < now) run.advance(now - run.world.tick)
  return run.telemetry()
}

function contextOf(env: AskEnvironment): QuestionContext {
  return { view: env.view, lastWeek: () => lastWeekOf(env) }
}

/** Calls the handler of `question.kind`; the registry maps each kind to its own handler. */
function dispatch<K extends QuestionKind>(question: Extract<Question, { kind: K }>, ctx: QuestionContext): Signal {
  const handler = questionRegistry[question.kind as K] as QuestionHandler<K>
  return handler(question, ctx)
}

export function ask(question: Question, env: AskEnvironment): Answer {
  const validated = validateQuestion(question, env.view.world)
  const data = dispatch(validated, contextOf(env))
  return { question: validated, data, tickCost: tickCostTable[validated.kind] }
}
