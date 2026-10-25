/**
 * T1.12 — CLI argv parser and help text (ADR-007; PRD CLI-2, CLI-3 parse errors, CLI-4, D-5).
 * T1.23 — parse errors are the shared EngineError (#15); `params` has no prototype (#22).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAX_TICKS, parseCliArgs, parseFaultSpec } from '../../src/cli/args.js'
import { helpText } from '../../src/cli/help.js'
import { EngineError, isEngineError } from '../../src/errors.js'
import { faultCatalog, faultKinds } from '../../src/faults/catalog.js'
import type { CliCommand, EngineErrorInfo } from '../../src/types.js'

const base = ['simulate', '--seed', 's1', '--ticks', '30']

/** Runs the parser expecting a usage error; returns it. */
function usageError(argv: readonly string[]): EngineErrorInfo {
  try {
    parseCliArgs(argv)
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError)
    expect(isEngineError(error)).toBe(true)
    expect(error).toBeInstanceOf(Error)
    const info = error as EngineErrorInfo
    expect(info.name).toBe('EngineError')
    expect(info.code).toBe('usage')
    expect(info.message.length).toBeGreaterThan(0)
    expect(info.message).toContain(info.field)
    return info
  }
  throw new Error(`expected a usage error for ${JSON.stringify(argv)}`)
}

describe('parseCliArgs: simulate', () => {
  it('parses seed and ticks with no fault (baseline)', () => {
    expect(parseCliArgs(base)).toEqual({ kind: 'simulate', seed: 's1', ticks: 30, faults: [] })
  })

  it('accepts options in any order and the --opt=value form', () => {
    expect(parseCliArgs(['simulate', '--ticks=5', '--seed=a:lastWeek'])).toEqual({
      kind: 'simulate',
      seed: 'a:lastWeek',
      ticks: 5,
      faults: [],
    })
    expect(parseCliArgs(['--seed', 'x', 'simulate', '--ticks', '1'])).toEqual({ kind: 'simulate', seed: 'x', ticks: 1, faults: [] })
  })

  it('accepts ticks at both ends of 1..100000', () => {
    expect((parseCliArgs(['simulate', '--seed', 's', '--ticks', '1']) as { ticks: number }).ticks).toBe(1)
    expect((parseCliArgs(['simulate', '--seed', 's', '--ticks', String(MAX_TICKS)]) as { ticks: number }).ticks).toBe(100000)
  })
})

describe('parseCliArgs: --fault syntax (CLI-2)', () => {
  it('each of the 6 kinds alone takes catalog defaults (only kind is set)', () => {
    for (const kind of faultKinds) {
      expect(parseCliArgs([...base, '--fault', kind])).toEqual({ kind: 'simulate', seed: 's1', ticks: 30, faults: [{ kind }] })
    }
  })

  it('overrides target, startTick and params', () => {
    const cmd = parseCliArgs([...base, '--fault', 'connection_pool_exhaustion:target=cart,startTick=5,poolSize=10'])
    expect(cmd).toEqual({
      kind: 'simulate',
      seed: 's1',
      ticks: 30,
      faults: [{ kind: 'connection_pool_exhaustion', target: 'cart', startTick: 5, params: { poolSize: 10 } }],
    })
  })

  it('accepts only target, only startTick, decimals and exponents', () => {
    expect(parseFaultSpec('bad_deploy:target=auth')).toEqual({ kind: 'bad_deploy', target: 'auth' })
    expect(parseFaultSpec('disk_full:startTick=0')).toEqual({ kind: 'disk_full', startTick: 0 })
    expect(parseFaultSpec('disk_full:failRatio=0.5,fillTicks=2')).toEqual({ kind: 'disk_full', params: { failRatio: 0.5, fillTicks: 2 } })
    expect(parseFaultSpec('slow_dependency:addedLatencyMs=1e3')).toEqual({ kind: 'slow_dependency', params: { addedLatencyMs: 1000 } })
    expect(parseFaultSpec('bad_deploy:errorRatio=.25')).toEqual({ kind: 'bad_deploy', params: { errorRatio: 0.25 } })
    expect(parseFaultSpec(' bad_deploy : target = auth ')).toEqual({ kind: 'bad_deploy', target: 'auth' })
  })

  it('keeps out-of-range or negative values for resolveFaults to reject (F-7)', () => {
    expect(parseFaultSpec('disk_full:startTick=-3,failRatio=7')).toEqual({ kind: 'disk_full', startTick: -3, params: { failRatio: 7 } })
  })

  it('params has no prototype: __proto__ and constructor become own keys for resolveFaults (#22)', () => {
    const input = parseFaultSpec('bad_deploy:__proto__=1,constructor=2')
    expect(input.params).toBeDefined()
    const params = input.params as Record<string, number>
    expect(Object.getPrototypeOf(params)).toBeNull()
    expect(Object.keys(params)).toEqual(['__proto__', 'constructor'])
    expect(params['__proto__']).toBe(1)
    expect(params['constructor']).toBe(2)
  })

  it('leaves unknown kinds and keys to resolveFaults (syntax only)', () => {
    expect(parseFaultSpec('no_such_kind:foo=1')).toEqual({ kind: 'no_such_kind', params: { foo: 1 } })
  })

  it('repeated --fault keeps the given order (F-6)', () => {
    const cmd = parseCliArgs([
      ...base,
      '--fault',
      'connection_pool_exhaustion:target=payment',
      '--fault',
      'service_crash_loop:target=catalog',
      '--fault=slow_dependency',
    ])
    expect(cmd.kind === 'simulate' && cmd.faults).toEqual([
      { kind: 'connection_pool_exhaustion', target: 'payment' },
      { kind: 'service_crash_loop', target: 'catalog' },
      { kind: 'slow_dependency' },
    ])
  })
})

describe('parseCliArgs: help (CLI-4)', () => {
  it('root help', () => {
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help', topic: 'root' })
    expect(parseCliArgs(['-h'])).toEqual({ kind: 'help', topic: 'root' })
  })

  it('simulate help, even without the required options', () => {
    expect(parseCliArgs(['simulate', '--help'])).toEqual({ kind: 'help', topic: 'simulate' })
    expect(parseCliArgs(['--help', 'simulate'])).toEqual({ kind: 'help', topic: 'simulate' })
    expect(parseCliArgs([...base, '--fault', 'x', '-h'])).toEqual({ kind: 'help', topic: 'simulate' })
  })
})

describe('parseCliArgs: usage errors (CLI-3)', () => {
  it('--seed missing', () => {
    expect(usageError(['simulate', '--ticks', '10']).field).toBe('--seed')
  })

  it('--seed given twice', () => {
    expect(usageError(['simulate', '--seed', 'a', '--seed', 'b', '--ticks', '10']).field).toBe('--seed')
  })

  it("an empty --seed parses: buildWorld rejects it as 'invalid_seed' (ADR-007 Emenda 1)", () => {
    expect(parseCliArgs(['simulate', '--seed=', '--ticks', '10'])).toEqual({ kind: 'simulate', seed: '', ticks: 10, faults: [] })
  })

  it('--seed without value', () => {
    expect(usageError(['simulate', '--ticks', '10', '--seed']).field).toBe('arguments')
  })

  it('--ticks missing', () => {
    expect(usageError(['simulate', '--seed', 's']).field).toBe('--ticks')
  })

  for (const ticks of ['0', '-1', '-5', '1.5', 'abc', '', '1e3', '0x10', '100001', '99999999999999999999', ' 5']) {
    it(`--ticks '${ticks}' is rejected (not an integer in 1..100000)`, () => {
      const err = usageError(['simulate', '--seed', 's', `--ticks=${ticks}`])
      expect(err.field).toBe('--ticks')
      expect(err.received).toBe(ticks)
      expect(err.validValues).toEqual(['1..100000'])
      expect(err.message).toContain('1..100000')
    })
  }

  it('--ticks with a dash-leading separate value is a parse error', () => {
    expect(usageError(['simulate', '--seed', 's', '--ticks', '-5']).field).toBe('arguments')
  })

  it('--ticks given twice', () => {
    expect(usageError([...base, '--ticks', '40']).field).toBe('--ticks')
  })

  it('missing or unknown command', () => {
    expect(usageError([]).field).toBe('command')
    expect(usageError(['--seed', 's', '--ticks', '3']).field).toBe('command')
    const err = usageError(['simulat', '--seed', 's', '--ticks', '3'])
    expect(err.field).toBe('command')
    expect(err.validValues).toEqual(['simulate'])
    expect(usageError(['run', '--help']).field).toBe('command')
  })

  it('unknown option and extra positional', () => {
    const err = usageError([...base, '--out', 'file.ndjson'])
    expect(err.field).toBe('arguments')
    expect(err.validValues).toEqual(['--seed', '--ticks', '--fault', '--help'])
    expect(usageError([...base, 'extra']).field).toBe('arguments')
  })

  const malformed: [string, string][] = [
    ['', '--fault[0]'],
    [':target=cart', '--fault[0]'],
    ['bad_deploy:', '--fault[0]'],
    ['bad_deploy:target', '--fault[0]'],
    ['bad_deploy:target=', '--fault[0]'],
    ['bad_deploy:=cart', '--fault[0]'],
    ['bad_deploy:target=a,,errorRatio=1', '--fault[0]'],
    ['bad_deploy:target=a,target=b', '--fault[0].target'],
    ['bad_deploy:errorRatio=abc', '--fault[0].errorRatio'],
    ['bad_deploy:errorRatio=Infinity', '--fault[0].errorRatio'],
    ['bad_deploy:errorRatio=0x1', '--fault[0].errorRatio'],
    ['bad_deploy:startTick=1.5', '--fault[0].startTick'],
    ['bad_deploy:startTick=x', '--fault[0].startTick'],
  ]
  for (const [spec, field] of malformed) {
    it(`malformed --fault '${spec}' => usage error on ${field}`, () => {
      const err = usageError([...base, `--fault=${spec}`])
      expect(err.field).toBe(field)
    })
  }

  it('reports the index of the offending --fault', () => {
    expect(usageError([...base, '--fault', 'disk_full', '--fault', 'bad_deploy:x']).field).toBe('--fault[1]')
  })

  it('parseFaultSpec defaults the field to --fault', () => {
    expect(() => parseFaultSpec('')).toThrow(/--fault/)
  })
})

describe('helpText (CLI-4)', () => {
  for (const topic of ['root', 'simulate'] as const) {
    it(`${topic} help lists --seed, --fault, --ticks, the --fault syntax and the 6 kinds with defaults`, () => {
      const text = helpText(topic)
      for (const flag of ['--seed', '--fault', '--ticks', '--help']) expect(text).toContain(flag)
      expect(text).toContain('<kind>[:<key>=<value>[,<key>=<value>]...]')
      expect(text).toContain('1..100000')
      for (const kind of faultKinds) {
        const entry = faultCatalog[kind]
        expect(text).toMatch(new RegExp(`^  ${kind}$`, 'm'))
        expect(text).toContain(`target: ${entry.defaultTarget} (${entry.targetRule})   startTick: ${entry.defaultStartTick}`)
        for (const [name, spec] of Object.entries(entry.params)) {
          expect(text).toMatch(new RegExp(`${name} +default ${spec.default}, (integer|number) ${spec.min}\\.\\.${spec.max} `))
        }
      }
      expect(text.endsWith('\n')).toBe(true)
    })
  }

  it('root help lists the simulate command; simulate help shows its usage line', () => {
    expect(helpText('root')).toContain('Commands:\n  simulate')
    expect(helpText('simulate').startsWith('Usage: whodeployed-engine simulate --seed')).toBe(true)
  })

  it('every example in the help parses', () => {
    const examples = [...helpText('root').matchAll(/^ {4}(--fault .*)$/gm)].map((m) => m[1] as string)
    expect(examples.length).toBeGreaterThan(0)
    for (const example of examples) {
      const args = example.split(/\s+(?=--fault)/).flatMap((part) => {
        const value = part.replace(/^--fault /, '').replace(/^'(.*)'$/, '$1')
        return ['--fault', value]
      })
      expect(() => parseCliArgs([...base, ...args])).not.toThrow()
    }
  })
})

describe('determinism (DET) and boundary (D-5)', () => {
  const samples: string[][] = [
    base,
    [...base, '--fault', 'connection_pool_exhaustion:target=cart,startTick=5,poolSize=10', '--fault', 'disk_full'],
    ['--help'],
    ['simulate', '--help'],
  ]

  it('same argv => same CliCommand, byte-identical JSON', () => {
    for (const argv of samples) {
      const a: CliCommand = parseCliArgs(argv)
      const b: CliCommand = parseCliArgs([...argv])
      expect(b).toStrictEqual(a)
      expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    }
  })

  it('same topic => same help text', () => {
    expect(helpText('root')).toBe(helpText('root'))
    expect(helpText('simulate')).toBe(helpText('simulate'))
  })

  it('does not mutate argv', () => {
    const argv = [...base, '--fault', 'disk_full:failRatio=0.5']
    const copy = [...argv]
    parseCliArgs(argv)
    expect(argv).toEqual(copy)
  })

  it('args.ts imports only node:util and relative modules; help.ts only relative modules', () => {
    const imports = (file: string) => {
      const text = readFileSync(fileURLToPath(new URL(`../../src/cli/${file}`, import.meta.url)), 'utf8')
      return [...text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string)
    }
    expect(imports('args.ts').filter((s) => !s.startsWith('.'))).toEqual(['node:util'])
    expect(imports('help.ts').filter((s) => !s.startsWith('.'))).toEqual([])
  })
})
