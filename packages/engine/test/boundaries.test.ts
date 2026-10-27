/**
 * Boundary tests (ADR-008), complementing the lint rules:
 *   CT-3  library files (src/ except src/cli/) import only relative modules;
 *         the CLI imports only the library, node:util and node:process (D-5, ADR-007);
 *   D-4   no non-deterministic source anywhere in src/;
 *   S-5   no scenario ids or titles in src/;
 *   Q-1   no player-level concept in src/;
 *   I24-4 the graph of relative value imports of src/ (import type excluded) has no cycle
 *         (ADR-002 Emenda 2 §2.4).
 * It also proves the ESLint config rejects Math.random in src/ with a sample file (D-4), and
 * that the library tsconfig has no @types/node (SPEC §3.6, ADR-008) by compiling samples.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const srcDir = join(pkgDir, 'src')

function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? listFiles(path) : [path]
    })
}

const sources = listFiles(srcDir)
  .filter((path) => /\.(ts|js|mjs|cjs)$/.test(path))
  .map((path) => ({
    path: relative(pkgDir, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  }))
const isCli = (path: string) => path.startsWith('src/cli/')
const library = sources.filter((s) => !isCli(s.path))
const cli = sources.filter((s) => isCli(s.path))

/** Every module specifier: static import/export ... from, side-effect import, import(), require(). */
function specifiers(text: string): string[] {
  const found: string[] = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1] as string)
  }
  return found
}

const isRelative = (spec: string) => spec.startsWith('./') || spec.startsWith('../')

/** Lines of `text` matching `pattern`, as "path:line: content". */
function grep(files: readonly { path: string; text: string }[], pattern: RegExp): string[] {
  return files.flatMap(({ path, text }) =>
    text.split('\n').flatMap((line, i) => (pattern.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
  )
}

describe('library boundary (CT-3)', () => {
  it('finds the library sources', () => {
    expect(library.map((s) => s.path)).toContain('src/index.ts')
    expect(library.map((s) => s.path)).toContain('src/types.ts')
  })

  it('library files import only relative modules', () => {
    const offending = library.flatMap(({ path, text }) =>
      specifiers(text)
        .filter((spec) => !isRelative(spec))
        .map((spec) => `${path}: ${spec}`),
    )
    expect(offending).toEqual([])
  })

  it('library files reach types.ts only through type-only imports', () => {
    const valueImports = grep(library, /^\s*(?:import|export)\s+(?!type\b)[^;]*from\s*['"][./]+(?:\.\.\/)*types\.js['"]/)
    expect(valueImports).toEqual([])
  })

  it('CLI files import only the library, node:util and node:process (D-5)', () => {
    const allowed = new Set(['node:util', 'node:process'])
    const offending = cli.flatMap(({ path, text }) =>
      specifiers(text)
        .filter((spec) => !isRelative(spec) && !allowed.has(spec))
        .map((spec) => `${path}: ${spec}`),
    )
    expect(offending).toEqual([])
  })

  it('the import scanner recognises every import form', () => {
    const sample = [
      "import { a } from 'node:fs'",
      "import type { B } from './types.js'",
      "export { c } from '../c.js'",
      "import 'side-effect'",
      "const d = await import('node:net')",
      "const e = require('http')",
    ].join('\n')
    expect(specifiers(sample).sort()).toEqual(
      ['../c.js', './types.js', 'http', 'node:fs', 'node:net', 'side-effect'].sort(),
    )
  })
})

/**
 * Relative specifiers that load a module at runtime, read from the TypeScript AST: static
 * imports and re-exports except `import type` / `export type` (erased under
 * verbatimModuleSyntax), plus side-effect imports and `import()`. `import { a, type B }` still
 * loads the module, so it counts.
 */
function valueSpecifiers(text: string): string[] {
  const file = ts.createSourceFile('sample.ts', text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.importClause?.isTypeOnly !== true) found.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) found.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found.filter(isRelative)
}

/** Package-relative path ('src/a/b.ts') of a relative specifier ('../b.js') seen from `from`. */
function resolveSpecifier(from: string, spec: string): string {
  return normalize(join(dirname(from), spec)).split(sep).join('/').replace(/\.js$/, '.ts')
}

/** Every import cycle in `files` (relative value imports only), each as a closed path. */
function importCycles(files: readonly { path: string; text: string }[]): string[][] {
  const known = new Set(files.map((f) => f.path))
  const edges = new Map(
    files.map(({ path, text }) => [
      path,
      [...new Set(valueSpecifiers(text).map((spec) => resolveSpecifier(path, spec)))].filter((to) => known.has(to)).sort(),
    ]),
  )
  const cycles: string[][] = []
  const state = new Map<string, 'open' | 'done'>()
  const stack: string[] = []
  const visit = (node: string): void => {
    state.set(node, 'open')
    stack.push(node)
    for (const next of edges.get(node) ?? []) {
      const s = state.get(next)
      if (s === 'open') cycles.push([...stack.slice(stack.indexOf(next)), next])
      else if (s === undefined) visit(next)
    }
    stack.pop()
    state.set(node, 'done')
  }
  for (const path of [...known].sort()) if (!state.has(path)) visit(path)
  return cycles
}

describe('import graph (I24-4, ADR-002 Emenda 2 §2.4)', () => {
  it('src/ has no cycle of relative value imports', () => {
    expect(importCycles(sources)).toEqual([])
  })

  it('questions/ask.ts does not import sim/simulation.ts', () => {
    const ask = sources.find((s) => s.path === 'src/questions/ask.ts')
    expect(ask).toBeDefined()
    expect(valueSpecifiers(ask!.text).map((spec) => resolveSpecifier(ask!.path, spec))).not.toContain(
      'src/sim/simulation.ts',
    )
  })

  it('detects a cycle in sample files, through .js specifiers and a mixed import', () => {
    const sample = [
      { path: 'src/sim/a.ts', text: "import { b } from '../questions/b.js'\nexport const a = b\n" },
      { path: 'src/questions/b.ts', text: "import { c, type C } from './c.js'\nexport const b: C = c\n" },
      { path: 'src/questions/c.ts', text: "export type C = number\nexport { a as c } from '../sim/a.js'\n" },
    ]
    expect(importCycles(sample)).toEqual([['src/questions/b.ts', 'src/questions/c.ts', 'src/sim/a.ts', 'src/questions/b.ts']])
  })

  it('would catch the phase-1 cycle: ask.ts importing sim/simulation.ts again', () => {
    const reverted = sources.map((f) =>
      f.path === 'src/questions/ask.ts' ? { ...f, text: `import { createSimulation } from '../sim/simulation.js'\n${f.text}` } : f,
    )
    const cycles = importCycles(reverted)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toEqual(expect.arrayContaining(['src/questions/ask.ts', 'src/sim/simulation.ts']))
  })

  it('ignores type-only imports and exports when looking for cycles', () => {
    const sample = [
      { path: 'src/a.ts', text: "import type { B } from './b.js'\nexport const a = 1\nexport type A = B\n" },
      { path: 'src/b.ts', text: "export type { A } from './a.js'\nimport { a } from './a.js'\nexport type B = typeof a\n" },
      { path: 'src/c.ts', text: "import type { A } from './a.js'\nimport './b.js'\nexport type C = A\n" },
    ]
    expect(importCycles(sample)).toEqual([])
    // The same pair with a value import in a.ts is a cycle.
    const asValue = sample.map((f) => (f.path === 'src/a.ts' ? { ...f, text: f.text.replace('import type', 'import') } : f))
    expect(importCycles(asValue)).toEqual([['src/a.ts', 'src/b.ts', 'src/a.ts']])
  })
})

describe('determinism and content greps', () => {
  it('D-4: no non-deterministic source in src/', () => {
    const pattern =
      /Math\.random|Date\.now|new Date\(|performance\.now|getRandomValues|randomUUID|process\.hrtime|toLocaleString|localeCompare|\bIntl\b|setTimeout|setInterval/
    expect(grep(sources, pattern)).toEqual([])
  })

  it('S-5: no scenario ids or titles in src/', () => {
    expect(grep(sources, /launch-day|0[1-8]-[a-z]/i)).toEqual([])
  })

  it('Q-1: no player-level concept in src/', () => {
    expect(grep(sources, /junior|pleno|senior|playerLevel/i)).toEqual([])
  })
})

describe('lint rules (D-4, CT-3, D-5)', () => {
  const eslint = new ESLint({ cwd: pkgDir })
  const ruleIds = async (code: string, filePath: string) => {
    const [result] = await eslint.lintText(code, { filePath: join(pkgDir, filePath) })
    return (result?.messages ?? []).map((m) => m.ruleId)
  }

  it('rejects Math.random in a library sample file', async () => {
    expect(await ruleIds('export const x = Math.random()\n', 'src/sim/__sample__.ts')).toContain(
      'no-restricted-properties',
    )
  })

  it('rejects Math.random in a CLI sample file', async () => {
    expect(await ruleIds('export const x = Math.random()\n', 'src/cli/__sample__.ts')).toContain(
      'no-restricted-properties',
    )
  })

  it('allows Math.random in test/', async () => {
    expect(await ruleIds('export const x = Math.random()\n', 'test/__sample__.test.ts')).toEqual([])
  })

  it('rejects clock and locale APIs in src/', async () => {
    const ids = await ruleIds(
      "export const a = Date.now()\nexport const b = new Date()\nexport const c = 'a'.localeCompare('b')\n",
      'src/sim/__sample__.ts',
    )
    expect([...ids].sort()).toEqual(
      ['no-restricted-globals', 'no-restricted-globals', 'no-restricted-properties', 'no-restricted-syntax'],
    )
  })

  it('rejects non-relative imports in the library', async () => {
    expect(await ruleIds("import { a } from 'node:fs'\nexport const b = a\n", 'src/sim/__sample__.ts')).toContain(
      'no-restricted-imports',
    )
  })

  it('lets the CLI import node:util and node:process but not node:fs', async () => {
    expect(
      await ruleIds("import { parseArgs } from 'node:util'\nimport process from 'node:process'\nexport { parseArgs, process }\n", 'src/cli/__sample__.ts'),
    ).toEqual([])
    expect(await ruleIds("import { a } from 'node:fs'\nexport const b = a\n", 'src/cli/__sample__.ts')).toContain(
      'no-restricted-imports',
    )
  })
})

describe('library compiler settings (SPEC §3.6, ADR-008)', () => {
  /** Type-checks one sample file with the compiler options of `tsconfigName`; returns error codes. */
  function compileSample(tsconfigName: string, code: string): number[] {
    const configPath = join(pkgDir, tsconfigName)
    const { config, error } = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path))
    if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, pkgDir, undefined, configPath)
    const dir = mkdtempSync(join(tmpdir(), 'engine-boundary-'))
    try {
      // ESM like the package itself (NodeNext + verbatimModuleSyntax).
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
      const file = join(dir, 'sample.ts')
      writeFileSync(file, code)
      const program = ts.createProgram([file], { ...parsed.options, noEmit: true, typeRoots: [join(pkgDir, 'node_modules', '@types')] })
      return ts.getPreEmitDiagnostics(program).map((d) => d.code)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const nodeOnly = 'export const dir: string = __dirname\nexport function f(cb: () => void): void { setImmediate(cb) }\n'

  it('library config (typecheck and build) does not load @types/node', () => {
    for (const name of ['tsconfig.json', 'tsconfig.build.json']) {
      const raw = JSON.parse(readFileSync(join(pkgDir, name), 'utf8')) as { compilerOptions?: { types?: unknown; lib?: unknown } }
      expect(raw.compilerOptions?.types ?? [], name).toEqual([])
      expect(JSON.stringify(raw.compilerOptions?.lib ?? []), name).not.toMatch(/dom/i)
    }
  })

  it('rejects Node-only globals under the library config', () => {
    expect(compileSample('tsconfig.json', nodeOnly)).toContain(2304) // Cannot find name
    expect(compileSample('tsconfig.build.json', nodeOnly)).toContain(2304)
  })

  it('accepts plain ES2022 under the library config', () => {
    expect(compileSample('tsconfig.json', 'export const x: number = Math.max(1, 2)\n')).toEqual([])
  })

  it('keeps @types/node available to the node-side config (CLI, tests, scripts)', () => {
    expect(compileSample('tsconfig.node.json', nodeOnly)).toEqual([])
  })
})
