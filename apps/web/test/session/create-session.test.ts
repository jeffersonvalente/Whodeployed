// @vitest-environment node
/**
 * `createSession` bound to the real rules of @whodeployed/scenarios (ADR-015 §5, ADR-014 Emenda 1;
 * FASE-2 PR-6). session.test.ts covers the core through `makeCreateSession` with injected rules;
 * this file only proves the binding: the single repertoire table (`inRepertoire`, T2.11) and the
 * real engine input (`toSimulationConfig`, T2.10) are the ones in use.
 */
import { repertoire, toSimulationConfig } from '@whodeployed/scenarios'
import { describe, expect, it } from 'vitest'
import { engineRuntime } from '../../src/engine-runtime'
import { isSessionError } from '../../src/session/errors'
import { createSession } from '../../src/session/session'
import type { SessionDeps } from '../../src/session/types'
import { juniorFixture, plenoFixture } from '../fixtures/scenarios'

const deps = (): SessionDeps => ({ engine: engineRuntime, wallClock: () => 0, engineVersion: '9.9.9-test', buildSha: 'unknown' })

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

describe('createSession uses the real scenarios rules', () => {
  it('starts from toSimulationConfig: same impact as an engine simulation of the same config', () => {
    const session = createSession(juniorFixture, deps())
    const sim = engineRuntime.createSimulation(toSimulationConfig(juniorFixture, engineRuntime))
    sim.advance(juniorFixture.alert.tick)
    expect(session.state.tick).toBe(juniorFixture.alert.tick)
    expect(session.state.impact).toBe(engineRuntime.accumulatedImpact(sim.telemetry(), sim.world.tick))
  })

  it('junior: logs with window 30 is accepted; trace is outside the junior repertoire', () => {
    expect(repertoire.junior.tracePercentiles).toEqual([])
    const session = createSession(juniorFixture, deps())
    session.ask({ kind: 'logs', service: 'catalog', window: 30 })
    const before = JSON.stringify(session.log())
    const error = thrown(() => session.ask({ kind: 'trace', service: 'catalog', percentile: 95 }))
    expect(isSessionError(error) && error.code).toBe('out_of_repertoire')
    expect(JSON.stringify(session.log())).toBe(before)
  })

  it('pleno: trace p95 and rollback are in the repertoire', () => {
    const session = createSession(plenoFixture, deps())
    session.ask({ kind: 'trace', service: 'cart', percentile: 95 })
    session.act({ kind: 'rollback', target: 'cart' })
    expect(session.state.steps.map((step) => step.type)).toEqual(['ask', 'act'])
  })
})
