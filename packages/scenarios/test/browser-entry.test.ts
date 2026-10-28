// ADR-014 Emenda 1 (SPEC §6 "the UI does not know YAML", FASE-2 PR-19): the "." entry is
// browser-safe. Every module reachable from src/index.ts through value imports/exports is a
// relative module of this package: no `yaml`, no `node:*`, no other package (the engine is
// type-only, ADR-014 §1.1). The YAML loader lives in "./node". The artifact-level check (the web
// bundle has no YAML library) is apps/web/test/bundle.test.ts.
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as browserEntry from '../src/index.js'
import * as nodeEntry from '../src/node.js'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Module specifiers that load code at runtime (type-only imports and exports are skipped). */
function valueSpecifiers(text: string): string[] {
  const found: string[] = []
  const fromClause = /\b(import|export)\s+(type\s+)?([^'"`;]*?)\sfrom\s*['"]([^'"]+)['"]/g
  for (const match of text.matchAll(fromClause)) {
    if (match[2] === undefined) found.push(match[4] as string)
  }
  for (const match of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) found.push(match[1] as string)
  for (const match of text.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) found.push(match[1] as string)
  return found
}

/** Walks the value-import graph from one src/ file; returns every module reached and every non-relative specifier. */
function graph(entry: string): { modules: string[]; external: string[] } {
  const modules = new Set<string>()
  const external = new Set<string>()
  const visit = (file: string): void => {
    if (modules.has(file)) return
    modules.add(file)
    for (const spec of valueSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('./') || spec.startsWith('../')) visit(join(dirname(file), spec.replace(/\.js$/, '.ts')))
      else external.add(spec)
    }
  }
  visit(join(srcDir, entry))
  return {
    modules: [...modules].map((file) => relative(srcDir, file)).sort(),
    external: [...external].sort(),
  }
}

describe('"." entry is browser-safe (ADR-014 Emenda 1)', () => {
  it('reaches only relative modules: no yaml, no node:*, no package', () => {
    expect(graph('index.ts').external).toEqual([])
  })

  it('does not reach the YAML loader nor the file helpers', () => {
    const { modules } = graph('index.ts')
    expect(modules).not.toContain('load.ts')
    expect(modules).not.toContain('node.ts')
  })

  it('the walker is not vacuous: from "./node" it finds yaml and node:fs', () => {
    const { modules, external } = graph('node.ts')
    expect(modules).toContain('load.ts')
    expect(external).toEqual(expect.arrayContaining(['yaml', 'node:fs']))
  })

  it('parseScenario is exported by "./node" and not by "."', () => {
    expect(typeof nodeEntry.parseScenario).toBe('function')
    expect(Object.keys(browserEntry)).not.toContain('parseScenario')
    expect(typeof browserEntry.toSimulationConfig).toBe('function')
  })
})
