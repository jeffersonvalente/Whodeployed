// ADR-014 §1.1 / SPEC §6: packages/scenarios/src depends on the engine's *types* only.
// Two checks: (1) the ESLint config of this package refuses sample files under src/ that import
// an engine value, and accepts type-only imports; (2) the real files in src/ import the engine
// only with `import type` / `export type`.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(pkgDir, 'src')

const eslint = new ESLint({ cwd: pkgDir })

async function lintSample(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(pkgDir, filePath) })
  if (result === undefined) throw new Error('ESLint returned no result')
  return result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? `fatal: ${m.message}`)
}

const refused: readonly [string, string][] = [
  ['named value import', "import { createSimulation } from '@whodeployed/engine'\nexport const x = createSimulation\n"],
  ['value and type mixed', "import { defaultShop, type Fault } from '@whodeployed/engine'\nexport type F = Fault\nexport const s = defaultShop\n"],
  ['namespace import', "import * as engine from '@whodeployed/engine'\nexport const e = engine\n"],
  ['default import', "import engine from '@whodeployed/engine'\nexport const e = engine\n"],
  ['side-effect import', "import '@whodeployed/engine'\n"],
  ['value re-export', "export { resolveFaults } from '@whodeployed/engine'\n"],
  ['star re-export', "export * from '@whodeployed/engine'\n"],
  ['inline type only (still loads the module)', "import { type Fault } from '@whodeployed/engine'\nexport type F = Fault\n"],
  ['dynamic import', "export const load = () => import('@whodeployed/engine')\n"],
  ['deep import, even type-only', "import type { Fault } from '@whodeployed/engine/dist/types.js'\nexport type F = Fault\n"],
]

const accepted: readonly [string, string][] = [
  ['import type', "import type { Fault, Question } from '@whodeployed/engine'\nexport type F = Fault | Question\n"],
  ['export type', "export type { Fault } from '@whodeployed/engine'\n"],
  ['relative import', "import type { Scenario } from './types.js'\nexport type S = Scenario\n"],
]

describe('ESLint: src/ imports only types from @whodeployed/engine (ADR-014 §1.1)', () => {
  it.each(refused)('refuses %s in src/', async (_name, code) => {
    const errors = await lintSample(code, 'src/__sample__.ts')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((id) => !id.startsWith('fatal'))).toBe(true)
    expect(
      errors.some((id) =>
        ['@typescript-eslint/no-restricted-imports', '@typescript-eslint/no-import-type-side-effects', 'no-restricted-syntax'].includes(id),
      ),
    ).toBe(true)
  })

  it.each(accepted)('accepts %s in src/', async (_name, code) => {
    expect(await lintSample(code, 'src/__sample__.ts')).toEqual([])
  })

  it('reports the type-only message for a value import', async () => {
    const [result] = await eslint.lintText("import { faultCatalog } from '@whodeployed/engine'\nexport const c = faultCatalog\n", {
      filePath: join(pkgDir, 'src/__sample__.ts'),
    })
    expect(result?.messages.map((m) => m.message).join('\n')).toMatch(/only types from the engine/)
  })

  it('allows engine values in test/ (tests build the EngineRuntime)', async () => {
    const code = "import { createSimulation } from '@whodeployed/engine'\nexport const x = createSimulation\n"
    expect(await lintSample(code, 'test/__sample__.test.ts')).toEqual([])
  })

  it('refuses Math.random and Date.now in src/ (SPEC §3.3)', async () => {
    const code = 'export const a = Math.random()\nexport const b = Date.now()\n'
    const errors = await lintSample(code, 'src/__sample__.ts')
    expect(errors.filter((id) => id === 'no-restricted-properties' || id === 'no-restricted-globals').length).toBeGreaterThanOrEqual(2)
  })
})

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

describe('src/ files import the engine type-only (ADR-014 §1.1)', () => {
  const files = tsFiles(srcDir)

  it('src/ has the contract and the public entry', () => {
    const names = files.map((f) => relative(srcDir, f))
    expect(names).toContain('types.ts')
    expect(names).toContain('index.ts')
  })

  it.each(files.map((f) => [relative(pkgDir, f), f]))('%s: every engine import/export is type-only', (_name, file) => {
    const source = readFileSync(file, 'utf8')
    // Each import/export statement whose specifier is the engine (possibly multi-line; the class
    // excludes quotes, so a match never spans an earlier statement's specifier).
    const statements = source.match(/^\s*(import|export)\b[^'";]*?\bfrom\s*['"]@whodeployed\/engine[^'"]*['"]/gm) ?? []
    for (const statement of statements) {
      expect(statement.trim()).toMatch(/^(import|export)\s+type\s/)
    }
    expect(source).not.toMatch(/^\s*import\s+['"]@whodeployed\/engine/m)
    expect(source).not.toMatch(/(import|require)\s*\(\s*['"]@whodeployed\/engine/)
  })

  it('ESLint passes on the real src/', async () => {
    const results = await eslint.lintFiles(['src'])
    const errors = results.flatMap((r) => r.messages.map((m) => `${relative(pkgDir, r.filePath)}: ${m.ruleId} ${m.message}`))
    expect(errors).toEqual([])
  })
})
