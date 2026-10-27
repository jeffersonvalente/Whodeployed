#!/usr/bin/env node
// CN-8 (PRD FASE-2), SPEC §3.7 "content is data", ADR-014 §2: no scenario string lives in code.
//
// Reads every scenario YAML in packages/scenarios/scenarios/ (files starting with "_", such as
// _TEMPLATE.yaml, are skipped, like the loader does) and looks for each `id`, `title`,
// `alert.text`, `rootCause` and `teaches` as a fixed string (grep -F semantics) in
// packages/engine/src and apps/web/src.
//
// Exit 0: no occurrence. Exit 1: occurrences, one line per file and string. Exit 2: a scenario
// file or a tree could not be read, the YAML is invalid, or a field is missing, empty or not a
// string (fail closed: an unreadable field never passes silently).
//
// The YAML is parsed with the `yaml` library, the loader's parser (T2.10), so the value checked
// is exactly the value the game gets.
//
// Matching follows grep -F with the value as the pattern list: the whole value matches (with or
// without its trailing newline), and so does every non-empty line of a multi-line value
// (trimmed). Each pattern is also searched in the escaped forms a JS/TS string literal gives it.
//
// Usage: node packages/scenarios/scripts/check-not-in-code.mjs [--scenarios DIR] [--tree DIR]...
//   --scenarios  directory with the scenario YAML files (default: packages/scenarios/scenarios)
//   --tree       directory to search; repeatable (default: packages/engine/src and apps/web/src)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(scriptDir, '..')
const repoRoot = resolve(pkgDir, '..', '..')

const FIELDS = ['id', 'title', 'alert.text', 'rootCause', 'teaches']

class CheckError extends Error {}

function parseArgs(argv) {
  let scenarios = join(pkgDir, 'scenarios')
  const trees = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    if ((arg === '--scenarios' || arg === '--tree') && value !== undefined) {
      if (arg === '--scenarios') scenarios = resolve(value)
      else trees.push(resolve(value))
      i++
    } else {
      throw new CheckError(`unknown or incomplete argument "${arg}" (usage: [--scenarios DIR] [--tree DIR]...)`)
    }
  }
  if (trees.length === 0) trees.push(join(repoRoot, 'packages', 'engine', 'src'), join(repoRoot, 'apps', 'web', 'src'))
  return { scenarios, trees }
}

function display(path) {
  const rel = relative(process.cwd(), path)
  if (rel === '') return '.'
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

function firstLine(message) {
  return String(message).split('\n')[0]
}

// --- field extraction -----------------------------------------------------------------------

/** Extracts the CN-8 fields of one scenario file. Throws CheckError naming file and field. */
export function extractFields(file, source) {
  const doc = parseDocument(source)
  if (doc.errors.length > 0) throw new CheckError(`${file}: invalid YAML: ${firstLine(doc.errors[0].message)}`)
  let data
  try {
    data = doc.toJS()
  } catch (error) {
    throw new CheckError(`${file}: invalid YAML: ${firstLine(error instanceof Error ? error.message : error)}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new CheckError(`${file}: the document must be a mapping`)
  }
  const values = {}
  for (const field of FIELDS) {
    let value = data
    for (const key of field.split('.')) {
      value = value !== null && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined
    }
    if (value === undefined || value === null) throw new CheckError(`${file}: field "${field}": missing`)
    if (typeof value !== 'string') throw new CheckError(`${file}: field "${field}": must be a string`)
    if (value.trim() === '') throw new CheckError(`${file}: field "${field}": empty`)
    values[field] = value
  }
  return values
}

// --- search ---------------------------------------------------------------------------------

/** grep -F patterns for one value, each as written and as a JS/TS string literal would hold it. */
function needles(value) {
  const patterns = new Set([value, value.replace(/\n+$/, '')])
  if (value.includes('\n')) for (const line of value.split('\n')) patterns.add(line.trim())
  const out = []
  for (const p of patterns) {
    if (p.trim() === '') continue
    const json = JSON.stringify(p).slice(1, -1)
    const forms = new Set([p, json, p.replace(/\\/g, '\\\\').replace(/'/g, "\\'"), json.replace(/'/g, "\\'")])
    for (const form of forms) out.push({ form, pattern: p })
  }
  return out
}

function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path))
    else if (entry.isFile()) out.push(path)
  }
  return out.sort()
}

export function check({ scenarios, trees }) {
  if (!existsSync(scenarios) || !statSync(scenarios).isDirectory()) {
    throw new CheckError(`scenarios directory not found: ${display(scenarios)}`)
  }
  const files = readdirSync(scenarios)
    .filter((name) => /\.ya?ml$/.test(name) && !name.startsWith('_'))
    .sort()
  const strings = []
  for (const name of files) {
    const path = join(scenarios, name)
    const values = extractFields(display(path), readFileSync(path, 'utf8'))
    for (const field of FIELDS) {
      strings.push({ file: display(path), field, value: values[field], needles: needles(values[field]) })
    }
  }

  const hits = []
  for (const tree of trees) {
    if (!existsSync(tree) || !statSync(tree).isDirectory()) throw new CheckError(`tree not found: ${display(tree)}`)
    for (const path of listFiles(tree)) {
      const content = readFileSync(path, 'utf8')
      for (const s of strings) {
        const match = s.needles.find((n) => content.includes(n.form))
        if (match !== undefined) {
          const line = match.pattern === s.value || match.pattern === s.value.replace(/\n+$/, '') ? undefined : match.pattern
          hits.push({ path: display(path), file: s.file, field: s.field, value: s.value, line })
        }
      }
    }
  }
  return { scenarioFiles: files.length, strings: strings.length, trees, hits }
}

function main() {
  let result
  try {
    result = check(parseArgs(process.argv.slice(2)))
  } catch (error) {
    if (error instanceof CheckError) {
      console.error(`check-not-in-code (CN-8): ${error.message}`)
      process.exit(2)
    }
    throw error
  }
  const scope = result.trees.map(display).join(', ')
  if (result.hits.length > 0) {
    for (const h of result.hits) {
      const line = h.line === undefined ? '' : ` [matched line ${JSON.stringify(h.line)}]`
      console.error(`${h.path}: scenario ${h.field} ${JSON.stringify(h.value)}${line} (from ${h.file})`)
    }
    console.error(
      `check-not-in-code (CN-8): ${result.hits.length} scenario string(s) found in code. ` +
        'Scenarios are YAML, never code (SPEC §3.7): read them from @whodeployed/scenarios/data.',
    )
    process.exit(1)
  }
  console.log(
    `check-not-in-code (CN-8): OK, ${result.strings} string(s) from ${result.scenarioFiles} scenario file(s), none in ${scope}.`,
  )
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
