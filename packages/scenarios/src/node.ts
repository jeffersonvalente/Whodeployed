/**
 * Node-only entry ("./node", ADR-014 §4 and Emenda 1): the YAML loader (parseScenario) and the
 * helpers that read scenario YAML files from disk. Used by this package's tests and scripts and by
 * the Node scripts of apps/web; never re-exported from "." so the browser bundle has neither
 * node:fs nor the `yaml` library ("the UI does not know YAML", SPEC §6, PR-19).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ScenarioError } from './errors.js'
import { parseScenario } from './load.js'
import type { EngineRuntime, Scenario } from './types.js'

export { parseScenario }

/** Reads and parses one YAML file. `path` is used as the `file` of any ScenarioError. */
export function loadScenarioFile(path: string, engine: EngineRuntime): Scenario {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ScenarioError({ file: path, field: '', reason: `cannot read file: ${reason}` })
  }
  return parseScenario(source, path, engine)
}

/**
 * Loads every `*.yaml` / `*.yml` file of `dir` (not recursive), skipping names that start with
 * "_" (such as _TEMPLATE.yaml). Files are read in code-unit order of their names, so the result is
 * deterministic. Two files with the same `id` are a ScenarioError on the second one.
 */
export function loadScenarioDir(dir: string, engine: EngineRuntime): Scenario[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name) && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort()
  const seen = new Map<string, string>()
  return names.map((name) => {
    const file = join(dir, name)
    const scenario = loadScenarioFile(file, engine)
    const other = seen.get(scenario.id)
    if (other !== undefined) throw new ScenarioError({ file, field: 'id', reason: `duplicate id '${scenario.id}' (also in ${other})` })
    seen.set(scenario.id, file)
    return scenario
  })
}
