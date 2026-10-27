/**
 * Impact function (ADR-013 §1–2; PRD FASE-2 EN-6).
 *
 * Impact is measured where users meet the system: the trace roots of the services that have
 * `ingress`. For a tick t and each entry service E:
 *
 *   expected(E, t) = E.ingress.ratePerTick                       (world data, not scenario data)
 *   roots(E, t)    = server spans of E without parentId that started in t   (ADR-005)
 *   lost(E, t)     = max(0, expected(E, t) − |roots(E, t)|)      (lost at the edge)
 *   bad(E, t)      = lost(E, t) + roots with status 'error' or durationMs > SLOW_MS
 *
 * The tick is impacted when Σ bad / Σ expected >= THETA. A world without ingress expects nothing
 * and is never impacted. The accumulated impact up to u is the number of impacted ticks in [0, u],
 * the same unit as `impactBudget` (ticks, SPEC §7).
 *
 * Pure: reads only `view.world` and `view.spansOf`. It knows nothing about scenarios, faults,
 * noise or levels (EN-6, SPEC §3.3) and uses no randomness or clock (D-4).
 */
import { EngineError } from '../errors.js'
import type { AccumulatedImpact, ImpactOfTick, ImpactTick, TelemetryView } from '../types.js'

/** A root slower than this (ms) is a bad request (ADR-013 §1; calibrated in Emenda 1). */
export const SLOW_MS = 1000

/** Share of bad expected requests from which a tick is impacted (ADR-013 §1; Emenda 1). */
export const THETA = 0.05

function assertTickInView(view: TelemetryView, tick: unknown, field: string): asserts tick is number {
  if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0 || tick > view.now) {
    throw new EngineError({
      code: 'invalid_ticks',
      field,
      received: tick,
      validValues: [`0..${view.now}`],
      message: `${field} must be an integer in 0..${view.now} (the simulated ticks)`,
    })
  }
}

function impactOf(view: TelemetryView, tick: number): ImpactTick {
  let expected = 0
  let bad = 0
  for (const service of view.world.services) {
    if (service.ingress === undefined) continue
    const rate = service.ingress.ratePerTick
    let roots = 0
    let badRoots = 0
    for (const span of view.spansOf(service.name, tick)) {
      if (span.parentId !== undefined || span.kind !== 'server') continue
      roots += 1
      if (span.status === 'error' || span.durationMs > SLOW_MS) badRoots += 1
    }
    expected += rate
    bad += Math.max(0, rate - roots) + badRoots
  }
  const impacted = expected > 0 && bad / expected >= THETA
  return { tick, expected, bad, impacted }
}

export const impactOfTick: ImpactOfTick = (view, tick) => {
  assertTickInView(view, tick, 'tick')
  return impactOf(view, tick)
}

export const accumulatedImpact: AccumulatedImpact = (view, upTo) => {
  assertTickInView(view, upTo, 'upTo')
  let count = 0
  for (let t = 0; t <= upTo; t += 1) {
    if (impactOf(view, t).impacted) count += 1
  }
  return count
}
