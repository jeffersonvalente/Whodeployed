/**
 * T1.23 — CLI main (ADR-007 with Emenda 1; PRD CLI-1..CLI-5, F-7 via CLI, D-1, D-2, D-5, DET).
 *
 * End to end: every case spawns a separate Node process running src/cli/main.ts through tsx
 * (the same source `tsc` emits as dist/cli/main.js, the `$CLI` of ADR-007), so exit codes,
 * stdout and stderr are the real ones. The `run` function is also tested in-process with a
 * fake `node:process`, to reach the internal-error branch (exit 1) that no valid argv triggers.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { faultKinds } from '../../src/faults/catalog.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { toNdjson } from '../../src/sim/serialize.js'
import { simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const mainTs = join(pkgDir, 'src', 'cli', 'main.ts')
const verifier = join(pkgDir, 'scripts', 'verify-coherence.mjs')
const LONG = 120_000

interface Run {
  status: number | null
  stdout: string
  stderr: string
  ms: number
}

/** Runs the CLI in a fresh process. */
function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Run {
  const started = performance.now()
  const result = spawnSync(process.execPath, ['--import', 'tsx', mainTs, ...args], {
    cwd: pkgDir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: performance.now() - started }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function verify(ndjson: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [verifier], { cwd: pkgDir, encoding: 'utf8', input: ndjson, maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Asserts a successful NDJSON run: exit 0, empty stderr, every line a typed record. */
function expectNdjson(run: Run, ticks: number): Map<string, number> {
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  expect(run.stdout.endsWith('\n')).toBe(true)
  const counts = new Map<string, number>()
  const seenTicks = new Set<number>()
  for (const line of run.stdout.slice(0, -1).split('\n')) {
    const record = JSON.parse(line) as { type: string; tick: number }
    expect(['metric', 'log', 'span', 'event']).toContain(record.type)
    counts.set(record.type, (counts.get(record.type) ?? 0) + 1)
    seenTicks.add(record.tick)
  }
  expect([...seenTicks].sort((a, b) => a - b)).toEqual(Array.from({ length: ticks }, (_, i) => i))
  return counts
}

/** Asserts an EngineError run: exit 2, stdout empty, readable message with the code on stderr. */
function expectEngineError(run: Run, code: string): string {
  expect(run.stdout).toBe('')
  expect(run.status).toBe(2)
  expect(run.stderr).toContain(`whodeployed-engine: error [${code}]: `)
  expect(run.stderr).toContain("Run 'whodeployed-engine --help' for usage.")
  expect(run.stderr).not.toMatch(/\n\s+at /) // no stack trace
  return run.stderr
}

describe('help (CLI-4)', () => {
  for (const args of [['--help'], ['-h'], ['simulate', '--help'], ['--help', 'simulate']]) {
    it(`${args.join(' ')} prints the help on stdout and exits 0`, () => {
      const run = cli(args)
      expect(run.status).toBe(0)
      expect(run.stderr).toBe('')
      for (const flag of ['--seed', '--fault', '--ticks']) expect(run.stdout).toContain(flag)
      for (const kind of faultKinds) expect(run.stdout).toMatch(new RegExp(`^  ${kind}$`, 'm'))
    }, LONG)
  }
})

describe('simulate (CLI-1, CLI-2)', () => {
  it('baseline: 10 ticks of NDJSON on stdout, exit 0, typed lines (CLI-1)', () => {
    const counts = expectNdjson(cli(['simulate', '--seed', 's', '--ticks', '10']), 10)
    // The baseline has no fault and no noise, hence no event records; events appear with faults.
    for (const type of ['metric', 'log', 'span']) expect(counts.get(type) ?? 0).toBeGreaterThan(0)
  }, LONG)

  it('stdout is exactly the library NDJSON for the same input (CLI = library)', () => {
    const run = cli(['simulate', '--seed', 'lib', '--ticks', '20', '--fault', 'connection_pool_exhaustion:target=cart,startTick=5'])
    const world = buildWorld(defaultShop, 'lib')
    const faults = resolveFaults([{ kind: 'connection_pool_exhaustion', target: 'cart', startTick: 5 }], world)
    expect(run.stdout).toBe(toNdjson(simulate({ system: defaultShop, seed: 'lib', faults }, 20)))
  }, LONG)

  for (const kind of faultKinds) {
    it(`--fault ${kind} with catalog defaults: exit 0, coherent (CLI-2, P-4)`, () => {
      const run = cli(['simulate', '--seed', 'cli2', '--ticks', '30', '--fault', kind])
      expectNdjson(run, 30)
      const check = verify(run.stdout)
      expect(check.stderr).toBe('')
      expect(check.status).toBe(0)
    }, LONG)
  }

  it('overrides target, startTick and params (CLI-2)', () => {
    const run = cli(['simulate', '--seed', 'cli2', '--ticks', '20', '--fault', 'connection_pool_exhaustion:target=cart,startTick=5,poolSize=10'])
    expectNdjson(run, 20)
    expect(verify(run.stdout).status).toBe(0)
  }, LONG)

  it('two simultaneous faults on different targets (CLI-2, F-6)', () => {
    const args = ['simulate', '--seed', 'cli2', '--ticks', '20']
    const run = cli([...args, '--fault', 'connection_pool_exhaustion:target=payment', '--fault', 'service_crash_loop:target=catalog'])
    expectNdjson(run, 20)
    expect(verify(run.stdout).status).toBe(0)
    expect(cli([...args, '--fault', 'connection_pool_exhaustion:target=payment', '--fault', 'service_crash_loop:target=catalog']).stdout).toBe(run.stdout)
  }, LONG)

  it('ticks = 1 emits only tick 0', () => {
    expectNdjson(cli(['simulate', '--seed', 's', '--ticks', '1']), 1)
  }, LONG)
})

describe('errors: every EngineError exits 2 with stdout empty (CLI-3, F-7, ADR-007 Emenda 1)', () => {
  const base = ['simulate', '--seed', 's', '--ticks', '10']

  it('unknown fault kind lists the 6 valid kinds', () => {
    const stderr = expectEngineError(cli([...base, '--fault', 'no_such_kind']), 'unknown_fault_kind')
    for (const kind of faultKinds) expect(stderr).toContain(kind)
  }, LONG)

  it('--seed missing', () => {
    expect(expectEngineError(cli(['simulate', '--ticks', '10']), 'usage')).toContain('--seed')
  }, LONG)

  it("empty --seed is 'invalid_seed' (rejected by buildWorld)", () => {
    expectEngineError(cli(['simulate', '--seed', '', '--ticks', '10']), 'invalid_seed')
    expectEngineError(cli(['simulate', '--seed=', '--ticks', '10']), 'invalid_seed')
  }, LONG)

  for (const ticks of ['0', '-1', '1.5', 'abc', '100001']) {
    it(`--ticks=${ticks} (not an integer in 1..100000)`, () => {
      expect(expectEngineError(cli(['simulate', '--seed', 's', `--ticks=${ticks}`]), 'usage')).toContain('1..100000')
    }, LONG)
  }

  it('target that does not exist lists the components', () => {
    const stderr = expectEngineError(cli([...base, '--fault', 'bad_deploy:target=nowhere']), 'unknown_target')
    expect(stderr).toContain('nowhere')
    for (const name of ['gateway', 'payment', 'postgres']) expect(stderr).toContain(name)
  }, LONG)

  it('target of a kind the targetRule does not accept', () => {
    expectEngineError(cli([...base, '--fault', 'disk_full:target=gateway']), 'invalid_target')
  }, LONG)

  it('--fault kind:__proto__=1 reaches resolveFaults and fails as unknown_param (#22)', () => {
    const stderr = expectEngineError(cli([...base, '--fault', 'bad_deploy:__proto__=1']), 'unknown_param')
    expect(stderr).toContain('__proto__')
  }, LONG)

  it('unknown and out-of-range parameters', () => {
    expectEngineError(cli([...base, '--fault', 'bad_deploy:nope=1']), 'unknown_param')
    expectEngineError(cli([...base, '--fault', 'bad_deploy:errorRatio=7']), 'param_out_of_range')
  }, LONG)

  it('negative startTick (resolveFaults)', () => {
    expectEngineError(cli([...base, '--fault', 'disk_full:startTick=-3']), 'invalid_start_tick')
  }, LONG)

  it('the second of two --fault is validated too, before any output', () => {
    expectEngineError(cli([...base, '--fault', 'disk_full', '--fault', 'bad_deploy:target=nowhere']), 'unknown_target')
  }, LONG)

  it('syntax errors: unknown command, unknown option, malformed --fault', () => {
    expectEngineError(cli(['simulat', '--seed', 's', '--ticks', '1']), 'usage')
    expectEngineError(cli([]), 'usage')
    expectEngineError(cli([...base, '--out', 'file.ndjson']), 'usage')
    expectEngineError(cli([...base, '--fault', 'bad_deploy:target']), 'usage')
  }, LONG)
})

describe('determinism across processes (D-1, D-2, DET)', () => {
  for (const kind of ['baseline', ...faultKinds]) {
    it(`${kind}: two processes, same SHA-256 (D-1, 120 ticks)`, () => {
      const args = ['simulate', '--seed', 'gate1', '--ticks', '120', ...(kind === 'baseline' ? [] : ['--fault', kind])]
      const a = cli(args)
      const b = cli(args)
      expect(a.status).toBe(0)
      expect(b.status).toBe(0)
      expect(a.stdout.length).toBeGreaterThan(0)
      expect(sha256(b.stdout)).toBe(sha256(a.stdout))
    }, LONG)
  }

  it('same hash with TZ=UTC LANG=C and TZ=Asia/Tokyo LANG=pt_BR.UTF-8 (D-2)', () => {
    const args = ['simulate', '--seed', 'gate1', '--ticks', '60', '--fault', 'connection_pool_exhaustion', '--fault', 'disk_full']
    const c = cli(args, { TZ: 'UTC', LANG: 'C', LC_ALL: 'C' })
    const tokyo = cli(args, { TZ: 'Asia/Tokyo', LANG: 'pt_BR.UTF-8', LC_ALL: 'pt_BR.UTF-8' })
    expect(c.status).toBe(0)
    expect(tokyo.status).toBe(0)
    expect(sha256(tokyo.stdout)).toBe(sha256(c.stdout))
  }, LONG)

  it('different seeds give different output', () => {
    const a = cli(['simulate', '--seed', 'a', '--ticks', '5'])
    const b = cli(['simulate', '--seed', 'b', '--ticks', '5'])
    expect(sha256(a.stdout)).not.toBe(sha256(b.stdout))
  }, LONG)
})

describe('performance (CLI-5)', () => {
  for (const kind of faultKinds) {
    it(`--fault ${kind} --ticks 360 finishes in <= 10 s`, () => {
      const run = cli(['simulate', '--seed', 'perf', '--fault', kind, '--ticks', '360'])
      expect(run.status).toBe(0)
      expect(run.ms).toBeLessThanOrEqual(10_000)
    }, LONG)
  }
})

describe('boundary (D-5)', () => {
  it('main.ts imports only node:process and relative modules (no fs, no network)', () => {
    const text = readFileSync(mainTs, 'utf8')
    const specifiers = [...text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string)
    expect(specifiers.filter((s) => !s.startsWith('.'))).toEqual(['node:process'])
    expect(text).not.toMatch(/\b(import\(|require\(|fetch\()/)
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// In-process: run() with a fake node:process (reaches exit 1, the internal-error path).
// ---------------------------------------------------------------------------

interface FakeProcess {
  argv: string[]
  exitCode: number | undefined
  out: string[]
  err: string[]
  handlers: Map<string, (error: NodeJS.ErrnoException) => void>
  exits: (number | string | null | undefined)[]
}

async function loadMain(argv: string[], mocks: () => void = () => {}) {
  const fake: FakeProcess = { argv: ['node', 'main.js', ...argv], exitCode: undefined, out: [], err: [], handlers: new Map(), exits: [] }
  const processMock = {
    get argv() {
      return fake.argv
    },
    get exitCode() {
      return fake.exitCode
    },
    set exitCode(code: number | undefined) {
      fake.exitCode = code
    },
    stdout: {
      write: (text: string) => fake.out.push(text),
      on: (event: string, handler: (error: NodeJS.ErrnoException) => void) => fake.handlers.set(event, handler),
    },
    stderr: { write: (text: string) => fake.err.push(text) },
    exit: (code?: number | string | null) => {
      fake.exits.push(code)
    },
  }
  vi.resetModules()
  vi.doMock('node:process', () => ({ default: processMock }))
  mocks()
  const main = await import('../../src/cli/main.js')
  return { fake, main }
}

describe('run (in-process)', () => {
  afterEach(() => {
    vi.doUnmock('node:process')
    vi.doUnmock('../../src/sim/serialize.js')
    vi.resetModules()
  })

  it('the entry point runs argv and sets process.exitCode', async () => {
    const { fake } = await loadMain(['simulate', '--seed', 's', '--ticks', '2'])
    expect(fake.exitCode).toBe(0)
    expect(fake.err).toEqual([])
    expect(fake.out.join('')).toBe(toNdjson(simulate({ system: defaultShop, seed: 's' }, 2)))
  })

  it('an EngineError sets exit code 2 and writes nothing to stdout', async () => {
    const { fake } = await loadMain(['simulate', '--seed', 's', '--ticks', '0'])
    expect(fake.exitCode).toBe(2)
    expect(fake.out).toEqual([])
    expect(fake.err.join('')).toContain('error [usage]')
  })

  it('any other error is internal: exit 1, stdout empty, no stack', async () => {
    const { main } = await loadMain(['--help'], () => {
      vi.doMock('../../src/sim/serialize.js', () => ({
        toNdjson: () => {
          throw new TypeError('boom')
        },
      }))
    })
    const out: string[] = []
    const err: string[] = []
    const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }
    expect(main.run(['simulate', '--seed', 's', '--ticks', '1'], io)).toBe(main.EXIT_INTERNAL)
    expect(out).toEqual([])
    expect(err).toEqual(['whodeployed-engine: internal error: TypeError: boom\n'])
  })

  it('a non-Error throw and an empty message are reported too', async () => {
    let thrown: unknown = 'plain string'
    const { main } = await loadMain(['--help'], () => {
      vi.doMock('../../src/sim/serialize.js', () => ({
        toNdjson: () => {
          throw thrown
        },
      }))
    })
    const err: string[] = []
    const io = { stdout: () => {}, stderr: (t: string) => err.push(t) }
    expect(main.run(['simulate', '--seed', 's', '--ticks', '1'], io)).toBe(1)
    thrown = new RangeError('')
    expect(main.run(['simulate', '--seed', 's', '--ticks', '1'], io)).toBe(1)
    expect(err).toEqual(['whodeployed-engine: internal error: plain string\n', 'whodeployed-engine: internal error: RangeError\n'])
  })

  it('exit codes are 0, 1 and 2', async () => {
    const { main } = await loadMain(['--help'])
    expect([main.EXIT_OK, main.EXIT_INTERNAL, main.EXIT_ENGINE_ERROR]).toEqual([0, 1, 2])
  })

  it('stdout EPIPE exits quietly with the current code; another stream error exits 1', async () => {
    const { fake } = await loadMain(['--help'])
    const onError = fake.handlers.get('error')
    expect(onError).toBeDefined()
    onError?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(fake.exits).toEqual([0])
    fake.err.length = 0
    onError?.(Object.assign(new Error('write EIO'), { code: 'EIO' }))
    expect(fake.exits).toEqual([0, 1])
    expect(fake.err.join('')).toContain('cannot write to stdout')
  })
})
