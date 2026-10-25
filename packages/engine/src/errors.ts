/**
 * EngineError: the only error type thrown by the engine (types.ts §7, ADR-002 §2).
 *
 * Every invalid input (system, seed, faults, questions, CLI usage) ends here with a stable
 * `code`, the path of the offending `field`, the `received` value and, when the set is finite,
 * the `validValues`. The message is English, always names the field and lists the valid values
 * (F-7, Q-10), so callers never need to format it themselves.
 */
import type { EngineErrorCode, EngineErrorInfo } from './types.js'

export interface EngineErrorInit {
  code: EngineErrorCode
  /** Path of the offending field, e.g. 'faults[0].params.poolSize'. */
  field: string
  received: unknown
  validValues?: readonly (string | number)[]
  /** Short English reason, e.g. 'unknown fault kind'. The field and valid values are added if missing. */
  message: string
}

/** Compact, deterministic rendering of any received value for error messages. */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : String(value)
  if (typeof value === 'bigint') return `${String(value)}n`
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return String(value)
    return json.length > 80 ? `${json.slice(0, 77)}...` : json
  } catch {
    return String(value)
  }
}

function composeMessage(init: EngineErrorInit): string {
  let message = init.message.trim()
  if (!message.includes(init.field)) message = `${init.field}: ${message}`
  if (!message.includes('received')) message = `${message} (received ${describeValue(init.received)})`
  if (init.validValues !== undefined && !/valid values?:/i.test(message)) {
    const list = init.validValues.length === 0 ? '(none)' : init.validValues.join(', ')
    message = `${message}. Valid values: ${list}`
  }
  return message
}

export class EngineError extends Error implements EngineErrorInfo {
  override readonly name = 'EngineError' as const
  readonly code: EngineErrorCode
  readonly field: string
  readonly received: unknown
  declare readonly validValues?: readonly (string | number)[]

  constructor(init: EngineErrorInit) {
    super(composeMessage(init))
    this.code = init.code
    this.field = init.field
    this.received = init.received
    if (init.validValues !== undefined) this.validValues = [...init.validValues]
  }

  /** Plain EngineErrorInfo (e.g. for the CLI's stderr or a test snapshot). */
  toJSON(): EngineErrorInfo {
    const info: EngineErrorInfo = {
      name: this.name,
      code: this.code,
      field: this.field,
      received: this.received,
      message: this.message,
    }
    if (this.validValues !== undefined) info.validValues = this.validValues
    return info
  }
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError
}
