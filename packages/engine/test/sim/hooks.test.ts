/**
 * T1.15 — composition and gating of FaultHooks (ADR-002 §3 "Gating", §4; ADR-003 §2; PRD F-2, F-6).
 */
import { describe, expect, it, vi } from 'vitest'
import { faultRegistry } from '../../src/faults/registry.js'
import {
  activateFaults,
  composeHooks,
  faultRngFactory,
  hooksActiveAt,
  mergeCallEffects,
  mergeResourceEffects,
  mergeServeEffects,
  mergeTickEffects,
} from '../../src/sim/hooks.js'
import { createRngFactory } from '../../src/sim/rng.js'
import { buildWorld } from '../../src/world/build.js'
import { defaultShop } from '../../src/world/default-shop.js'
import type {
  CallContext,
  Fault,
  FaultHooks,
  FaultModule,
  FaultRegistry,
  ResourceContext,
  RngFactory,
  ServeContext,
  TickContext,
} from '../../src/types.js'

const world = buildWorld(defaultShop, 'hooks')
const tickCtx: TickContext = { tick: 5, world }
const serveCtx: ServeContext = { tick: 5, component: 'payment', instance: 'payment-0', operation: 'payment.checkout', traceId: 't5r0' }
const callCtx: CallContext = {
  tick: 5,
  caller: 'payment',
  callerInstance: 'payment-0',
  target: 'postgres',
  operation: 'db.insert',
  attempt: 0,
  traceId: 't5r0',
}
const resCtx: ResourceContext = { tick: 5, component: 'payment', instance: 'payment-0' }

describe('composeHooks — presence', () => {
  it('no faults => no hooks at all', () => {
    expect(composeHooks([])).toEqual({})
  })

  it('a composed hook exists only when some fault defines it', () => {
    const composed = composeHooks([{ onServe: () => undefined }, {}])
    expect(Object.keys(composed)).toEqual(['onServe'])
  })

  it('a single fault passes its effect through unchanged', () => {
    const composed = composeHooks([{ onServe: () => ({ addLatencyMs: 7 }) }])
    expect(composed.onServe?.(serveCtx)).toEqual({ addLatencyMs: 7 })
  })

  it('returns undefined when every fault returns undefined', () => {
    const composed = composeHooks([
      { onTick: () => undefined, onServe: () => undefined, onCall: () => undefined, onResources: () => undefined },
      { onTick: () => undefined, onServe: () => undefined, onCall: () => undefined, onResources: () => undefined },
    ])
    expect(composed.onTick?.(tickCtx)).toBeUndefined()
    expect(composed.onServe?.(serveCtx)).toBeUndefined()
    expect(composed.onCall?.(callCtx)).toBeUndefined()
    expect(composed.onResources?.(resCtx)).toBeUndefined()
  })

  it('keeps `this` of each fault hooks object', () => {
    const hooks = {
      extra: 3,
      onServe(this: { extra: number }) {
        return { addLatencyMs: this.extra }
      },
    }
    expect(composeHooks([hooks as FaultHooks]).onServe?.(serveCtx)).toEqual({ addLatencyMs: 3 })
  })
})

describe('composeHooks — ADR-002 §4 rules', () => {
  it('onTick: down = union in first-occurrence order; events and logs concatenated in fault order', () => {
    const composed = composeHooks([
      {
        onTick: () => ({
          down: ['a-0', 'a-1'],
          events: [{ kind: 'deploy', target: 'a' }],
          logs: [{ component: 'a', instance: 'a-0', level: 'error', message: 'm1' }],
        }),
      },
      { onTick: () => ({ down: ['a-1', 'b-0'], events: [{ kind: 'config', target: 'b', restart: true }] }) },
      { onTick: () => ({ logs: [{ component: 'b', instance: 'b-0', level: 'warn', message: 'm2' }] }) },
    ])
    expect(composed.onTick?.(tickCtx)).toEqual({
      down: ['a-0', 'a-1', 'b-0'],
      events: [
        { kind: 'deploy', target: 'a' },
        { kind: 'config', target: 'b', restart: true },
      ],
      logs: [
        { component: 'a', instance: 'a-0', level: 'error', message: 'm1' },
        { component: 'b', instance: 'b-0', level: 'warn', message: 'm2' },
      ],
    })
  })

  it('onServe: addLatencyMs summed; fail = first that fails', () => {
    const composed = composeHooks([
      { onServe: () => ({ addLatencyMs: 10 }) },
      { onServe: () => ({ addLatencyMs: 5, fail: { message: 'first' } }) },
      { onServe: () => ({ fail: { message: 'second', attrs: { x: 1 } } }) },
    ])
    expect(composed.onServe?.(serveCtx)).toEqual({ addLatencyMs: 15, fail: { message: 'first' } })
  })

  it('onCall: waitMs summed, first waitOperation, forceCacheMiss = OR, first fail', () => {
    const composed = composeHooks([
      { onCall: () => ({ waitMs: 100, forceCacheMiss: false }) },
      { onCall: () => ({ waitMs: 50, waitOperation: 'db.acquire', fail: { message: 'pool' } }) },
      { onCall: () => ({ waitOperation: 'other', forceCacheMiss: true, fail: { message: 'later' } }) },
    ])
    expect(composed.onCall?.(callCtx)).toEqual({
      waitMs: 150,
      waitOperation: 'db.acquire',
      forceCacheMiss: true,
      fail: { message: 'pool' },
    })
  })

  it('onCall: forceCacheMiss stays false when every fault says false', () => {
    expect(mergeCallEffects([{ forceCacheMiss: false }, { forceCacheMiss: false }])).toEqual({ forceCacheMiss: false })
  })

  it('onResources: adds summed; connectionsCap = minimum', () => {
    const composed = composeHooks([
      { onResources: () => ({ cpuPctAdd: 10, connectionsAdd: 2, connectionsCap: 20 }) },
      { onResources: () => ({ cpuPctAdd: 5, memMbAdd: 64, connectionsCap: 12 }) },
      { onResources: () => ({ connectionsAdd: 3, connectionsCap: 15 }) },
    ])
    expect(composed.onResources?.(resCtx)).toEqual({ cpuPctAdd: 15, memMbAdd: 64, connectionsAdd: 5, connectionsCap: 12 })
  })

  it('fields absent from every partial effect stay absent', () => {
    expect(mergeTickEffects([{}, {}])).toEqual({})
    expect(mergeServeEffects([{}, {}])).toEqual({})
    expect(mergeCallEffects([{}])).toEqual({})
    expect(mergeResourceEffects([{}])).toEqual({})
    expect(mergeTickEffects([{ down: [] }])).toEqual({ down: [] })
  })

  it('an empty list of effects merges to undefined', () => {
    expect(mergeTickEffects([])).toBeUndefined()
    expect(mergeServeEffects([])).toBeUndefined()
    expect(mergeCallEffects([])).toBeUndefined()
    expect(mergeResourceEffects([])).toBeUndefined()
  })

  it('every fault hook is invoked even after an earlier fault already failed (independent streams)', () => {
    const second = vi.fn(() => ({ addLatencyMs: 1 }))
    const composed = composeHooks([{ onServe: () => ({ fail: { message: 'x' } }) }, { onServe: second }])
    composed.onServe?.(serveCtx)
    composed.onServe?.(serveCtx)
    expect(second).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledWith(serveCtx)
  })
})

describe('hooksActiveAt — gating by startTick (F-2)', () => {
  const late = { startTick: 10, hooks: { onServe: () => ({ addLatencyMs: 100 }) } }
  const early = { startTick: 0, hooks: { onServe: () => ({ addLatencyMs: 1 }) } }

  it('a fault is absent before its startTick and present from it on (inclusive)', () => {
    expect(hooksActiveAt([late], 9)).toEqual({})
    expect(hooksActiveAt([late], 10).onServe?.(serveCtx)).toEqual({ addLatencyMs: 100 })
    expect(hooksActiveAt([late], 11).onServe?.(serveCtx)).toEqual({ addLatencyMs: 100 })
  })

  it('composes only the active ones', () => {
    expect(hooksActiveAt([early, late], 5).onServe?.(serveCtx)).toEqual({ addLatencyMs: 1 })
    expect(hooksActiveAt([early, late], 10).onServe?.(serveCtx)).toEqual({ addLatencyMs: 101 })
  })

  it('an inactive fault is never called', () => {
    const spy = vi.fn(() => undefined)
    hooksActiveAt([{ startTick: 3, hooks: { onTick: spy } }], 2).onTick?.(tickCtx)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('faultRngFactory / activateFaults (ADR-003 §2)', () => {
  const root = createRngFactory('hooks')
  const seq = (f: RngFactory, ...key: (string | number)[]) => {
    const r = f(...key)
    return [r.next(), r.next(), r.next()]
  }

  it("prefixes every key with ('fault', index, kind)", () => {
    const f = faultRngFactory(root, 1, 'disk_full')
    expect(seq(f, 'pick')).toEqual(seq(root, 'fault', 1, 'disk_full', 'pick'))
    expect(seq(f, 4, 't4r0')).toEqual(seq(root, 'fault', 1, 'disk_full', 4, 't4r0'))
  })

  it('different indexes or kinds give different streams', () => {
    expect(seq(faultRngFactory(root, 0, 'disk_full'), 'pick')).not.toEqual(seq(faultRngFactory(root, 1, 'disk_full'), 'pick'))
    expect(seq(faultRngFactory(root, 0, 'disk_full'), 'pick')).not.toEqual(seq(faultRngFactory(root, 0, 'bad_deploy'), 'pick'))
  })

  it('activates each fault with its module, its world and its own prefixed factory, in list order', () => {
    const seen: { kind: string; target: string; draw: number }[] = []
    const fake = (kind: Fault['kind']): FaultModule => ({
      kind,
      activate: (fault, w, rng) => {
        expect(w).toBe(world)
        seen.push({ kind: fault.kind, target: fault.target, draw: rng('pick').next() })
        return { onTick: () => undefined }
      },
    })
    const registry = { ...faultRegistry, disk_full: fake('disk_full'), slow_dependency: fake('slow_dependency') } as FaultRegistry
    const faults: Fault[] = [
      { kind: 'slow_dependency', target: 'redis', startTick: 4, params: {} },
      { kind: 'disk_full', target: 'postgres', startTick: 7, params: {} },
    ]
    const active = activateFaults(faults, world, root, registry)
    expect(active.map((a) => a.startTick)).toEqual([4, 7])
    expect(active.every((a) => typeof a.hooks.onTick === 'function')).toBe(true)
    expect(seen).toEqual([
      { kind: 'slow_dependency', target: 'redis', draw: root('fault', 0, 'slow_dependency', 'pick').next() },
      { kind: 'disk_full', target: 'postgres', draw: root('fault', 1, 'disk_full', 'pick').next() },
    ])
  })
})
