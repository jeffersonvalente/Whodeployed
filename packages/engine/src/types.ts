/**
 * Whodeployed engine — shared contract (types only, no runtime code).
 *
 * Owner: Architect. Engineers implement against this file and never edit it;
 * a needed change is an issue for the Architect (see .claude/agents/eng-motor.md).
 *
 * Sections:
 *   1. Central contract — literal copy of SPEC §6 (CT-1). Changing it requires an ADR
 *      approved by the Director.
 *   2. Fault kinds (ADR-004).
 *   3. World model and system definition (ADR-002).
 *   4. Telemetry records and NDJSON format (ADR-005).
 *   5. Signals returned by ask() (ADR-006).
 *   6. Simulation public API (ADR-002).
 *   7. Errors (ADR-002, ADR-006).
 *   8. Internal SPI between engine modules (ADR-002, ADR-003). Not re-exported by index.ts.
 *   9. CLI (ADR-007).
 *
 * Units used everywhere: time in ticks (1 tick = 10 s of game time, SPEC §6),
 * durations in integer milliseconds, rates per second computed over 10 s.
 */

// ---------------------------------------------------------------------------
// 1. Central contract — SPEC §6 (fixed from phase 1; do not change without ADR + Director)
// ---------------------------------------------------------------------------

export interface World {
  services: Service[]
  deps: Dependency[]
  /** Current tick: the last tick already simulated. A freshly created simulation is at tick 0. */
  tick: number
  seed: string
}

export interface Fault {
  kind: FaultKind
  /** Name of a component (service or dependency) of the world. */
  target: string
  /** First tick (inclusive) in which the fault has any effect. Integer >= 0. */
  startTick: number
  /** Fully resolved parameters (every documented param present). Names and ranges: ADR-004. */
  params: Record<string, number>
}

/**
 * Every `window` is measured in ticks (ADR-006) and covers the closed interval
 * [max(0, now - window), now], where `now` is World.tick. Valid values: integer >= 1.
 */
export type Question =
  | { kind: 'dashboard'; service: string }
  | { kind: 'logs'; service: string; window: number; filter?: Record<string, string> }
  | { kind: 'trace'; service: string; percentile: 50 | 95 | 99 }
  | { kind: 'whatChanged'; window: number }
  | { kind: 'compare'; service: string; metric: string; by: 'instance' | 'lastWeek' }
  | { kind: 'askNpc'; role: 'dev' | 'dba' | 'oncall' }

/** `tickCost` is a function of `question.kind` only (table in ADR-006). ask() never advances the clock. */
export interface Answer {
  question: Question
  data: Signal
  tickCost: number
}

/**
 * Part of the contract since phase 1. Phase 2 gives semantics to 'restart' and 'rollback' only
 * (ADR-012, applied through Simulation.act); every other kind throws EngineError 'unsupported_action'.
 */
export type Action = {
  kind: 'restart' | 'rollback' | 'flagOff' | 'scale' | 'escalate' | 'declareMitigated'
  target?: string
}

// ---------------------------------------------------------------------------
// 2. Fault kinds — ADR-004 (mapping to SPEC §7 campaign rows)
// ---------------------------------------------------------------------------

export type FaultKind =
  /** Campaign row 1: service crashing in a loop. */
  | 'service_crash_loop'
  /** Campaign row 2: disk full (default target: postgres). */
  | 'disk_full'
  /** Campaign row 3: connection pool exhausted (name fixed by SPEC §7). */
  | 'connection_pool_exhaustion'
  /** Campaign row 4: bad deploy on 1 of N instances. */
  | 'bad_deploy'
  /** Campaign row 5: slow dependency; the retry storm emerges from callers' retry policy. */
  | 'slow_dependency'
  /** Campaign row 7: cold cache after a cache restart. */
  | 'cache_cold_start'

/** Documented parameter of a fault kind (ADR-004). Values outside [min, max] are rejected (F-7). */
export interface FaultParamSpec {
  default: number
  min: number
  max: number
  integer: boolean
  /** Unit label for --help, e.g. 'ticks', 'ms', 'ratio', 'connections'. */
  unit: string
  /** One-line English description for --help. */
  description: string
}

/** Which components a fault kind may target (validated by resolveFaults, F-7). */
export type FaultTargetRule = 'service' | 'dependency' | 'any' | DependencyKind

export interface FaultCatalogEntry<K extends FaultKind = FaultKind> {
  kind: K
  /** Row of SPEC §7 campaign table this kind implements (F-1). */
  campaignRow: 1 | 2 | 3 | 4 | 5 | 7
  /** One-line English summary for --help. */
  summary: string
  defaultTarget: string
  defaultStartTick: number
  targetRule: FaultTargetRule
  params: Readonly<Record<string, FaultParamSpec>>
}

export type FaultCatalog = { readonly [K in FaultKind]: FaultCatalogEntry<K> }

/**
 * Unvalidated fault input (from CLI or, later, scenario YAML). Missing fields take the
 * catalog defaults; resolveFaults() turns it into a Fault or throws EngineError (F-7).
 * "Missing" means the key is absent or `undefined`; `null` (e.g. YAML `target: ~`) is rejected
 * like any other invalid value (ADR-004 "Entrada ausente vs null"). Only own keys of `params`
 * count, so `__proto__` or `constructor` reach the validator and fail as unknown_param.
 */
export interface FaultInput {
  kind: string
  target?: string
  startTick?: number
  params?: Record<string, number>
}

export type ResolveFaults = (inputs: readonly FaultInput[], world: World) => Fault[]

// ---------------------------------------------------------------------------
// 3. World model — ADR-002
// ---------------------------------------------------------------------------

export type ComponentName = string
/** Stable per world definition: `${component}-${index}`, index from 0 (W-2). */
export type InstanceId = string
export type DependencyKind = 'database' | 'cache' | 'queue'

/** An outgoing call from a service to another component. */
export interface CallSpec {
  target: ComponentName
  /** Operation name used in spans, e.g. 'auth.verify', 'db.query'. */
  operation: string
  /** Fraction of the caller's requests that make this call, in [0, 1]. */
  ratio: number
  /** Caller-side timeout per attempt, ms. */
  timeoutMs: number
  /** Extra attempts after the first one fails or times out. Integer >= 0. */
  retries: number
  /** Only when `target` is a cache: call made on cache miss (or cache failure). */
  onMiss?: Omit<CallSpec, 'ratio' | 'onMiss'>
}

/** Traffic that originates at a service (users at gateway, queue consumption at a worker). */
export interface IngressSpec {
  /** Requests started per tick. Integer >= 0. */
  ratePerTick: number
  operation: string
}

export interface ComponentSpecBase {
  name: ComponentName
  /** Number of instances. Integer >= 1. */
  replicas: number
  /** Own processing time, p50 and p99 targets of the engine's latency distribution, ms. */
  latencyP50Ms: number
  latencyP99Ms: number
  /** CPU % of an idle instance and added CPU % per request served in the tick. */
  cpuBasePct: number
  cpuPerRequestPct: number
  /** Resident memory of an instance, MB. */
  memBaseMb: number
}

export interface ServiceSpec extends ComponentSpecBase {
  ingress?: IngressSpec
  calls: CallSpec[]
  /** Connection pool size per instance towards each database dependency. */
  dbPoolSize: number
}

export interface DependencySpec extends ComponentSpecBase {
  kind: DependencyKind
  /** Max concurrent client connections accepted (databases). */
  maxConnections: number
  /** Only for kind 'cache': steady-state hit ratio in [0, 1]. */
  cacheHitRatio?: number
}

/** Input of the engine: a system is data, never constants inside simulation logic (W-3, SPEC §3.7). */
export interface SystemDefinition {
  name: string
  services: ServiceSpec[]
  deps: DependencySpec[]
}

export interface Service extends ServiceSpec {
  instances: InstanceId[]
}

export interface Dependency extends DependencySpec {
  instances: InstanceId[]
}

// ---------------------------------------------------------------------------
// 4. Telemetry records — ADR-005. One record = one NDJSON line; `type` is the discriminator.
// ---------------------------------------------------------------------------

export type MetricName = 'rps' | 'p50' | 'p95' | 'p99' | 'errorPct' | 'cpu' | 'mem' | 'connections'

/** The 8 metrics of SPEC §4 (S-1). No other metric is exposed. */
export interface MetricValues {
  /** Server spans in the tick / 10. */
  rps: number
  /** Nearest-rank percentiles of server span durations in the tick, ms (0 when no spans). */
  p50: number
  p95: number
  p99: number
  /** Server spans with status error / total * 100 (0 when total = 0). */
  errorPct: number
  /** CPU %, 0..100 per instance; service aggregate = mean of instances. */
  cpu: number
  /** Memory MB; service aggregate = sum of instances. */
  mem: number
  /** Open connections; service aggregate = sum of instances. */
  connections: number
}

export interface MetricRecord extends MetricValues {
  type: 'metric'
  tick: number
  component: ComponentName
  /** Absent on the component aggregate record (P-2). */
  instance?: InstanceId
}

/** server = a request handled by the instance; client = an outgoing call attempt; internal = local work (e.g. 'db.acquire'). */
export type SpanKind = 'server' | 'client' | 'internal'
export type SpanStatus = 'ok' | 'error'

export interface SpanRecord {
  type: 'span'
  /** Tick in which the trace started. */
  tick: number
  traceId: string
  spanId: string
  /** Absent only on the trace root (S-3). */
  parentId?: string
  component: ComponentName
  instance: InstanceId
  operation: string
  kind: SpanKind
  /** Only on client spans: the called component. */
  peer?: ComponentName
  /** Offset from the start of the trace root, integer ms. */
  startMs: number
  /** Integer ms; startMs + durationMs of a child never exceeds the parent's end (S-3). */
  durationMs: number
  status: SpanStatus
}

/** Log level vocabulary (S-2). The "error level" of P-3 and F-3 is 'error'. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  type: 'log'
  tick: number
  component: ComponentName
  instance: InstanceId
  level: LogLevel
  /** Short English telemetry message (not scenario text, S-5). */
  message: string
  /** Present when the entry belongs to a request. */
  traceId?: string
  /** Extra structured fields; keys and values are matched by the `logs` filter (Q-5). */
  attrs?: Record<string, string | number>
}

/** Change kinds returned by whatChanged (Q-7). A restart is a 'config' change with restart: true. */
export type ChangeKind = 'deploy' | 'config'

export interface EventRecord {
  type: 'event'
  tick: number
  kind: ChangeKind
  target: ComponentName
  instance?: InstanceId
  restart?: true
  /** Copied verbatim from noise input; engine-generated events have no note. */
  note?: string
}

export type TelemetryRecord = MetricRecord | SpanRecord | LogRecord | EventRecord
export type TelemetryType = TelemetryRecord['type']

/** Noise as declared in SPEC §7 (`noise:`). Never alters metrics, logs or spans (S-4). */
export interface NoiseEvent {
  kind: ChangeKind
  target: ComponentName
  tick: number
  instance?: InstanceId
  note?: string
}

// ---------------------------------------------------------------------------
// 5. Signals — Answer.data (ADR-006). Strings are identifiers only; no prose (Q-9).
// ---------------------------------------------------------------------------

export interface MetricPoint {
  tick: number
  value: number
}

/** Closed tick interval [from, to] actually covered (clamped at 0). */
export interface TickRange {
  from: number
  to: number
}

export interface DashboardSignal extends TickRange {
  kind: 'dashboard'
  service: ComponentName
  /** Component aggregate MetricRecords (no `instance`), one per tick, ascending (Q-4). */
  records: MetricRecord[]
}

export interface LogsSignal extends TickRange {
  kind: 'logs'
  service: ComponentName
  entries: LogRecord[]
}

export interface TraceSignal {
  kind: 'trace'
  service: ComponentName
  tick: number
  percentile: 50 | 95 | 99
  /** Server span of `service` whose duration is the requested nearest-rank percentile; null when the service served nothing in the tick. */
  focusSpanId: string | null
  /** All spans of the focused trace, in generation order; empty when focusSpanId is null. */
  spans: SpanRecord[]
}

export interface WhatChangedSignal extends TickRange {
  kind: 'whatChanged'
  events: EventRecord[]
}

export interface CompareSeries {
  /** Instance id (by: 'instance') or 'current' | 'lastWeek' (by: 'lastWeek'). */
  label: string
  points: MetricPoint[]
}

export interface CompareSignal extends TickRange {
  kind: 'compare'
  service: ComponentName
  metric: MetricName
  by: 'instance' | 'lastWeek'
  series: CompareSeries[]
}

/** One anomaly an NPC points at: a metric that deviates from last week (ADR-006). */
export interface NpcHint {
  component: ComponentName
  instance?: InstanceId
  metric: MetricName
  /** Mean over the last 6 ticks in this run. */
  current: number
  /** Mean over the same ticks in the lastWeek simulation. */
  usual: number
}

export interface NpcSignal {
  kind: 'askNpc'
  role: 'dev' | 'dba' | 'oncall'
  tick: number
  /** At most 3, ordered by relative deviation (desc); empty when nothing deviates >= 25%. */
  hints: NpcHint[]
}

export type Signal =
  | DashboardSignal
  | LogsSignal
  | TraceSignal
  | WhatChangedSignal
  | CompareSignal
  | NpcSignal

export type QuestionKind = Question['kind']
export type QuestionOf<K extends QuestionKind> = Extract<Question, { kind: K }>
export type SignalOf<K extends QuestionKind> = Extract<Signal, { kind: K }>
/** Published in ADR-006 (Q-2). */
export type TickCostTable = { readonly [K in QuestionKind]: number }

// ---------------------------------------------------------------------------
// 6. Simulation public API — ADR-002
// ---------------------------------------------------------------------------

export interface SimulationConfig {
  system: SystemDefinition
  seed: string
  /**
   * Resolved or resolvable faults. createSimulation always re-validates them with resolveFaults,
   * so invalid input (e.g. read from scenario YAML) throws the same EngineError as F-7, and an
   * already resolved Fault comes back unchanged (ADR-002 Emenda 2, I24-2). Several at once are
   * allowed (F-6).
   */
  faults?: readonly Fault[]
  noise?: readonly NoiseEvent[]
}

/**
 * Read-only, indexed access to the telemetry generated so far. Returned arrays keep record order.
 *
 * Immutability (ADR-010, Q-3): every call returns a fresh array the caller may reorder or filter,
 * but the records in it are shared with the store and with every later query. They are typed
 * `Readonly<...>` here and frozen at runtime by the store (`Object.freeze`, including log `attrs`),
 * so a handler or a caller of ask() cannot change what later queries, all() or the NDJSON see.
 * `world` is frozen too (a new frozen snapshot per appended tick).
 */
export interface TelemetryView {
  readonly world: Readonly<World>
  /** Last simulated tick (= world.tick). */
  readonly now: number
  /** All MetricRecords (instance and aggregate) of `component` with tick in [from, to]. */
  metricsOf(component: ComponentName, from: number, to: number): Readonly<MetricRecord>[]
  logsOf(component: ComponentName, from: number, to: number): Readonly<LogRecord>[]
  /** Spans whose `component` is `component` and that started in `tick`. */
  spansOf(component: ComponentName, tick: number): Readonly<SpanRecord>[]
  /** All spans with this traceId, in generation order. */
  traceOf(traceId: string): Readonly<SpanRecord>[]
  eventsIn(from: number, to: number): Readonly<EventRecord>[]
  /** Every record, in canonical NDJSON order (ADR-005). */
  all(): readonly Readonly<TelemetryRecord>[]
}

export interface Simulation {
  /** Snapshot of the world; `tick` is the last simulated tick. */
  readonly world: World
  /**
   * Simulates the next `ticks` ticks (default 1) and returns only their records.
   * `ticks` is an integer in 0..100000 (MAX_TICKS); otherwise EngineError 'invalid_ticks' (ADR-002 Emenda 2, I24-3).
   */
  advance(ticks?: number): TelemetryRecord[]
  /** Pure read against the current tick; never changes telemetry (Q-3). Throws EngineError (Q-10). */
  ask(question: Question): Answer
  /**
   * Applies an Action (ADR-012). Validates it against the world, schedules its effect for tick
   * `world.tick + 1` and returns its cost; like ask(), it never advances the clock (the caller
   * advances by `tickCost`). Actions applied before the same advance() take effect in call order.
   * Same seed + same questions and actions at the same ticks => byte-identical telemetry (EN-4).
   * Throws EngineError 'invalid_action', 'unknown_target' or 'unsupported_action' (EN-5).
   */
  act(action: Action): ActionResult
  telemetry(): TelemetryView
}

/** Action kinds with semantics in phase 2 (ADR-012). The other kinds of Action are 'unsupported_action'. */
export type SupportedActionKind = Extract<Action['kind'], 'restart' | 'rollback'>

/** Published in ADR-012 (EN-4): tick cost of each supported action, integer >= 1. */
export type ActionCostTable = { readonly [K in SupportedActionKind]: number }

/**
 * Returned by Simulation.act. Deliberately carries no information about what the action changed
 * (e.g. whether a rollback found a deploy to revert): the player learns it from the signals (SPEC §3.4).
 */
export interface ActionResult {
  /** Validated copy of the action, keys in contract order (kind, target). */
  action: Action
  /** world.tick when act() was called; the effect starts at tick + 1 (ADR-012). */
  tick: number
  tickCost: number
}

/**
 * User impact of one tick (ADR-013): a pure function of the telemetry of that tick plus the
 * world's ingress definition. Knows nothing about scenarios (EN-6, SPEC §3.3).
 */
export interface ImpactTick {
  tick: number
  /** Requests expected at the entry services in the tick (sum of IngressSpec.ratePerTick). */
  expected: number
  /** Expected requests that were lost at the edge, failed, or were slower than the threshold. */
  bad: number
  /** bad / expected >= the threshold of ADR-013. Counts 1 towards the accumulated impact. */
  impacted: boolean
}

/** Impact of tick `tick` of `view` (0 <= tick <= view.now). Throws EngineError 'invalid_ticks' outside. */
export type ImpactOfTick = (view: TelemetryView, tick: number) => ImpactTick

/** Number of impacted ticks in [0, upTo] (0 <= upTo <= view.now). The game's "impact" counter (EN-6). */
export type AccumulatedImpact = (view: TelemetryView, upTo: number) => number

/** Creates the simulation and simulates tick 0. Throws EngineError on invalid config. */
export type CreateSimulation = (config: SimulationConfig) => Simulation

/** Convenience: records of ticks [0, ticks) in canonical order. */
export type Simulate = (config: SimulationConfig, ticks: number) => TelemetryRecord[]

/** Canonical NDJSON line for one record, without trailing newline (ADR-005). */
export type SerializeRecord = (record: TelemetryRecord) => string

// ---------------------------------------------------------------------------
// 7. Errors — every engine error is an EngineError (class in src/errors.ts) implementing this.
// ---------------------------------------------------------------------------

export type EngineErrorCode =
  | 'invalid_system'
  | 'invalid_seed'
  | 'invalid_ticks'
  | 'unknown_fault_kind'
  | 'unknown_target'
  | 'invalid_target'
  | 'unknown_param'
  | 'param_out_of_range'
  | 'invalid_start_tick'
  | 'invalid_noise'
  | 'unknown_service'
  | 'unknown_metric'
  | 'invalid_window'
  | 'invalid_percentile'
  | 'invalid_filter'
  | 'invalid_role'
  | 'invalid_question'
  /** Action that is not an object, has an unknown kind, a missing/non-string target or an extra key (ADR-012). */
  | 'invalid_action'
  /** Known Action kind without semantics in this phase: flagOff, scale, escalate, declareMitigated (ADR-012, EN-5). */
  | 'unsupported_action'
  | 'usage'

export interface EngineErrorInfo {
  name: 'EngineError'
  code: EngineErrorCode
  /** Path of the offending field, e.g. 'faults[0].params.poolSize', 'question.percentile', '--ticks'. */
  field: string
  received: unknown
  /** Valid values (or "min..max" for ranges); always present when the set is finite. */
  validValues?: readonly (string | number)[]
  /** English; names `field` and lists `validValues`. */
  message: string
}

// ---------------------------------------------------------------------------
// 8. Internal SPI — contracts between engine modules so tasks can run in parallel.
//    Not part of the public package API; index.ts must not re-export this section.
// ---------------------------------------------------------------------------

/** Seeded PRNG stream (ADR-003). The only source of randomness in src/. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [min, maxExclusive). */
  int(min: number, maxExclusive: number): number
  /** true with probability p. */
  chance(p: number): boolean
  pick<T>(items: readonly T[]): T
}

/** Independent stream per key; same (seed, key) => same sequence, regardless of call order elsewhere. */
export type RngFactory = (...key: readonly (string | number)[]) => Rng
export type CreateRngFactory = (seed: string) => RngFactory

export interface FaultLog {
  component: ComponentName
  instance: InstanceId
  level: LogLevel
  message: string
  traceId?: string
  attrs?: Record<string, string | number>
}

export interface FailEffect {
  message: string
  attrs?: Record<string, string | number>
}

export interface TickContext {
  tick: number
  world: World
}

export interface TickEffect {
  /** Instances that are down for the whole tick: calls to them fail fast, no server span. */
  down?: InstanceId[]
  events?: Omit<EventRecord, 'type' | 'tick'>[]
  logs?: FaultLog[]
}

export interface ServeContext {
  tick: number
  component: ComponentName
  instance: InstanceId
  operation: string
  traceId: string
}

export interface ServeEffect {
  addLatencyMs?: number
  fail?: FailEffect
}

export interface CallContext {
  tick: number
  caller: ComponentName
  callerInstance: InstanceId
  target: ComponentName
  operation: string
  /** 0 for the first attempt. */
  attempt: number
  traceId: string
}

export interface CallEffect {
  /** Cache calls only: treat as miss and follow onMiss. */
  forceCacheMiss?: boolean
  /** Time spent before the call starts, recorded as an internal span named waitOperation. */
  waitMs?: number
  waitOperation?: string
  /** Fail the attempt on the caller side (after waitMs) without reaching the target. */
  fail?: FailEffect
}

export interface ResourceContext {
  tick: number
  component: ComponentName
  instance: InstanceId
}

export interface ResourceEffect {
  cpuPctAdd?: number
  memMbAdd?: number
  connectionsAdd?: number
  /** Upper bound applied after connectionsAdd. */
  connectionsCap?: number
}

/**
 * Hooks of one active fault. The orchestrator calls them only for tick >= fault.startTick (F-2)
 * and merges several faults by the rules of ADR-002. Hooks must be pure functions of their
 * context plus the RngFactory given to activate() (ADR-003).
 */
export interface FaultHooks {
  onTick?(ctx: TickContext): TickEffect | undefined
  onServe?(ctx: ServeContext): ServeEffect | undefined
  onCall?(ctx: CallContext): CallEffect | undefined
  onResources?(ctx: ResourceContext): ResourceEffect | undefined
}

export interface FaultModule<K extends FaultKind = FaultKind> {
  kind: K
  /** `fault` is already resolved; `rng` is a factory reserved to this fault (keyed by its index). */
  activate(fault: Fault, world: World, rng: RngFactory): FaultHooks
}

export type FaultRegistry = { readonly [K in FaultKind]: FaultModule<K> }

/**
 * What happens to an active fault when the processes of its target are replaced, i.e. on a
 * restart of the target, or on a rollback of the target that finds a deploy to revert (ADR-012):
 *   clear  the fault's hooks stop being invoked from the effect tick on;
 *   reset  the fault is re-activated with startTick = effect tick (its state starts over);
 *   none   the fault is unaffected.
 */
export type ProcessReplacementReaction = 'clear' | 'reset' | 'none'

export interface FaultActionReaction {
  onProcessReplacement: ProcessReplacementReaction
  /**
   * true when the fault is bound to the deploy events it emits (bad_deploy): a rollback that
   * reverts that deploy batch clears the fault, whatever onProcessReplacement says.
   */
  revertedByRollback: boolean
}

/** Data table of ADR-012, one row per FaultKind (src/sim/actions.ts). */
export type FaultActionReactions = { readonly [K in FaultKind]: FaultActionReaction }

/** Detail of an error span, consumed by log generation (P-3). */
export interface ErrorDetail {
  spanId: string
  message: string
  attrs?: Record<string, string | number>
}

export interface TrafficInput {
  world: World
  tick: number
  rng: RngFactory
  down: ReadonlySet<InstanceId>
  /** Already merged and startTick-gated by the orchestrator. */
  hooks: FaultHooks
}

export interface TrafficResult {
  spans: SpanRecord[]
  /** Exactly one entry per span with status 'error'. */
  errors: ErrorDetail[]
}

export type GenerateTraffic = (input: TrafficInput) => TrafficResult

export interface DeriveMetricsInput {
  world: World
  tick: number
  /** All spans that started in `tick`. */
  spans: readonly SpanRecord[]
  down: ReadonlySet<InstanceId>
  resourceEffects: ReadonlyMap<InstanceId, ResourceEffect>
  rng: RngFactory
}

/** Instance records then aggregate, per component in world order (ADR-005). */
export type DeriveMetrics = (input: DeriveMetricsInput) => MetricRecord[]

export interface GenerateLogsInput {
  world: World
  tick: number
  spans: readonly SpanRecord[]
  errors: readonly ErrorDetail[]
  faultLogs: readonly FaultLog[]
  rng: RngFactory
}

export type GenerateLogs = (input: GenerateLogsInput) => LogRecord[]

export interface TelemetryStore extends TelemetryView {
  /** Appends the records of one tick (already in canonical order) and moves `now`. */
  appendTick(tick: number, records: readonly TelemetryRecord[]): void
}

export type CreateTelemetryStore = (world: World) => TelemetryStore

/**
 * Built by the ask() dispatcher (T1.16) from its internal AskEnvironment {view, config}
 * (src/questions/ask.ts) on every call (ADR-006 "Contexto das perguntas").
 */
export interface QuestionContext {
  view: TelemetryView
  /**
   * Lazily simulated fault-free, noise-free run of the same system with seed `${seed}:lastWeek`
   * (ADR-003 §4), memoized per AskEnvironment and always simulated up to at least `view.now`
   * (ticks [0, view.now]), so every tick of the current window exists in it (ADR-006).
   */
  lastWeek(): TelemetryView
}

/** Handlers receive questions already validated by the dispatcher (Q-10). */
export type QuestionHandler<K extends QuestionKind> = (question: QuestionOf<K>, ctx: QuestionContext) => SignalOf<K>

export type QuestionRegistry = { readonly [K in QuestionKind]: QuestionHandler<K> }

// ---------------------------------------------------------------------------
// 9. CLI — ADR-007 (src/cli/ is outside the library boundary of CT-3)
// ---------------------------------------------------------------------------

export type CliCommand =
  | { kind: 'help'; topic: 'root' | 'simulate' }
  | { kind: 'simulate'; seed: string; ticks: number; faults: FaultInput[] }

/** Pure: argv without node and script path. Throws EngineError with code 'usage' (CLI-3). */
export type ParseCliArgs = (argv: readonly string[]) => CliCommand
