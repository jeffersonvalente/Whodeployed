#!/usr/bin/env node
// CN-8 (PRD FASE-2), SPEC §3.7 "content is data", ADR-014 §2: no scenario string lives in code.
//
// Reads every scenario YAML in packages/scenarios/scenarios/ (files starting with "_", such as
// _TEMPLATE.yaml, are skipped, like the loader does) and looks for each `id`, `title`,
// `alert.text`, `rootCause` and `teaches` as a fixed string (grep -F semantics) in
// packages/engine/src and apps/web/src.
//
// Exit 0: no occurrence. Exit 1: occurrences, one line per file and string. Exit 2: a scenario
// file or a tree could not be read, or a field could not be extracted (fail closed: an
// unreadable field never passes silently).
//
// The five fields are read with a small scalar extractor instead of a YAML library: the
// package has no YAML dependency yet (the loader arrives in T2.10) and the check needs only
// five scalars. Forms it does not understand are an error, never a skip.
//
// Usage: node packages/scenarios/scripts/check-not-in-code.mjs [--scenarios DIR] [--tree DIR]...
//   --scenarios  directory with the scenario YAML files (default: packages/scenarios/scenarios)
//   --tree       directory to search; repeatable (default: packages/engine/src and apps/web/src)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// --- scalar extraction ----------------------------------------------------------------------

/** Parses one single-line YAML scalar (value part after "key:"). */
function parseInlineScalar(raw, where) {
  const text = raw.trim()
  if (text === '') throw new CheckError(`${where}: empty value`)
  const first = text[0]
  if (first === '"') {
    // Double-quoted: find the closing quote that is not escaped.
    let end = 1
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
    if (end >= text.length) throw new CheckError(`${where}: double-quoted value must close on the same line`)
    assertOnlyComment(text.slice(end + 1), where)
    try {
      return JSON.parse(text.slice(0, end + 1))
    } catch {
      throw new CheckError(`${where}: unsupported escape in double-quoted value`)
    }
  }
  if (first === "'") {
    let out = ''
    let i = 1
    for (;;) {
      if (i >= text.length) throw new CheckError(`${where}: single-quoted value must close on the same line`)
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          out += "'"
          i += 2
          continue
        }
        break
      }
      out += text[i]
      i++
    }
    assertOnlyComment(text.slice(i + 1), where)
    return out
  }
  if ('&*!{[@`%'.includes(first)) {
    throw new CheckError(`${where}: unsupported YAML form "${first}..." (use a plain, quoted or block scalar)`)
  }
  // Plain scalar: a " #" starts a comment.
  const comment = text.search(/\s#/)
  return (comment === -1 ? text : text.slice(0, comment)).trim()
}

/** Value part without a trailing comment, for headers ("|", ">", "{...}", ""). */
function stripComment(raw) {
  const text = raw.trim()
  return text.startsWith('#') ? '' : text.replace(/\s+#.*$/, '')
}

function assertOnlyComment(rest, where) {
  const r = rest.trim()
  if (r !== '' && !r.startsWith('#')) throw new CheckError(`${where}: unexpected text after the quoted value`)
}

/**
 * Reads a scalar that starts at lines[index] (value part `raw`) and may continue on the following
 * lines (block scalar "|" / ">", or a plain/quoted scalar folded onto indented lines, which is
 * refused). Returns the value.
 */
function readScalar(lines, index, raw, parentIndent, where) {
  const header = stripComment(raw)
  const block = /^([|>])([+-]?)([1-9]?)([+-]?)$/.exec(header)
  const continuation = []
  for (let j = index + 1; j < lines.length; j++) {
    const line = lines[j]
    if (line.trim() === '') {
      continuation.push('')
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= parentIndent) break
    continuation.push(line)
  }
  while (continuation.length > 0 && continuation[continuation.length - 1] === '') continuation.pop()

  if (block === null) {
    if (header === '') throw new CheckError(`${where}: empty value (or a value on the next lines, not supported)`)
    if (continuation.some((l) => l !== '' && !l.trim().startsWith('#'))) {
      throw new CheckError(`${where}: multi-line plain or quoted value is not supported (use one line or a "|" / ">" block)`)
    }
    return parseInlineScalar(raw, where)
  }
  const body = continuation
  if (body.length === 0) throw new CheckError(`${where}: empty block scalar`)
  const indents = body.filter((l) => l !== '').map((l) => l.length - l.trimStart().length)
  const cut = Math.min(...indents)
  const stripped = body.map((l) => l.slice(cut))
  if (block[1] === '|') return stripped.join('\n')
  // ">" folding: lines of a paragraph join with a space; an empty line is a newline.
  let out = ''
  for (let k = 0; k < stripped.length; k++) {
    const l = stripped[k]
    if (l === '') out += '\n'
    else out += (out === '' || out.endsWith('\n') ? '' : ' ') + l
  }
  return out
}

/** Extracts the CN-8 fields of one scenario file. Throws CheckError naming file and field. */
export function extractFields(file, source) {
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const top = new Map()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^(---|\.\.\.)\s*(#.*)?$/.test(line)) continue
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:(?:\s(.*))?$/.exec(line)
    if (m === null) continue
    const key = m[1]
    if (top.has(key)) throw new CheckError(`${file}: field "${key}": duplicate key`)
    top.set(key, { index: i, raw: m[2] ?? '' })
  }

  const values = {}
  for (const field of FIELDS) {
    const where = `${file}: field "${field}"`
    if (field === 'alert.text') {
      const alert = top.get('alert')
      if (alert === undefined) throw new CheckError(`${where}: missing`)
      values[field] = readAlertText(lines, alert, where)
      continue
    }
    const entry = top.get(field)
    if (entry === undefined) throw new CheckError(`${where}: missing`)
    values[field] = readScalar(lines, entry.index, entry.raw, 0, where)
  }
  return values
}

function readAlertText(lines, alert, where) {
  const inline = stripComment(alert.raw)
  if (inline.startsWith('{')) {
    // Flow mapping on one line: { tick: 18, text: "..." }
    const m = /(?:^\{|,)\s*text\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(?:,|\})/.exec(inline)
    if (m === null || !inline.endsWith('}')) {
      throw new CheckError(`${where}: in a flow mapping, text must be a quoted string on the same line`)
    }
    return parseInlineScalar(m[1], where)
  }
  if (inline !== '') throw new CheckError(`${where}: alert must be a mapping`)
  let indent = -1
  for (let j = alert.index + 1; j < lines.length; j++) {
    const line = lines[j]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent === 0) break
    if (indent === -1) indent = lineIndent
    if (lineIndent !== indent) continue
    const m = /^\s+text\s*:(?:\s(.*))?$/.exec(line)
    if (m !== null) return readScalar(lines, j, m[1] ?? '', indent, where)
  }
  throw new CheckError(`${where}: missing`)
}

// --- search ---------------------------------------------------------------------------------

/** The value as written in a file, plus the forms a JS/TS string literal would give it. */
function needles(value) {
  const forms = new Set([value])
  const json = JSON.stringify(value).slice(1, -1)
  forms.add(json)
  forms.add(value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))
  forms.add(json.replace(/'/g, "\\'"))
  forms.delete('')
  return [...forms]
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
    for (const field of FIELDS) strings.push({ file: display(path), field, value: values[field] })
  }

  const hits = []
  for (const tree of trees) {
    if (!existsSync(tree) || !statSync(tree).isDirectory()) throw new CheckError(`tree not found: ${display(tree)}`)
    for (const path of listFiles(tree)) {
      const content = readFileSync(path, 'utf8')
      for (const s of strings) {
        if (needles(s.value).some((n) => content.includes(n))) hits.push({ path: display(path), ...s })
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
      console.error(`${h.path}: scenario ${h.field} "${h.value}" (from ${h.file})`)
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
