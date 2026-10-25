/**
 * ask() dispatcher (ADR-002 §3, ADR-006).
 *
 * Scaffolding stub (T1.1). The orchestrator (T1.15) already calls this function; task T1.16
 * replaces only its body: validate the question (Q-10), dispatch to questionRegistry, attach
 * tickCost (ADR-006 table) and provide the lazy lastWeek view (seed `${seed}:lastWeek`, ADR-003).
 *
 * Calling convention (internal, not part of the public API): the orchestrator creates one
 * AskEnvironment per Simulation and passes the same object on every call, so the
 * implementation may memoize the lastWeek simulation per environment (e.g. in a WeakMap).
 */
import type { Answer, Question, SimulationConfig, TelemetryView } from '../types.js'

export interface AskEnvironment {
  /** Telemetry of the running simulation; read only (Q-3). */
  readonly view: TelemetryView
  /** Config of the running simulation; the lastWeek run reuses its system with a derived seed. */
  readonly config: SimulationConfig
}

export function ask(question: Question, env: AskEnvironment): Answer {
  void question
  void env
  throw new Error('not implemented: ask dispatcher')
}
