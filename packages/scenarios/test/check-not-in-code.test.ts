// CN-8 (PRD FASE-2), SPEC §3.7: scripts/check-not-in-code.mjs finds scenario strings embedded in
// code. Runs the real script as a child process (exit code and output are the contract the CI
// step relies on) against temporary scenario directories and source trees.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(pkgDir, '..', '..')
const script = join(pkgDir, 'scripts', 'check-not-in-code.mjs')

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cn8-'))
  temps.push(dir)
  return dir
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

// A campaign-like scenario in the SPEC §7 format (sample only, not a campaign file).
const SAMPLE = {
  id: '03-sample-pool-exhausted',
  title: 'Checkout slow on sample day',
  teaches: 'Aggregated latency hides a single saturated sample dependency',
  alertText: '[FIRING] SampleLatencyHigh checkout: p95 > 2s for 3m',
  rootCause: "payment's sample retry path leaks DB connections",
}

const sampleYaml = `id: ${SAMPLE.id}
title: "${SAMPLE.title}"
level: junior
teaches: "${SAMPLE.teaches}"
trap: "Sample trap: gateway dashboard is green"
seed: "sample-01"
system: default-shop
faults:
  - kind: connection_pool_exhaustion
    target: payment
    startTick: 12
    params: { poolSize: 20, leakPerTick: 2 }
noise:
  - kind: deploy
    target: catalog
    tick: 10
    note: "harmless sample change"
alert:
  tick: 18
  text: "${SAMPLE.alertText}"
impactBudget: 60
referencePath:
  - { ask: logs, service: payment, window: 30 }
  - { act: restart, target: payment }
rootCause: "${SAMPLE.rootCause}"   # never shown before the review
review:
  redundant: ["dashboard gateway"]
  keySignal: "sample key signal"
  keySignalAsk: "logs payment"
`

/** A scenarios dir with the sample, plus a "_" file whose strings must be ignored. */
function scenariosDir(yaml: string = sampleYaml): string {
  const dir = tempDir()
  writeFileSync(join(dir, '03-sample-pool-exhausted.yaml'), yaml)
  writeFileSync(
    join(dir, '_TEMPLATE.yaml'),
    sampleYaml.replace(SAMPLE.id, '00-ignored-template').replace(SAMPLE.title, 'Ignored template title'),
  )
  return dir
}

/** A source tree with one clean file and, optionally, one file with `content`. */
function tree(content?: string, name = 'planted.ts'): string {
  const dir = tempDir()
  mkdirSync(join(dir, 'nested'))
  writeFileSync(join(dir, 'clean.ts'), "export const answer = 'nothing from a scenario here'\n")
  if (content !== undefined) writeFileSync(join(dir, 'nested', name), content)
  return dir
}

describe('check-not-in-code (CN-8)', () => {
  it('exits 0 when no scenario string is in the trees', () => {
    const r = run(['--scenarios', scenariosDir(), '--tree', tree(), '--tree', tree()])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('OK, 5 string(s) from 1 scenario file(s)')
  })

  const fields: readonly [string, string][] = [
    ['id', SAMPLE.id],
    ['title', SAMPLE.title],
    ['teaches', SAMPLE.teaches],
    ['alert.text', SAMPLE.alertText],
    ['rootCause', SAMPLE.rootCause],
  ]

  it.each(fields)('exits 1 and names file and string when %s is embedded in code', (field, value) => {
    const r = run(['--scenarios', scenariosDir(), '--tree', tree(`export const s = ${JSON.stringify(value)}\n`)])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(new RegExp(`nested[/\\\\]planted\\.ts: scenario ${field.replace('.', '\\.')} "`))
    expect(r.stderr).toContain(`"${value}"`)
    expect(r.stderr).toContain('1 scenario string(s) found in code')
  })

  it('finds a string inside a larger literal, in any file type (grep -F semantics)', () => {
    const r = run(['--scenarios', scenariosDir(), '--tree', tree(`<h1>Now: ${SAMPLE.title}!</h1>\n`, 'page.html')])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('page.html: scenario title')
  })

  it('finds a string written as an escaped JS literal', () => {
    const escaped = `export const s = '${SAMPLE.rootCause.replace(/'/g, "\\'")}'\n`
    const r = run(['--scenarios', scenariosDir(), '--tree', tree(escaped)])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('scenario rootCause')
  })

  it('lists every occurrence across trees', () => {
    const a = tree(`const t = '${SAMPLE.title}'\nconst i = '${SAMPLE.id}'\n`)
    const b = tree(`const a = ${JSON.stringify(SAMPLE.alertText)}\n`, 'other.tsx')
    const r = run(['--scenarios', scenariosDir(), '--tree', a, '--tree', b])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('3 scenario string(s) found in code')
  })

  it('ignores files whose name starts with "_" (template)', () => {
    const r = run(['--scenarios', scenariosDir(), '--tree', tree("const t = 'Ignored template title'\n")])
    expect(r.status).toBe(0)
  })

  it('does not flag the apps/web test fixtures (their text is unlike any scenario)', () => {
    const t = tree()
    copyFileSync(join(repoRoot, 'apps', 'web', 'test', 'fixtures', 'scenarios.ts'), join(t, 'fixtures.ts'))
    const r = run(['--scenarios', scenariosDir(), '--tree', t])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('reads single-quoted, plain, block and flow-mapping scalars', () => {
    const yaml = `---
id: 04-sample-forms   # comment
title: 'It''s a sample'
level: pleno
teaches: >
  Folded sample
  lesson text
seed: s
faults: []
alert: { tick: 3, text: "Sample \\"quoted\\" alert" }
rootCause: |
  Literal sample
  root cause
`
    const dir = tempDir()
    writeFileSync(join(dir, '04-sample-forms.yml'), yaml)
    const values = ['04-sample-forms', "It's a sample", 'Folded sample lesson text', 'Sample "quoted" alert', 'Literal sample\nroot cause']
    for (const value of values) {
      const r = run(['--scenarios', dir, '--tree', tree(`/* ${value} */\n`)])
      expect(r.status, value).toBe(1)
    }
    expect(run(['--scenarios', dir, '--tree', tree()]).status).toBe(0)
  })

  // QA counterexamples on PR #93 (CN-8, SPEC §3.7): valid block forms the first extractor read
  // differently from a YAML parser. The value planted is the one the parser gives.
  it.each([
    ['(a) ">" folded block with more-indented lines', 'teaches: >\n  para one\n    indented\n  end', 'para one\n  indented\nend'],
    ['(a) ">" folded block with a list', 'rootCause: >\n  Pool leak:\n\n    - retry path\n    - no release', 'Pool leak:\n\n  - retry path\n  - no release'],
    ['(b) explicit indentation indicator "|1"', 'rootCause: |1\n   line one\n   line two', '  line one\n  line two'],
    ['(c) comment line at another indentation under "|"', 'teaches: |\n    deep line\n # note', 'deep line'],
  ])('exits 1 on %s when the parsed value is planted', (_case, block, parsed) => {
    const key = block.slice(0, block.indexOf(':'))
    const yaml = sampleYaml.replace(new RegExp(`^${key}:.*$`, 'm'), block)
    const r = run(['--scenarios', scenariosDir(yaml), '--tree', tree(`export const s = ${JSON.stringify(parsed)}\n`)])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`scenario ${key} `)
  })

  it('matches each line of a multi-line value on its own (grep -F pattern list)', () => {
    const yaml = sampleYaml.replace(/^rootCause:.*$/m, 'rootCause: |\n  first sample line\n  second sample line')
    const r = run(['--scenarios', scenariosDir(yaml), '--tree', tree("const s = ['second sample line']\n")])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('scenario rootCause')
    expect(r.stderr).toContain('[matched line "second sample line"]')
    // A whole-value match names no line.
    const whole = run(['--scenarios', scenariosDir(yaml), '--tree', tree('const s = "first sample line\\nsecond sample line"\n')])
    expect(whole.status).toBe(1)
    expect(whole.stderr).not.toContain('[matched line')
  })

  it.each([
    ['a missing field', sampleYaml.replace(/^teaches:.*\n/m, ''), 'field "teaches": missing'],
    ['a missing alert.text', sampleYaml.replace(/^ {2}text:.*\n/m, ''), 'field "alert.text": missing'],
    ['a non-string field', sampleYaml.replace(/^title:.*$/m, 'title: 42'), 'field "title": must be a string'],
    ['an empty field', sampleYaml.replace(/^title:.*$/m, 'title: ""'), 'field "title": empty'],
    ['an unresolved alias', sampleYaml.replace(/^title:.*$/m, 'title: *t'), 'invalid YAML'],
    ['invalid YAML', sampleYaml.replace(/^title:.*$/m, 'title: "unclosed'), 'invalid YAML'],
    ['a duplicate key', `${sampleYaml}title: "again"\n`, 'invalid YAML'],
  ])('exits 2 naming file and field on %s (fail closed)', (_case, yaml, message) => {
    const r = run(['--scenarios', scenariosDir(yaml), '--tree', tree()])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('03-sample-pool-exhausted.yaml')
    expect(r.stderr).toContain(message)
  })

  it('exits 2 when a tree or the scenarios directory does not exist', () => {
    const missing = join(tempDir(), 'missing')
    expect(run(['--scenarios', scenariosDir(), '--tree', missing]).status).toBe(2)
    expect(run(['--scenarios', missing, '--tree', tree()]).status).toBe(2)
    expect(run(['--bogus']).status).toBe(2)
  })

  it('passes on the repository (real scenarios against packages/engine/src and apps/web/src)', () => {
    const r = run([])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/packages[/\\]engine[/\\]src, apps[/\\]web[/\\]src/)
  })
})
