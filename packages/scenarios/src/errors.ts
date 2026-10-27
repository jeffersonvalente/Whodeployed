/**
 * ScenarioError: the only error the scenarios loader throws (FASE-2 CN-4, ADR-014 §2).
 *
 * The message always names the file and the field. When the cause is an EngineError (invalid fault
 * kind, target, param, noise, seed...), the original error is kept in `engine` and its message is
 * copied verbatim (F-7): the loader never rewrites what the engine says.
 */
import type { EngineErrorInfo } from '@whodeployed/engine'
import type { ScenarioErrorInfo } from './types.js'

export interface ScenarioErrorInit {
  file: string
  field: string
  /** Short English reason, e.g. 'is required'. Ignored when `engine` is set (its message is used). */
  reason?: string
  engine?: EngineErrorInfo
}

/**
 * `file: field: reason`. When the engine caused it: `file: <engine message>`, since the engine's
 * message already names the field (F-7); `field` is added only if it does not.
 */
function compose(init: ScenarioErrorInit): string {
  if (init.engine !== undefined) {
    const named = init.field === '' || init.engine.message.includes(init.field)
    return named ? `${init.file}: ${init.engine.message}` : `${init.file}: ${init.field}: ${init.engine.message}`
  }
  const where = init.field === '' ? init.file : `${init.file}: ${init.field}`
  return `${where}: ${init.reason ?? 'invalid'}`
}

export class ScenarioError extends Error implements ScenarioErrorInfo {
  override readonly name = 'ScenarioError' as const
  readonly file: string
  readonly field: string
  readonly engine?: EngineErrorInfo

  constructor(init: ScenarioErrorInit) {
    super(compose(init))
    this.file = init.file
    this.field = init.field
    if (init.engine !== undefined) this.engine = init.engine
  }
}

/** Duck-typed check (no runtime import of the engine, ADR-014 §1.1). */
export function isEngineErrorLike(value: unknown): value is EngineErrorInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v['name'] === 'EngineError' && typeof v['code'] === 'string' && typeof v['field'] === 'string' && typeof v['message'] === 'string'
}
