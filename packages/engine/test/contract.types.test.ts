/**
 * CT-1 / F-1: the public contract has exactly the shape of SPEC §6.
 *
 * The `Spec*` types below are a literal copy of the "Contrato central do motor" block of
 * SPEC.md §6. Type assertions are checked by `tsc --noEmit` (the `typecheck` script, which
 * includes test/); the runtime part runs under Vitest.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  Action,
  Answer,
  Dependency,
  Fault,
  FaultKind,
  Question,
  Service,
  Signal,
  World,
} from '../src/index.js'
import { faultCatalog, faultKinds } from '../src/index.js'
import { questionRegistry } from '../src/questions/registry.js'

// --- Literal copy of SPEC §6 -------------------------------------------------------------
interface SpecWorld { services: Service[]; deps: Dependency[]; tick: number; seed: string }
interface SpecFault { kind: FaultKind; target: string; startTick: number; params: Record<string, number> }
type SpecQuestion =
  | { kind: 'dashboard'; service: string }
  | { kind: 'logs'; service: string; window: number; filter?: Record<string, string> }
  | { kind: 'trace'; service: string; percentile: 50 | 95 | 99 }
  | { kind: 'whatChanged'; window: number }
  | { kind: 'compare'; service: string; metric: string; by: 'instance' | 'lastWeek' }
  | { kind: 'askNpc'; role: 'dev' | 'dba' | 'oncall' }
interface SpecAnswer { question: Question; data: Signal; tickCost: number }
type SpecAction = { kind: 'restart' | 'rollback' | 'flagOff' | 'scale' | 'escalate' | 'declareMitigated'; target?: string }
// -----------------------------------------------------------------------------------------

type SpecFaultKind =
  | 'service_crash_loop'
  | 'disk_full'
  | 'connection_pool_exhaustion'
  | 'bad_deploy'
  | 'slow_dependency'
  | 'cache_cold_start'

describe('contract (CT-1)', () => {
  it('World, Fault, Question, Answer and Action match SPEC §6 exactly', () => {
    expectTypeOf<World>().toEqualTypeOf<SpecWorld>()
    expectTypeOf<Fault>().toEqualTypeOf<SpecFault>()
    expectTypeOf<Question>().toEqualTypeOf<SpecQuestion>()
    expectTypeOf<Answer>().toEqualTypeOf<SpecAnswer>()
    expectTypeOf<Action>().toEqualTypeOf<SpecAction>()
  })

  it('Question and Action unions have the 6 kinds of SPEC §6', () => {
    expectTypeOf<Question['kind']>().toEqualTypeOf<
      'dashboard' | 'logs' | 'trace' | 'whatChanged' | 'compare' | 'askNpc'
    >()
    expectTypeOf<Action['kind']>().toEqualTypeOf<
      'restart' | 'rollback' | 'flagOff' | 'scale' | 'escalate' | 'declareMitigated'
    >()
  })

  it('every Question kind has a registered handler (Q-1 base, ADR-002 §2)', () => {
    const kinds: readonly Question['kind'][] = ['dashboard', 'logs', 'trace', 'whatChanged', 'compare', 'askNpc']
    expect(Object.keys(questionRegistry).sort()).toEqual([...kinds].sort())
    for (const kind of kinds) expect(typeof questionRegistry[kind]).toBe('function')
  })

  it('Signal is exported and covers one signal per question kind', () => {
    expectTypeOf<Signal['kind']>().toEqualTypeOf<Question['kind']>()
  })
})

describe('FaultKind (F-1)', () => {
  it('is a union of exactly the 6 literals of ADR-004, including connection_pool_exhaustion', () => {
    expectTypeOf<FaultKind>().toEqualTypeOf<SpecFaultKind>()
    expectTypeOf<'connection_pool_exhaustion'>().toMatchTypeOf<FaultKind>()
  })

  it('has 6 runtime members, mirrored by the catalog', () => {
    expect(faultKinds).toHaveLength(6)
    expect(new Set(faultKinds).size).toBe(6)
    expect(faultKinds).toContain('connection_pool_exhaustion')
    expect(Object.keys(faultCatalog).sort()).toEqual([...faultKinds].sort())
  })
})
