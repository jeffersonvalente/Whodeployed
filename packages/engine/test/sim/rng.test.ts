/**
 * T1.2 — PRNG mulberry32 + xmur3 and createRngFactory with keyed streams (ADR-003).
 * Criteria: D-1, D-2, D-4, DET.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KEY_SEPARATOR, createRng, createRngFactory, mulberry32, streamKey, xmur3 } from '../../src/sim/rng.js'

const take = (next: () => number, n: number): number[] => Array.from({ length: n }, () => next())

describe('reference vector (versioned, ADR-003)', () => {
  it("first 5 values of ('s', 'k') are fixed", () => {
    // Matches the canonical bryc xmur3/mulberry32 reference implementation for 's\u001fk'.
    const r = createRngFactory('s')('k')
    expect(take(() => r.next(), 5)).toEqual([
      0.9657232002355158, 0.07541851024143398, 0.10540679423138499, 0.9671107814647257, 0.595170576358214,
    ])
  })

  it('xmur3 and mulberry32 have fixed outputs', () => {
    expect(take(xmur3('abc'), 3)).toEqual(take(xmur3('abc'), 3))
    expect(xmur3('')()).toBe(xmur3('')())
    expect(take(mulberry32(0), 3)).toEqual([0.26642920868471265, 0.0003297457005828619, 0.2232720274478197])
  })

  it('stream key joins seed and key parts with U+001F', () => {
    expect(KEY_SEPARATOR).toBe('\u001f')
    expect(streamKey('seed', ['traffic', 3, 'gateway'])).toBe('seed\u001ftraffic\u001f3\u001fgateway')
    expect(streamKey('seed', [])).toBe('seed\u001f')
  })
})

describe('keyed streams', () => {
  it('same seed + key => same sequence (also across factories)', () => {
    const a = createRngFactory('gate1')('lat', 't3r7', 2)
    const b = createRngFactory('gate1')('lat', 't3r7', 2)
    expect(take(() => a.next(), 100)).toEqual(take(() => b.next(), 100))
  })

  it('different keys => different sequences', () => {
    const f = createRngFactory('gate1')
    const keys: (string | number)[][] = [['traffic', 0, 'gateway'], ['traffic', 1, 'gateway'], ['traffic', 0, 'auth'], ['lb', 0, 'gateway'], ['res', 0, 'gateway', 'gateway-0']]
    const firsts = keys.map((k) => {
      const r = f(...k)
      return take(() => r.next(), 4).join(',')
    })
    expect(new Set(firsts).size).toBe(keys.length)
  })

  it('different seeds => different sequences for the same key', () => {
    const seq = (seed: string) => {
      const r = createRngFactory(seed)('k')
      return take(() => r.next(), 4)
    }
    expect(seq('a')).not.toEqual(seq('b'))
    expect(seq('a')).not.toEqual(seq('a:lastWeek'))
  })

  it('consuming one stream does not alter another', () => {
    const f = createRngFactory('iso')
    const alone = f('x')
    const untouched = take(() => alone.next(), 20)
    const noisy = f('y')
    const x = f('x')
    const interleaved: number[] = []
    for (let i = 0; i < 20; i++) {
      take(() => noisy.next(), 7)
      interleaved.push(x.next())
    }
    expect(interleaved).toEqual(untouched)
  })

  it('each factory call returns a fresh stream from the start', () => {
    const f = createRngFactory('fresh')
    const first = f('k')
    first.next()
    first.next()
    expect(f('k').next()).toBe(createRngFactory('fresh')('k').next())
  })

  it('values are in [0, 1) and roughly uniform', () => {
    const r = createRngFactory('uniform')('k')
    const values = take(() => r.next(), 20000)
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true)
    const mean = values.reduce((s, v) => s + v, 0) / values.length
    expect(mean).toBeGreaterThan(0.48)
    expect(mean).toBeLessThan(0.52)
    const buckets = new Array<number>(10).fill(0)
    for (const v of values) buckets[Math.floor(v * 10)]! += 1
    for (const b of buckets) expect(b).toBeGreaterThan(1700)
  })
})

describe('Rng helpers at the limits', () => {
  const fixed = (...values: number[]) => {
    let i = 0
    return createRng(() => values[i++ % values.length] as number)
  }

  it('int maps [0, 1) onto [min, maxExclusive)', () => {
    expect(fixed(0).int(3, 7)).toBe(3)
    expect(fixed(0.999999999).int(3, 7)).toBe(6)
    expect(fixed(0.5).int(-2, 2)).toBe(0)
    expect(fixed(0.999).int(5, 6)).toBe(5)
  })

  it('int covers every value of the range and never maxExclusive', () => {
    const r = createRngFactory('int')('k')
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const v = r.int(0, 5)
      expect(Number.isInteger(v)).toBe(true)
      seen.add(v)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4])
  })

  it('int rejects empty or non-integer ranges', () => {
    const r = createRngFactory('int')('bad')
    expect(() => r.int(3, 3)).toThrow(RangeError)
    expect(() => r.int(4, 3)).toThrow(/min < maxExclusive/)
    expect(() => r.int(0.5, 3)).toThrow(RangeError)
    expect(() => r.int(0, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('chance(0) is always false, chance(1) always true, and both consume one value', () => {
    const r = createRngFactory('chance')('k')
    const ref = createRngFactory('chance')('k')
    for (let i = 0; i < 500; i++) {
      expect(r.chance(0)).toBe(false)
      expect(r.chance(1)).toBe(true)
      ref.next()
      ref.next()
    }
    expect(r.next()).toBe(ref.next())
  })

  it('chance(p) is next() < p', () => {
    expect(fixed(0.3).chance(0.3)).toBe(false)
    expect(fixed(0.2999).chance(0.3)).toBe(true)
    const r = createRngFactory('chance')('rate')
    let hits = 0
    for (let i = 0; i < 10000; i++) if (r.chance(0.2)) hits++
    expect(hits).toBeGreaterThan(1800)
    expect(hits).toBeLessThan(2200)
  })

  it('pick returns first and last items at the limits', () => {
    const items = ['a', 'b', 'c'] as const
    expect(fixed(0).pick(items)).toBe('a')
    expect(fixed(0.9999).pick(items)).toBe('c')
    expect(fixed(0.5).pick(['only'])).toBe('only')
  })

  it('pick rejects an empty list', () => {
    expect(() => createRngFactory('pick')('k').pick([])).toThrow(RangeError)
  })
})

describe('DET: determinism (D-1, D-2)', () => {
  const sample = (seed: string): string => {
    const f = createRngFactory(seed)
    const out: number[] = []
    for (let tick = 0; tick < 50; tick++) {
      const r = f('traffic', tick, 'gateway')
      out.push(r.next(), r.int(0, 1000), r.chance(0.5) ? 1 : 0, r.pick([10, 20, 30]))
    }
    return createHash('sha256').update(JSON.stringify(out)).digest('hex')
  }

  it('two runs with the same seed have the same hash; another seed differs', () => {
    expect(sample('gate1')).toBe(sample('gate1'))
    expect(sample('gate1')).not.toBe(sample('gate2'))
  })

  it('separate processes under different TZ/LANG produce the same hash', () => {
    const rngPath = fileURLToPath(new URL('../../src/sim/rng.ts', import.meta.url))
    const script = [
      `import { createRngFactory } from ${JSON.stringify(rngPath)}`,
      `import { createHash } from 'node:crypto'`,
      `const f = createRngFactory('gate1'); const out = []`,
      `for (let t = 0; t < 50; t++) { const r = f('traffic', t, 'gateway'); out.push(r.next(), r.int(0, 1000), r.chance(0.5) ? 1 : 0, r.pick([10, 20, 30])) }`,
      `process.stdout.write(createHash('sha256').update(JSON.stringify(out)).digest('hex'))`,
    ].join('\n')
    const run = (env: Record<string, string>) => {
      const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      })
      expect(res.status, res.stderr).toBe(0)
      return res.stdout
    }
    const utc = run({ TZ: 'UTC', LANG: 'C', LC_ALL: 'C' })
    const tokyo = run({ TZ: 'Asia/Tokyo', LANG: 'pt_BR.UTF-8', LC_ALL: 'pt_BR.UTF-8' })
    expect(utc).toBe(tokyo)
    expect(utc).toBe(sample('gate1'))
  })
})
