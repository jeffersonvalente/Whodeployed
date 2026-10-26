# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

The engine (`packages/engine`) is released on its own, with tags `engine-v<version>`. The game
has no release yet.

## [Unreleased]

### Added
- Phase 0: SPEC.md, README, CONTRIBUTING, ADR-001 (stack), agent chain under `.claude/agents/`, repo layout, CI skeleton.

## [engine-v0.1.0] - 2026-10-26

First release of `@whodeployed/engine`, the deterministic incident simulator behind the game.
It is distributed as a tarball attached to the GitHub Release, not on the npm registry.
Requires Node.js 22 or later.

### Added
- Simulation of one fictional shop, tick by tick (1 tick = 10 s of game time): 6 services (`gateway`, `auth`, `catalog`, `cart`, `payment`, `orders-worker`, 3 instances each) and 3 dependencies (`postgres`, `redis`, `queue`).
- 6 fault kinds, combinable in one run: `service_crash_loop`, `disk_full`, `connection_pool_exhaustion`, `bad_deploy`, `slow_dependency`, `cache_cold_start`. Each has a default target, start tick and parameters with ranges.
- Generated telemetry: metrics (`rps`, `p50`, `p95`, `p99`, `errorPct`, `cpu`, `mem`, `connections`) per component and per instance, structured logs, simplified traces (span trees with duration and status) and deploy/config events. Request metrics are derived from the spans of the same tick.
- Determinism: the same seed and arguments give byte-identical output on any machine, time zone or locale. All randomness comes from a seeded generator.
- Library API: `createSimulation(config)` returns a simulation with `advance(n)` and `ask(question)`; `ask` takes 6 questions (`dashboard`, `logs`, `whatChanged`, `trace`, `compare`, `askNpc`), each with a `tickCost`; `simulate`, `toNdjson`, `resolveFaults`, `faultCatalog`, `faultKinds`, `defaultShop` and the contract types. Invalid input throws `EngineError` with `code`, `field` and `validValues`.
- CLI `whodeployed-engine simulate --seed <string> --ticks <int> [--fault <spec>]...`, writing NDJSON to stdout; invalid invocations exit with code 2 and write nothing to stdout.
- No runtime dependencies; the library does no network, disk or clock access.
- Independent coherence checker (`packages/engine/scripts/verify-coherence.mjs`, in the repository, not in the tarball) that recomputes every request metric from the spans.

### Known issues
- `--ticks` accepts 1..100000, but the CLI keeps the whole run in memory: past about 30000 ticks it can run out of heap and abort with exit code 134 and empty stdout. Stay at or below 10000 ticks. See the package README and [#24](https://github.com/jeffersonvalente/Whodeployed/issues/24).

[Unreleased]: https://github.com/jeffersonvalente/Whodeployed/compare/engine-v0.1.0...HEAD
[engine-v0.1.0]: https://github.com/jeffersonvalente/Whodeployed/releases/tag/engine-v0.1.0
