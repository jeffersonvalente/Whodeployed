/**
 * Replay CLI (FASE-2 PR-14, PR-17; ADR-015 §7, ADR-016 §3).
 *
 *   pnpm --filter @whodeployed/web replay -- <log.json> <scenario.yaml>
 *
 * Reads an exported session log and the scenario YAML, replays the log with `replayLog` and
 * exits 0 when every step matches; exits 1 printing the seq and the field of the first divergent
 * step; exits 2 on usage error (wrong arguments, unreadable file, invalid YAML). An engine version
 * different from the log's is a warning on stderr, never a failure (the replay is the proof).
 *
 * Review: the 3 sentences are rebuilt with `createBuildReview` once the real `checkMitigations`
 * (T2.13) is exported by @whodeployed/scenarios; until then a log that carries a `review` fails on
 * `review` (replayLog never passes what it did not check). Logs of unfinished sessions and the
 * PR-17 fixture have `review: null`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadScenarioFile } from '@whodeployed/scenarios/node'
import type { Scenario } from '@whodeployed/scenarios'
import { engineRuntime } from '../src/engine-runtime'
import { LogFormatError, parseLog } from '../src/session/log'
import { replayLog } from '../src/session/replay'
import type { SessionLogV1 } from '../src/session/types'

const USAGE = 'usage: replay <log.json> <scenario.yaml>'

function usage(message: string): never {
  process.stderr.write(`replay: ${message}\n${USAGE}\n`)
  process.exit(2)
}

function engineVersion(): string {
  const path = fileURLToPath(new URL('../../../packages/engine/package.json', import.meta.url))
  const { version } = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  return typeof version === 'string' ? version : 'unknown'
}

function main(argv: readonly string[]): number {
  // `pnpm run replay -- a b` passes the `--` through; drop it.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv]
  if (args.length !== 2) usage(`expected 2 arguments, got ${args.length}`)
  const [logPath, scenarioPath] = args as [string, string]

  let text: string
  try {
    text = readFileSync(logPath, 'utf8')
  } catch (error) {
    usage(`cannot read ${logPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let scenario: Scenario
  try {
    scenario = loadScenarioFile(scenarioPath, engineRuntime)
  } catch (error) {
    usage(`cannot load ${scenarioPath}: ${error instanceof Error ? error.message : String(error)}`)
  }

  let log: SessionLogV1
  try {
    log = parseLog(text)
  } catch (error) {
    if (!(error instanceof LogFormatError)) throw error
    process.stdout.write(`replay: FAIL seq 0 field format: ${error.message}\n`)
    return 1
  }

  const running = engineVersion()
  if (log.engine.version !== running) {
    process.stderr.write(`replay: warning: log was recorded with engine ${log.engine.version}, replaying with ${running}\n`)
  }

  const result = replayLog(log, scenario, { engine: engineRuntime })
  if (result.ok) {
    process.stdout.write(`replay: ok ${result.steps} steps (${log.scenario.id})\n`)
    return 0
  }
  process.stdout.write(`replay: FAIL seq ${result.seq} field ${result.field}: ${result.message}\n`)
  return 1
}

process.exit(main(process.argv.slice(2)))
