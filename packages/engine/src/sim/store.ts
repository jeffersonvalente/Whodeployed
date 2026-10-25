/**
 * TelemetryStore (ADR-002 §2/§3, ADR-005): append-only, indexed storage of the records the
 * simulation generates, exposed to `ask()` handlers as a read-only TelemetryView.
 *
 * - The orchestrator appends one tick at a time, already in canonical NDJSON order; the store
 *   never reorders, so every query returns records in insertion (= canonical) order.
 * - Ticks are contiguous: the first appended tick is `world.tick`, then +1 each time.
 * - Queries are pure reads (Q-3): they never change the store and return fresh arrays, so a
 *   caller cannot alter what later queries or `all()` see.
 * - Immutability (ADR-010): every record handed to `appendTick` is frozen (with its `attrs`)
 *   before it is indexed, and `world` is a frozen snapshot replaced on every appended tick; the
 *   `services`/`deps` arrays and every object in them are deep-frozen when the store is created.
 *   Records are shared, never copied, between the store, handlers and callers; in ESM (strict
 *   mode) a write to any of them throws a TypeError instead of corrupting the telemetry.
 * - Windows `[from, to]` are closed on both ends and are clamped to the stored ticks.
 */
import type {
  ComponentName,
  CreateTelemetryStore,
  EventRecord,
  LogRecord,
  MetricRecord,
  SpanRecord,
  TelemetryRecord,
  TelemetryStore,
  World,
} from '../types.js'

/** Records of one tick, bucketed by component; each bucket keeps insertion order. */
interface TickBucket {
  metrics: Map<ComponentName, MetricRecord[]>
  logs: Map<ComponentName, LogRecord[]>
  spans: Map<ComponentName, SpanRecord[]>
  events: EventRecord[]
}

function push<T>(map: Map<ComponentName, T[]>, key: ComponentName, value: T): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

/**
 * Freezes `value` and every object reachable from it through own enumerable properties.
 * Objects that are already frozen are assumed to be deep-frozen and are not walked again.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

function assertTick(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`TelemetryStore: ${name} must be an integer >= 0, received ${JSON.stringify(value)}`)
  }
}

export const createTelemetryStore: CreateTelemetryStore = (world: World): TelemetryStore => {
  assertTick(world.tick, 'world.tick')
  /** First tick the store accepts; buckets[i] holds tick `base + i`. */
  const base = world.tick
  const buckets: TickBucket[] = []
  const records: TelemetryRecord[] = []
  const traces = new Map<string, SpanRecord[]>()
  // The world definition is shared, not copied: nobody changes it after buildWorld (ADR-010 §4).
  deepFreeze(world.services)
  deepFreeze(world.deps)
  // Own frozen snapshot, so `world.tick` can follow `now` without mutating the caller's object.
  let snapshot: Readonly<World> = Object.freeze({ ...world })

  /** Buckets whose tick is in [from, to], clamped to the stored range. */
  function bucketsIn(from: number, to: number): TickBucket[] {
    const start = Math.max(Math.ceil(from) - base, 0)
    const end = Math.min(Math.floor(to) - base, buckets.length - 1)
    return start > end ? [] : buckets.slice(start, end + 1)
  }

  function collect<T>(from: number, to: number, pick: (bucket: TickBucket) => readonly T[] | undefined): T[] {
    const out: T[] = []
    for (const bucket of bucketsIn(from, to)) {
      const list = pick(bucket)
      if (list !== undefined) out.push(...list)
    }
    return out
  }

  return {
    get world() {
      return snapshot
    },
    get now() {
      return snapshot.tick
    },

    appendTick(tick, tickRecords) {
      const expected = base + buckets.length
      if (tick !== expected) {
        throw new RangeError(
          `TelemetryStore: ticks must be appended in order; expected tick ${expected}, received ${JSON.stringify(tick)}`,
        )
      }
      for (const [index, record] of tickRecords.entries()) {
        if (record.tick !== tick) {
          throw new RangeError(
            `TelemetryStore: record ${index} of tick ${tick} has tick ${JSON.stringify(record.tick)}`,
          )
        }
      }

      const bucket: TickBucket = { metrics: new Map(), logs: new Map(), spans: new Map(), events: [] }
      for (const record of tickRecords) {
        deepFreeze(record)
        switch (record.type) {
          case 'metric':
            push(bucket.metrics, record.component, record)
            break
          case 'log':
            push(bucket.logs, record.component, record)
            break
          case 'span':
            push(bucket.spans, record.component, record)
            push(traces, record.traceId, record)
            break
          case 'event':
            bucket.events.push(record)
            break
        }
        records.push(record)
      }
      buckets.push(bucket)
      snapshot = Object.freeze({ ...snapshot, tick })
    },

    metricsOf(component, from, to) {
      return collect(from, to, (bucket) => bucket.metrics.get(component))
    },

    logsOf(component, from, to) {
      return collect(from, to, (bucket) => bucket.logs.get(component))
    },

    spansOf(component, tick) {
      return collect(tick, tick, (bucket) => bucket.spans.get(component))
    },

    traceOf(traceId) {
      return [...(traces.get(traceId) ?? [])]
    },

    eventsIn(from, to) {
      return collect(from, to, (bucket) => bucket.events)
    },

    all() {
      return [...records]
    },
  }
}
