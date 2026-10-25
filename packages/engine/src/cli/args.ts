/**
 * CLI argument parser (ADR-007, PRD CLI-2, CLI-3, D-5).
 *
 *   whodeployed-engine simulate --seed <string> --ticks <int> [--fault <spec>]...
 *   whodeployed-engine --help | simulate --help
 *
 * `--fault` syntax: `<kind>[:<key>=<value>[,<key>=<value>]...]`. Reserved keys: `target`
 * (string) and `startTick` (integer); any other key is a numeric parameter of the kind.
 * Repeated `--fault` = simultaneous faults, in the given order (F-6).
 *
 * This module is syntax only: it turns argv into a CliCommand. Kind, target, parameter names
 * and ranges are validated against the catalog and the world by resolveFaults (ADR-004, F-7),
 * which the `simulate` command (T1.23) calls before writing any output.
 *
 * Pure function of argv (DET): no process, no I/O. Imports only `node:util` (D-5).
 */
import { parseArgs } from 'node:util'
import { EngineError } from '../errors.js'
import type { FaultInput, ParseCliArgs } from '../types.js'

/** Accepted range of `--ticks` (ADR-007). */
export const MIN_TICKS = 1
export const MAX_TICKS = 100_000

export const COMMANDS = ['simulate'] as const
const RESERVED_FAULT_KEYS = ['target', 'startTick'] as const

/** Usage error (CLI-3): the shared EngineError with code 'usage' (ADR-007 Emenda 1, #15). */
function usage(field: string, received: unknown, detail: string, validValues?: readonly (string | number)[]): EngineError {
  return new EngineError(
    validValues === undefined
      ? { code: 'usage', field, received, message: detail }
      : { code: 'usage', field, received, validValues, message: detail },
  )
}

const OPTIONS = {
  seed: { type: 'string', multiple: true },
  ticks: { type: 'string', multiple: true },
  fault: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
} as const

const OPTION_NAMES = ['--seed', '--ticks', '--fault', '--help'] as const

/** Plain decimal number (optional sign, fraction, exponent). Rejects '', hex, Infinity, NaN. */
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const INTEGER = /^[+-]?\d+$/

export const parseCliArgs: ParseCliArgs = (argv) => {
  const { values, positionals } = tokenize(argv)
  const [command, ...extra] = positionals

  if (command === undefined) {
    if (values.help === true) return { kind: 'help', topic: 'root' }
    throw usage('command', null, 'missing command (try --help)', COMMANDS)
  }
  if (command !== 'simulate') throw usage('command', command, `unknown command '${command}'`, COMMANDS)
  if (values.help === true) return { kind: 'help', topic: 'simulate' }
  if (extra.length > 0) {
    throw usage('arguments', extra, `unexpected positional argument '${extra[0] as string}'`, OPTION_NAMES)
  }

  return {
    kind: 'simulate',
    seed: parseSeed(values.seed),
    ticks: parseTicks(values.ticks),
    faults: (values.fault ?? []).map((spec, index) => parseFaultSpec(spec, `--fault[${index}]`)),
  }
}

function tokenize(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    throw usage('arguments', [...argv], parseErrorDetail(error), OPTION_NAMES)
  }
}

function parseErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // parseArgs messages may span several lines; keep the first one (the actual problem).
  return (message.split('\n')[0] ?? message).replace(/\.$/, '')
}

function single(values: readonly string[] | undefined, field: string): string {
  if (values === undefined || values.length === 0) throw usage(field, null, `${field} is required`)
  if (values.length > 1) throw usage(field, [...values], `${field} given ${values.length} times; give it once`)
  return values[0] as string
}

/** An empty seed is not a usage error: buildWorld rejects it as 'invalid_seed' (ADR-007 Emenda 1). */
function parseSeed(values: readonly string[] | undefined): string {
  return single(values, '--seed')
}

function parseTicks(values: readonly string[] | undefined): number {
  const raw = single(values, '--ticks')
  const ticks = INTEGER.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(ticks) || ticks < MIN_TICKS || ticks > MAX_TICKS) {
    throw usage('--ticks', raw, `--ticks must be an integer in ${MIN_TICKS}..${MAX_TICKS}, got '${raw}'`, [
      `${MIN_TICKS}..${MAX_TICKS}`,
    ])
  }
  return ticks
}

/** Parses one `--fault` value into an unvalidated FaultInput (ADR-007 syntax). */
export function parseFaultSpec(spec: string, field = '--fault'): FaultInput {
  const colon = spec.indexOf(':')
  const kind = (colon === -1 ? spec : spec.slice(0, colon)).trim()
  if (kind === '') throw usage(field, spec, `missing fault kind in '${spec}' (syntax: <kind>[:key=value,...])`)
  const input: FaultInput = { kind }
  if (colon === -1) return input

  const body = spec.slice(colon + 1)
  if (body.trim() === '') throw usage(field, spec, `empty parameter list after '${kind}:'`)
  const seen = new Set<string>()
  // No prototype (#22): a key such as `__proto__` becomes an own property and reaches
  // resolveFaults, which rejects it as 'unknown_param' (ADR-004 Emenda 1).
  const params: Record<string, number> = Object.create(null) as Record<string, number>
  let hasParams = false
  for (const pair of body.split(',')) {
    const eq = pair.indexOf('=')
    const key = (eq === -1 ? pair : pair.slice(0, eq)).trim()
    const value = eq === -1 ? '' : pair.slice(eq + 1).trim()
    if (eq === -1 || key === '' || value === '') {
      throw usage(field, spec, `malformed pair '${pair}' (expected key=value)`)
    }
    if (seen.has(key)) throw usage(`${field}.${key}`, spec, `key '${key}' given more than once`)
    seen.add(key)

    if (key === 'target') {
      input.target = value
    } else if (key === 'startTick') {
      if (!INTEGER.test(value)) throw usage(`${field}.startTick`, value, `startTick must be an integer, got '${value}'`)
      input.startTick = Number(value)
    } else {
      if (!NUMBER.test(value)) {
        throw usage(`${field}.${key}`, value, `parameter '${key}' must be a number, got '${value}'`)
      }
      params[key] = Number(value)
      hasParams = true
    }
  }
  if (hasParams) input.params = params
  return input
}

/** Reserved `--fault` keys, for --help. */
export const reservedFaultKeys: readonly string[] = RESERVED_FAULT_KEYS
