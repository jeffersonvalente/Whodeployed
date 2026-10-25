#!/usr/bin/env node
/**
 * Regenerates the telemetry fixtures of packages/engine/fixtures/ (PRD D-3, ADR-005 "Fixtures").
 *
 * Each fixture is the stdout of one CLI command, exactly as ADR-005 lists them:
 *
 *   whodeployed-engine simulate --seed fixture --ticks 60                 > fixtures/baseline.ndjson
 *   whodeployed-engine simulate --seed fixture --ticks 60 --fault <kind>  > fixtures/<kind>.ndjson
 *
 * for the 6 kinds, with their catalog defaults (ADR-004). The CLI runs from source
 * (`node --import tsx src/cli/main.ts`, the same entry point the bin compiles to), so no build is
 * needed and the bytes are those of the code in the working tree. test/fixtures.test.ts
 * regenerates every fixture in memory and compares byte for byte.
 *
 * Usage (from the repository root):
 *   corepack pnpm --filter ./packages/engine fixtures          write all 7 files
 *   node packages/engine/scripts/gen-fixtures.mjs --list       print the command table as JSON
 *   node packages/engine/scripts/gen-fixtures.mjs <name>...    write only these (e.g. baseline)
 *
 * Exit codes: 0 ok; 1 a CLI run failed; 2 usage error (unknown fixture name).
 * Output depends only on the engine code: no clock, no locale, no environment (D-1, D-2).
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainTs = join(pkgDir, 'src', 'cli', 'main.ts')
const fixturesDir = join(pkgDir, 'fixtures')

export const BIN = 'whodeployed-engine'
export const SEED = 'fixture'
export const TICKS = 60

/** The 6 kinds in ADR-004 order (campaign rows 1, 2, 3, 4, 5, 7). */
const KINDS = ['service_crash_loop', 'disk_full', 'connection_pool_exhaustion', 'bad_deploy', 'slow_dependency', 'cache_cold_start']

/** One entry per fixture: file name and the CLI argv (after the bin name) that produces it. */
export const FIXTURES = [
  { file: 'baseline.ndjson', args: ['simulate', '--seed', SEED, '--ticks', String(TICKS)] },
  ...KINDS.map((kind) => ({ file: `${kind}.ndjson`, args: ['simulate', '--seed', SEED, '--ticks', String(TICKS), '--fault', kind] })),
]

function generate(fixture) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', mainTs, ...fixture.args], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  })
  if (r.error !== undefined || r.status !== 0) {
    process.stderr.write(`gen-fixtures: '${BIN} ${fixture.args.join(' ')}' failed (exit ${r.status}): ${r.error?.message ?? r.stderr}\n`)
    process.exit(1)
  }
  writeFileSync(join(fixturesDir, fixture.file), r.stdout)
  process.stdout.write(`${fixture.file}  ${Buffer.byteLength(r.stdout)} bytes  ${BIN} ${fixture.args.join(' ')}\n`)
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argv = process.argv.slice(2)
  if (argv[0] === '--list') {
    process.stdout.write(`${JSON.stringify({ bin: BIN, fixtures: FIXTURES })}\n`)
  } else {
    const names = new Set(argv)
    const known = new Set(FIXTURES.map((f) => f.file.replace(/\.ndjson$/, '')))
    const unknown = [...names].filter((n) => !known.has(n))
    if (unknown.length > 0) {
      process.stderr.write(`gen-fixtures: unknown fixture(s) ${unknown.join(', ')}; valid: ${[...known].join(', ')}\n`)
      process.exit(2)
    }
    for (const fixture of FIXTURES) if (names.size === 0 || names.has(fixture.file.replace(/\.ndjson$/, ''))) generate(fixture)
  }
}
