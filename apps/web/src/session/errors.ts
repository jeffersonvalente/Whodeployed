/**
 * SessionError: the error of the prototype session core (contract: src/session/types.ts, `Session`).
 *
 * A plain Error subclass, thrown when an input is refused by the session itself (ended session,
 * step outside the level's repertoire, invalid notebook input). Errors of the engine
 * (EngineError) are never wrapped: the session rethrows them unchanged (ADR-015 §5).
 *
 * A refused input never changes the session: no tick, no impact, no step (FASE-2 PR-6, PR-8).
 */

export type SessionErrorCode =
  /** The session has ended (player `end` or tick 360); only review and export remain (PR-10, PR-8). */
  | 'session_ended'
  /** The question or action is not in the repertoire of the scenario's level (PR-6, `inRepertoire`). */
  | 'out_of_repertoire'
  /** The scenario's level has no repertoire in phase 2 (only 'junior' and 'pleno', ADR-014 §3). */
  | 'no_repertoire'
  /** The scenario cannot start a session (alert.tick not an integer in 0..359, PR-5, PR-8). */
  | 'invalid_scenario'
  /** Notebook: hypothesis without a valid component or with empty text (PR-9). Used by T2.23. */
  | 'invalid_hypothesis'
  /** Notebook: discard of an unknown/discarded hypothesis or citing no previous answer (PR-9). Used by T2.23. */
  | 'invalid_discard'
  /** Notebook: final hypothesis that is not active, new or unknown (PR-10). Used by T2.23. */
  | 'invalid_final'
  /** Session method whose body is delivered by a later task (T2.23: hypothesis, discard, end). */
  | 'not_implemented'

export interface SessionErrorInfo {
  name: 'SessionError'
  code: SessionErrorCode
  /** English, one line, safe to show to the player as text. */
  message: string
}

export class SessionError extends Error implements SessionErrorInfo {
  override readonly name = 'SessionError' as const
  readonly code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export function isSessionError(value: unknown): value is SessionError {
  return value instanceof SessionError
}
