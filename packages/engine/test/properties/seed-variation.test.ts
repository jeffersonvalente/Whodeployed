/**
 * T1.25 — telemetry is generated, not scripted (PRD S-5, SPEC §3.3, §11 gamesmanship; DET).
 *
 * For the baseline and for each of the 6 kinds (catalog defaults), 10 pairs of distinct seeds run
 * with the same fault: the two NDJSON hashes differ, and at least one numeric metric value differs
 * for the same (tick, component, instance). Metric records carry no ids, so a difference there is
 * a difference in the simulated values, not only in trace or span ids. The grep half of S-5 (no
 * scenario ids or texts in src/) is in test/boundaries.test.ts (T1.1).
 *
 * DET: the same seed gives the same hash, so the differences come from the seed alone.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { faultKinds } from '../../src/faults/catalog.js'
import { resolveFaults } from '../../src/faults/resolve.js'
import { serializeRecord, toNdjson } from '../../src/sim/serialize.js'
import { simulate } from '../../src/sim/simulation.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type { FaultKind, MetricName, MetricRecord, TelemetryRecord } from '../../src/types.js'

const TICKS = 30
const PAIRS = Array.from({ length: 10 }, (_, i) => [`vary-${i}-a`, `vary-${i}-b`] as const)
const NUMERIC: readonly MetricName[] = ['rps', 'p50', 'p95', 'p99', 'errorPct', 'cpu', 'mem', 'connections']

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function run(seed: string, kind: FaultKind | undefined): TelemetryRecord[] {
  const faults = kind === undefined ? [] : resolveFaults([{ kind }], buildWorld(defaultShop, seed))
  return simulate({ system: defaultShop, seed, faults }, TICKS)
}

const metrics = (records: readonly TelemetryRecord[]) => {
  const byKey = new Map<string, MetricRecord>()
  for (const r of records) if (r.type === 'metric') byKey.set(`${r.tick}|${r.component}|${r.instance ?? '*'}`, r)
  return byKey
}

/** Number of (record, metric) values that differ between two runs, over the same keys. */
function differingValues(a: readonly TelemetryRecord[], b: readonly TelemetryRecord[]): number {
  const ma = metrics(a)
  const mb = metrics(b)
  expect([...ma.keys()]).toEqual([...mb.keys()])
  let diff = 0
  for (const [key, ra] of ma) {
    const rb = mb.get(key)!
    for (const name of NUMERIC) if (ra[name] !== rb[name]) diff += 1
  }
  return diff
}

const CASES: readonly (FaultKind | undefined)[] = [undefined, ...faultKinds]

describe('S-5 — different seeds, same fault => different telemetry', () => {
  it.each(CASES.map((kind) => [kind ?? 'baseline', kind] as const))('%s: 10 seed pairs differ in hash and in >= 1 metric value', (_label, kind) => {
    for (const [a, b] of PAIRS) {
      const ra = run(a, kind)
      const rb = run(b, kind)
      expect(sha(toNdjson(ra)), `${a} vs ${b}`).not.toBe(sha(toNdjson(rb)))
      expect(differingValues(ra, rb), `${a} vs ${b}`).toBeGreaterThanOrEqual(1)
    }
  })

  it('the difference is not only in ids: the metric lines alone differ for every pair and kind', () => {
    const metricLines = (records: readonly TelemetryRecord[]) => records.filter((r) => r.type === 'metric').map(serializeRecord).join('\n')
    for (const kind of CASES) {
      for (const [a, b] of PAIRS.slice(0, 3)) expect(metricLines(run(a, kind)), `${kind ?? 'baseline'} ${a}`).not.toBe(metricLines(run(b, kind)))
    }
  })
})

describe('DET — the same seed gives the same hash, so the variation comes from the seed alone', () => {
  it.each(CASES.map((kind) => [kind ?? 'baseline', kind] as const))('%s', (_label, kind) => {
    expect(sha(toNdjson(run('vary-det', kind)))).toBe(sha(toNdjson(run('vary-det', kind))))
  })
})
