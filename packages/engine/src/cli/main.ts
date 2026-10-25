#!/usr/bin/env node
/**
 * CLI entry point: `whodeployed-engine` (ADR-007 with Emenda 1; PRD CLI-1..CLI-5, D-1, D-2, D-5).
 *
 *   whodeployed-engine simulate --seed <string> --ticks <int> [--fault <spec>]...
 *   whodeployed-engine --help | simulate --help
 *
 * `simulate` runs, in this order: parseCliArgs (syntax, 'usage') -> buildWorld(defaultShop, seed)
 * ('invalid_seed') -> resolveFaults (F-7) -> simulate -> canonical NDJSON (ADR-005). Everything
 * is validated and serialized before the first byte is written, so a failed run leaves stdout
 * empty.
 *
 * Exit codes: 0 success (NDJSON or help on stdout); 2 any EngineError, whatever its code
 * (message on stderr, stdout empty); 1 any other error, an internal invariant (ADR-002 §7).
 *
 * Output is a pure function of argv: no clock, no locale, no environment (D-1, D-2). The CLI
 * writes only to stdout/stderr and imports only the library, node:util (via args.ts) and
 * node:process (D-5). There is no output-file flag: redirect stdout to save it.
 */
import process from 'node:process'
import { isEngineError } from '../errors.js'
import { resolveFaults } from '../faults/resolve.js'
import { toNdjson } from '../sim/serialize.js'
import { simulate } from '../sim/simulation.js'
import type { TelemetryRecord } from '../types.js'
import { buildWorld } from '../world/build.js'
import { defaultShop } from '../world/default-shop.js'
import { parseCliArgs } from './args.js'
import { BIN_NAME, helpText } from './help.js'

export const EXIT_OK = 0
export const EXIT_INTERNAL = 1
export const EXIT_ENGINE_ERROR = 2

/** Records serialized per stdout chunk: keeps every string far below V8's string length limit. */
const RECORDS_PER_CHUNK = 4096

/** Where the CLI writes. The real entry point binds it to process.stdout / process.stderr. */
export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
}

/** Canonical NDJSON of the records, split in chunks whose concatenation is toNdjson(records). */
function ndjsonChunks(records: readonly TelemetryRecord[]): string[] {
  const chunks: string[] = []
  for (let i = 0; i < records.length; i += RECORDS_PER_CHUNK) {
    chunks.push(toNdjson(records.slice(i, i + RECORDS_PER_CHUNK)))
  }
  return chunks
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : `${error.name}: ${error.message}`
  return String(error)
}

/** Runs the CLI for `argv` (without node and script path) and returns the exit code. */
export function run(argv: readonly string[], io: CliIo): number {
  let output: string[]
  try {
    const command = parseCliArgs(argv)
    if (command.kind === 'help') {
      io.stdout(helpText(command.topic))
      return EXIT_OK
    }
    const world = buildWorld(defaultShop, command.seed)
    const faults = resolveFaults(command.faults, world)
    const records = simulate({ system: defaultShop, seed: command.seed, faults }, command.ticks)
    output = ndjsonChunks(records)
  } catch (error) {
    if (isEngineError(error)) {
      io.stderr(`${BIN_NAME}: error [${error.code}]: ${error.message}\n`)
      io.stderr(`Run '${BIN_NAME} --help' for usage.\n`)
      return EXIT_ENGINE_ERROR
    }
    io.stderr(`${BIN_NAME}: internal error: ${errorText(error)}\n`)
    return EXIT_INTERNAL
  }
  for (const chunk of output) io.stdout(chunk)
  return EXIT_OK
}

// A closed pipe (e.g. `| head`) is not an error of the simulation: stop quietly.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exit(process.exitCode ?? EXIT_OK)
    return
  }
  process.stderr.write(`${BIN_NAME}: internal error: cannot write to stdout: ${errorText(error)}\n`)
  process.exit(EXIT_INTERNAL)
})

process.exitCode = run(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
})
