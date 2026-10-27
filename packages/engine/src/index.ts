/**
 * Public API of @whodeployed/engine (ADR-002 §2).
 *
 * Re-exports sections 1–7 of types.ts (section 8, the internal SPI, and section 9, the CLI,
 * stay private) plus the public runtime values. Created by T1.1; edited by T1.15, which added
 * the simulation API (createSimulation, simulate), the canonical serializer (serializeRecord,
 * toNdjson), fault resolution (resolveFaults), the error class (EngineError, isEngineError) and
 * the default system (defaultShop), so a library user can run a simulation without writing one.
 */

// 1. Central contract — SPEC §6
export type { World, Fault, Question, Answer, Action } from './types.js'

// 2. Fault kinds — ADR-004
export type {
  FaultKind,
  FaultParamSpec,
  FaultTargetRule,
  FaultCatalogEntry,
  FaultCatalog,
  FaultInput,
  ResolveFaults,
} from './types.js'

// 3. World model — ADR-002
export type {
  ComponentName,
  InstanceId,
  DependencyKind,
  CallSpec,
  IngressSpec,
  ComponentSpecBase,
  ServiceSpec,
  DependencySpec,
  SystemDefinition,
  Service,
  Dependency,
} from './types.js'

// 4. Telemetry records — ADR-005
export type {
  MetricName,
  MetricValues,
  MetricRecord,
  SpanKind,
  SpanStatus,
  SpanRecord,
  LogLevel,
  LogRecord,
  ChangeKind,
  EventRecord,
  TelemetryRecord,
  TelemetryType,
  NoiseEvent,
} from './types.js'

// 5. Signals — ADR-006
export type {
  MetricPoint,
  TickRange,
  DashboardSignal,
  LogsSignal,
  TraceSignal,
  WhatChangedSignal,
  CompareSeries,
  CompareSignal,
  NpcHint,
  NpcSignal,
  Signal,
  QuestionKind,
  QuestionOf,
  SignalOf,
  TickCostTable,
} from './types.js'

// 6. Simulation public API — ADR-002
export type {
  SimulationConfig,
  TelemetryView,
  Simulation,
  CreateSimulation,
  Simulate,
  SerializeRecord,
  // Phase 2 (ADR-012, ADR-013; list in ADR-002 Emenda 2)
  SupportedActionKind,
  ActionCostTable,
  ActionResult,
  ImpactTick,
  ImpactOfTick,
  AccumulatedImpact,
} from './types.js'

// 7. Errors
export type { EngineErrorCode, EngineErrorInfo } from './types.js'

// Runtime values
export { createSimulation, simulate } from './sim/simulation.js'
export { serializeRecord, toNdjson } from './sim/serialize.js'
// Phase 2 (T2.6): impact function, ADR-013
export { accumulatedImpact, impactOfTick } from './sim/impact.js'
export { faultCatalog, faultKinds } from './faults/catalog.js'
export { resolveFaults } from './faults/resolve.js'
export { EngineError, isEngineError } from './errors.js'
export { defaultShop } from './world/default-shop.js'
