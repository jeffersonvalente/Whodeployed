# @whodeployed/engine

Deterministic simulator of a small online shop (6 services + 3 dependencies) that injects
faults and generates coherent synthetic telemetry: metrics, structured logs, simplified
traces and deploy/config events. Same seed, same output, byte for byte.

> **Status: work in progress (phase 1).** The package is being scaffolded; the simulator,
> the `ask()` API and the `whodeployed-engine simulate` CLI are not implemented yet.
> Full documentation (installation, CLI usage with the 6 fault kinds, library example,
> seeds and ticks) arrives with task T1.28.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter ./packages/engine lint
pnpm --filter ./packages/engine typecheck
pnpm --filter ./packages/engine test
pnpm --filter ./packages/engine build
```

## License

Apache-2.0. See `LICENSE`.
