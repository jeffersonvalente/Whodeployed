/**
 * T1.13 — scripts/verify-coherence.mjs (PRD P-4, ADR-005).
 * The script is independent of the engine (no import from src/ or packages); it accepts a
 * coherent sample and rejects samples with a wrong metric, a wrong percentile, an error span
 * without a log, a child longer than its parent (and other S-3 breaks), exiting 0/1 with the
 * deviation on stderr. DET: same input => same output.
 *
 * The samples in test/scripts/samples/ are small, hand-checked NDJSON files; every bad sample
 * is coherent.ndjson with one deliberate defect.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
const script = join(pkgDir, 'scripts', 'verify-coherence.mjs')
const samplesDir = fileURLToPath(new URL('./samples', import.meta.url))
const sample = (name: string) => join(samplesDir, `${name}.ndjson`)
const coherentLines = readFileSync(sample('coherent'), 'utf8').trimEnd().split('\n')

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function run(args: readonly string[], input?: string, env: NodeJS.ProcessEnv = process.env): Run {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: pkgDir,
    encoding: 'utf8',
    env,
    ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input }),
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const runStdin = (lines: readonly string[]) => run([], lines.map((l) => `${l}\n`).join(''))

function expectDeviation(result: Run, pattern: RegExp) {
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/^verify-coherence: /)
  expect(result.stderr).toMatch(pattern)
  // Only the first deviation is reported.
  expect(result.stderr.trimEnd().split('\n')).toHaveLength(1)
}

describe('verify-coherence — independence from the engine (P-4)', () => {
  const text = readFileSync(script, 'utf8')

  it('imports only Node built-ins, nothing from src/ nor any package', () => {
    const specifiers = [
      ...text.matchAll(/\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g),
      ...text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
      ...text.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g),
      ...text.matchAll(/\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g),
    ].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const spec of specifiers) expect(spec).toMatch(/^node:/)
    // No other way of loading code: dynamic import with a computed path or createRequire.
    expect(text).not.toMatch(/\bimport\s*\(\s*[^'"`\s]/)
    expect(text).not.toMatch(/\bcreateRequire\b/)
  })
})

describe('verify-coherence — coherent input', () => {
  it('accepts the coherent sample from a file (exit 0, summary on stdout, empty stderr)', () => {
    const result = run([sample('coherent')])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      'verify-coherence: ok: 22 records; 10 metric records, 2 error spans, 4 traces coherent\n',
    )
  })

  it('reads stdin when no file is given, or with "-"', () => {
    const input = readFileSync(sample('coherent'), 'utf8')
    const fromFile = run([sample('coherent')])
    expect(run([], input)).toEqual(fromFile)
    expect(run(['-'], input)).toEqual(fromFile)
  })

  it('accepts empty input and input without a trailing newline', () => {
    expect(run([], '')).toMatchObject({ status: 0, stdout: 'verify-coherence: ok: 0 records; 0 metric records, 0 error spans, 0 traces coherent\n' })
    expect(run([], coherentLines.join('\n')).status).toBe(0)
  })

  it('compares with tolerance 1e-9', () => {
    const within = coherentLines.map((l) => l.replace('"errorPct":33.33333333333333', '"errorPct":33.3333333336'))
    expect(within).not.toEqual(coherentLines)
    expect(runStdin(within).status).toBe(0)
    const outside = coherentLines.map((l) => l.replace('"errorPct":33.33333333333333', '"errorPct":33.3333'))
    expectDeviation(runStdin(outside), /line 14: P-2 errorPct mismatch .* metric says 33\.3333, 3 server span\(s\) give 33\.33/)
  })
})

describe('verify-coherence — rejects incoherent samples (exit 1, first deviation on stderr)', () => {
  const cases: [string, RegExp][] = [
    ['bad-metric', /line 14: P-2 rps mismatch for tick 0, component "api", aggregate: metric says 0\.4, 3 server span\(s\) give 0\.3/],
    ['bad-percentile', /line 12: P-1 p95 mismatch for tick 0, component "api", instance "api-0": metric says 39, 2 server span\(s\) give 40/],
    ['aggregate-mean-of-percentiles', /line 14: P-2 p50 mismatch .* metric says 25, 3 server span\(s\) give 30/],
    ['missing-metric', /line 4: P-4 server span "t0r0s2" has no metric record for tick 0, component "db", instance "db-0"/],
    ['duplicate-metric', /line 23: duplicate metric record for tick 1, component "db", aggregate \(first at line 22\)/],
    ['error-span-without-log', /line 5: P-3 error span "t0r1s0" has no 'error' log .* instance "api-1", tick 0 and traceId "t0r1"/],
    ['error-log-wrong-instance', /line 5: P-3 error span "t0r1s0" has no 'error' log/],
    ['child-longer-than-parent', /line 3: S-3 span "t0r0s1" lasts 25 ms, longer than its parent "t0r0s0" \(20 ms\)/],
    ['child-ends-after-parent', /line 4: S-3 span "t0r0s2" ends at 14 ms, after its parent "t0r0s1" \(12 ms\)/],
    ['two-roots', /line 2: S-3 trace "t0r0" has 2 roots \(lines 2, 3\)/],
    ['unknown-parent', /line 4: S-3 span "t0r0s2" has parentId "t0r0s9" not found in trace "t0r0"/],
  ]

  it('has a test case for every bad sample file', () => {
    const files = readdirSync(samplesDir)
      .filter((f) => f.endsWith('.ndjson') && f !== 'coherent.ndjson')
      .map((f) => f.replace(/\.ndjson$/, ''))
      .sort()
    expect(files).toEqual(cases.map(([name]) => name).sort())
  })

  it.each(cases)('%s', (name, pattern) => {
    expectDeviation(run([sample(name)]), pattern)
  })

  it('a log of level warn does not satisfy P-3', () => {
    const lines = coherentLines.map((l) => (l.includes('"level":"error"') ? l.replace('"level":"error"', '"level":"warn"') : l))
    expectDeviation(runStdin(lines), /P-3 error span "t0r1s0"/)
  })

  it('matches error logs by component, instance, tick and traceId', () => {
    // Keep the server-span log (same instance/trace), so P-3 still holds: logs are matched by
    // component, instance, tick and traceId, not one per span.
    const onlyOne = coherentLines.filter((l) => !l.includes('"message":"upstream timeout"'))
    expect(runStdin(onlyOne).status).toBe(0)
    const otherTick = onlyOne.map((l) => l.replace('"tick":0,"component":"api","instance":"api-1","level":"error"', '"tick":1,"component":"api","instance":"api-1","level":"error"'))
    expectDeviation(runStdin(otherTick), /line 5: P-3 error span "t0r1s0"/)
  })

  it('detects a trace with no root and a parent cycle', () => {
    const span = (id: string, parent?: string) =>
      JSON.stringify({
        type: 'span',
        tick: 0,
        traceId: 'tx',
        spanId: id,
        ...(parent === undefined ? {} : { parentId: parent }),
        component: 'api',
        instance: 'api-0',
        operation: 'op',
        kind: 'internal',
        startMs: 0,
        durationMs: 5,
        status: 'ok',
      })
    expectDeviation(runStdin([span('a', 'b'), span('b', 'a')]), /line 1: S-3 trace "tx" has 0 roots$/m)
    expectDeviation(runStdin([span('r'), span('a', 'b'), span('b', 'a')]), /line 2: S-3 span "a" is in a parent cycle/)
    expectDeviation(runStdin([span('r'), span('r', 'r')]), /line 2: S-3 trace "tx" repeats spanId "r"/)
  })

  it('rejects malformed lines with the line number', () => {
    const malformed: [string, RegExp][] = [
      ['{not json', /line 2: not valid JSON/],
      ['[1,2]', /line 2: not a JSON object/],
      ['null', /line 2: not a JSON object/],
      ['{"type":"gauge","tick":0}', /line 2: type "gauge" is not one of metric, log, span, event/],
      ['{"type":"event","tick":1.5,"kind":"deploy","target":"api"}', /line 2: tick 1\.5 is not an integer >= 0/],
      ['{"type":"event","tick":-1,"kind":"deploy","target":"api"}', /line 2: tick -1 is not an integer >= 0/],
      ['{"type":"event","kind":"deploy","target":"api"}', /line 2: tick undefined is not an integer >= 0/],
      ['{"type":"span","tick":0,"traceId":"x","spanId":"y","component":"api","instance":"api-0","kind":"server","status":"ok","startMs":0}', /line 2: span field durationMs is not a number/],
      ['{"type":"span","tick":0,"traceId":"x","spanId":"y","parentId":7,"component":"api","instance":"api-0","kind":"server","status":"ok","startMs":0,"durationMs":1}', /line 2: span field parentId is not a string/],
      ['{"type":"span","tick":0,"spanId":"y","component":"api","instance":"api-0","kind":"server","status":"ok","startMs":0,"durationMs":1}', /line 2: span field traceId is not a string/],
      ['{"type":"metric","tick":0,"rps":0,"p50":0,"p95":0,"p99":0,"errorPct":0}', /line 2: metric field component is not a string/],
      ['{"type":"metric","tick":0,"component":"api","rps":"0","p50":0,"p95":0,"p99":0,"errorPct":0}', /line 2: metric field rps is not a number/],
    ]
    for (const [line, pattern] of malformed) {
      expectDeviation(runStdin([coherentLines[0] as string, line]), pattern)
    }
  })
})

describe('verify-coherence — usage errors (exit 2)', () => {
  it('rejects more than one argument', () => {
    const result = run(['a.ndjson', 'b.ndjson'])
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/usage: verify-coherence\.mjs/)
  })

  it('reports an unreadable file', () => {
    const result = run([join(samplesDir, 'does-not-exist.ndjson')])
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/cannot read ".*does-not-exist\.ndjson"/)
  })
})

describe('verify-coherence — determinism (DET)', () => {
  const names = readdirSync(samplesDir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()

  it('same input => same exit code, stdout and stderr, across runs and TZ/LANG', () => {
    for (const name of names) {
      const path = join(samplesDir, name)
      const first = run([path])
      expect(run([path])).toEqual(first)
      expect(run([path], undefined, { ...process.env, TZ: 'Asia/Tokyo', LANG: 'pt_BR.UTF-8', LC_ALL: 'pt_BR.UTF-8' })).toEqual(first)
      expect(run([path], undefined, { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' })).toEqual(first)
    }
  })
})
