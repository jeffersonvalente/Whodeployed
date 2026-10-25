/**
 * CLI help text (ADR-007, PRD CLI-4).
 *
 * Generated from the fault catalog (ADR-004), so the defaults and ranges shown are exactly the
 * ones resolveFaults applies. Pure function of the topic (DET): no process, no I/O.
 */
import { faultCatalog, faultKinds } from '../faults/catalog.js'
import type { FaultCatalogEntry, FaultParamSpec } from '../types.js'
import { MAX_TICKS, MIN_TICKS, reservedFaultKeys } from './args.js'

export const BIN_NAME = 'whodeployed-engine'

export type HelpTopic = 'root' | 'simulate'

export function helpText(topic: HelpTopic): string {
  const lines: string[] = []
  if (topic === 'root') {
    lines.push(
      `${BIN_NAME}: deterministic simulator of a small distributed system that writes coherent`,
      'synthetic telemetry (metrics, logs, traces, events) as NDJSON.',
      '',
      'Usage:',
      `  ${BIN_NAME} simulate --seed <string> --ticks <int> [--fault <spec>]...`,
      `  ${BIN_NAME} --help`,
      `  ${BIN_NAME} simulate --help`,
      '',
      'Commands:',
      '  simulate   Simulate ticks [0, ticks) and write canonical NDJSON to stdout.',
      '',
    )
  } else {
    lines.push(
      `Usage: ${BIN_NAME} simulate --seed <string> --ticks <int> [--fault <spec>]...`,
      '',
      'Simulate ticks [0, ticks) and write canonical NDJSON telemetry to stdout',
      '(one record per line; redirect to save it). 1 tick = 10 s of game time.',
      '',
    )
  }
  lines.push(
    'Options:',
    '  --seed <string>   Required. Same seed and faults give byte-identical output.',
    `  --ticks <int>     Required. Number of ticks to simulate, integer in ${MIN_TICKS}..${MAX_TICKS}.`,
    '  --fault <spec>    Optional, repeatable. Inject a fault; repeat it for simultaneous faults.',
    '  -h, --help        Show this help.',
    '',
    'Fault spec:',
    '  <kind>[:<key>=<value>[,<key>=<value>]...]',
    `  Reserved keys: ${reservedFaultKeys.join(', ')} (target = component name, startTick = integer >= 0).`,
    '  Any other key is a numeric parameter of the kind; omitted fields take the defaults below.',
    '  Examples:',
    `    --fault connection_pool_exhaustion`,
    `    --fault 'connection_pool_exhaustion:target=cart,startTick=5,poolSize=10'`,
    `    --fault bad_deploy --fault slow_dependency:addedLatencyMs=800`,
    '',
    `Fault kinds (${faultKinds.length}):`,
  )
  for (const kind of faultKinds) lines.push(...kindLines(faultCatalog[kind]))
  return lines.join('\n') + '\n'
}

function kindLines(entry: FaultCatalogEntry): string[] {
  const lines = [
    `  ${entry.kind}`,
    `    ${entry.summary}`,
    `    target: ${entry.defaultTarget} (${entry.targetRule})   startTick: ${entry.defaultStartTick}`,
  ]
  const names = Object.keys(entry.params)
  const width = Math.max(...names.map((n) => n.length))
  for (const name of names) {
    const spec = entry.params[name] as FaultParamSpec
    lines.push(`    ${name.padEnd(width)}  ${paramSummary(spec)}`)
  }
  return lines
}

function paramSummary(spec: FaultParamSpec): string {
  const kind = spec.integer ? 'integer' : 'number'
  return `default ${spec.default}, ${kind} ${spec.min}..${spec.max} ${spec.unit}. ${spec.description}`
}
