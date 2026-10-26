# @whodeployed/engine

Deterministic simulator of a small online shop (6 services + 3 dependencies). It injects
faults and generates coherent synthetic telemetry: metrics, structured logs, simplified
traces and deploy/config events. Same seed, same output, byte for byte.

It is the engine behind [Whodeployed](../../README.md), a browser game about investigating
production incidents, and it works on its own: a command-line tool that writes NDJSON, and a
library you can ask questions (`ask()`).

- **Generated, not scripted.** Every metric, log and span comes from one tick-by-tick
  simulation. Request metrics (RPS, error %, p50/p95/p99) are derived from the spans of the
  same tick, so the signals agree with each other.
- **Signals lie the way real ones do.** A fault also shows up away from its target: in
  callers, dependencies, aggregates and the other instances.
- **No runtime dependencies, no I/O.** The library is a pure function of
  `(system, seed, faults)`; it uses no network, no disk and no clock. The CLI only writes to
  stdout and stderr.

## The system

`defaultShop` has 6 services (`gateway`, `auth`, `catalog`, `cart`, `payment`,
`orders-worker`, 3 instances each) and 3 dependencies (`postgres`, `redis`, `queue`). Each
component and each instance reports 8 metrics per tick: `rps`, `p50`, `p95`, `p99`, `errorPct`,
`cpu`, `mem`, `connections`.

## Seed and tick

- **Tick:** the engine's unit of time. 1 tick = 10 seconds of game time, so 6 ticks are a
  minute and 360 ticks are an hour. Every record carries the integer `tick` it was generated
  in, and rates are per second over those 10 s (`rps` = requests in the tick / 10).
- **Seed:** any non-empty string. All randomness (latency, load balancing, which instance a
  fault hits) comes from a pseudo-random generator seeded with it. The same seed with the same
  arguments gives byte-identical output on any machine, time zone or locale; a different seed
  gives different, equally coherent telemetry.

## Installation

Requires Node.js 22 or later. The package is not on the npm registry; it is distributed as a
tarball (`.tgz`).

### From a GitHub Release

Each engine release of the repository (tag `engine-v<version>`) carries the tarball as an
asset. Download the `.tgz` from the
[releases page](https://github.com/jeffersonvalente/Whodeployed/releases) and install it into
your project with `npm install ./whodeployed-engine-<version>.tgz`, or give `npm install` the
asset URL directly. For 0.1.0:

```sh
npm install https://github.com/jeffersonvalente/Whodeployed/releases/download/engine-v0.1.0/whodeployed-engine-0.1.0.tgz
npx whodeployed-engine --help
```

### From a local tarball

To build the tarball from source you also need pnpm 9 (`corepack enable pnpm`). From the
repository root, this builds the package, packs it into `/tmp/whodeployed-demo` and installs
it there, outside the repository:

```sh
pnpm install --frozen-lockfile
pnpm --filter ./packages/engine build
pnpm --dir packages/engine pack --pack-destination /tmp/whodeployed-demo
cd /tmp/whodeployed-demo
npm install ./whodeployed-engine-*.tgz
npx whodeployed-engine --help
```

The remaining examples run in `/tmp/whodeployed-demo`, the directory where the tarball is
installed.

### The tarball in `packages/engine/dist/`

CI packs the engine into `packages/engine/dist/` and keeps the tarball as the
`whodeployed-engine-<version>` artifact of each workflow run, with `<version>` taken from
`packages/engine/package.json` (for example `whodeployed-engine-0.1.0`; Actions tab of the
repository; the download is a zip holding the `.tgz`). A release asset is packed the same way. To produce the
same file locally, from the repository root:

```sh
rm -rf packages/engine/dist
pnpm --filter ./packages/engine build
pnpm --dir packages/engine pack --pack-destination dist/
```

The tarball is `packages/engine/dist/whodeployed-engine-<version>.tgz`. Start from
`rm -rf packages/engine/dist`: the package ships all of `dist/`, and the build does not empty
it, so a `.tgz` left there by an earlier pack would end up inside the new tarball. CI runs on
a clean checkout. `bash packages/engine/scripts/pack-artifact.sh` runs the build and the pack
above, refuses a `dist/` that already holds a `.tgz`, checks the tarball contents and installs
it in a temporary directory outside the repository to compare its output with the built CLI.

To install that tarball (or the one from a CI artifact) outside the repository:

```sh
mkdir -p /tmp/whodeployed-dist-demo
cp packages/engine/dist/whodeployed-engine-*.tgz /tmp/whodeployed-dist-demo/
cd /tmp/whodeployed-dist-demo
npm install ./whodeployed-engine-*.tgz
npx whodeployed-engine simulate --seed pub --fault connection_pool_exhaustion --ticks 30 | sha256sum
```

The hash is the same as the one printed by
`node packages/engine/dist/cli/main.js simulate --seed pub --fault connection_pool_exhaustion --ticks 30 | sha256sum`
in the repository: the installed CLI is the same code, and the same seed gives the same bytes.

## Command-line usage

```
whodeployed-engine simulate --seed <string> --ticks <int> [--fault <spec>]...
whodeployed-engine --help | simulate --help
```

`simulate` writes ticks `[0, ticks)` as NDJSON to stdout. `--seed` and `--ticks` (an integer
in 1..100000) are required. Without `--fault` you get the baseline: the shop with no fault.
To save the output, redirect stdout; there is no output-file flag.

### Practical limit of `--ticks`

`--ticks` accepts up to 100000, but the CLI builds the whole run in memory before it writes
the first line, so long runs are bounded by the Node.js heap, not by that range. Stay at or
below **10000 ticks** (about 28 hours of game time). Measured in 0.1.0 with Node.js 22 and
its default heap limit (about 4 GB), seed `limit`:

| `--ticks` | Fault | Time | Peak memory (RSS) | Output | Exit |
| --- | --- | --- | --- | --- | --- |
| 360 | none | 0.4 s | 0.15 GB | 12 MB | 0 |
| 10000 | none | 8.7 s | 1.4 GB | 341 MB | 0 |
| 10000 | `disk_full` | 10.6 s | 1.8 GB | 454 MB | 0 |
| 30000 | none | 30 s | 3.9 GB | 1.0 GB | 0 |
| 30000 | `disk_full` | 49 s | 4.3 GB | 1.4 GB | 0 |
| 40000 | `disk_full` | 64 s | 4.5 GB | nothing | 134 |

The cost depends on the faults (`disk_full` and `slow_dependency` write the most). Past about
30000 ticks the process can run out of heap: Node.js aborts with
`FatalProcessOutOfMemory` on stderr, exit code 134, and stdout stays empty. Whether to lower
the accepted range or stream the output tick by tick is tracked in
[issue #24](https://github.com/jeffersonvalente/Whodeployed/issues/24).

### The 6 fault kinds

| Kind | What fails |
| --- | --- |
| `service_crash_loop` | Every instance of a service alternates between up and down. |
| `disk_full` | A database fills its disk; then writes fail. |
| `connection_pool_exhaustion` | A service leaks database connections until its pool runs out and callers wait. |
| `bad_deploy` | A bad version is deployed to some instances; their requests fail. |
| `slow_dependency` | A component becomes slow; its callers time out and retry, and a retry storm follows. |
| `cache_cold_start` | A cache restarts empty; misses fall through to the database until it warms up. |

The defaults are not repeated here, because they can change: `whodeployed-engine --help`
lists each kind with its default target, start tick and parameters, with their ranges.

Each kind with its defaults, 60 ticks (10 minutes), counting the lines written:

```sh
npx whodeployed-engine simulate --seed demo --ticks 60 --fault service_crash_loop | wc -l
npx whodeployed-engine simulate --seed demo --ticks 60 --fault disk_full | wc -l
npx whodeployed-engine simulate --seed demo --ticks 60 --fault connection_pool_exhaustion | wc -l
npx whodeployed-engine simulate --seed demo --ticks 60 --fault bad_deploy | wc -l
npx whodeployed-engine simulate --seed demo --ticks 60 --fault slow_dependency | wc -l
npx whodeployed-engine simulate --seed demo --ticks 60 --fault cache_cold_start | wc -l
```

The fault spec is `<kind>[:<key>=<value>[,<key>=<value>]...]`. The keys `target` (a component
name) and `startTick` (an integer >= 0) are reserved; any other key is a numeric parameter of
the kind. Repeat `--fault` to inject faults at the same time:

```sh
npx whodeployed-engine simulate --seed demo --ticks 60 --fault 'connection_pool_exhaustion:target=cart,startTick=5,poolSize=10' > pool.ndjson
npx whodeployed-engine simulate --seed demo --ticks 60 --fault connection_pool_exhaustion --fault service_crash_loop:target=catalog > two-faults.ndjson
```

An invalid invocation (unknown kind, missing `--seed`, bad `--ticks`, unknown target,
parameter out of range) prints the reason and the valid values to stderr, writes nothing to
stdout and exits with code 2.

### Output format

One JSON record per line. The `type` field is `metric`, `log`, `span` or `event`, and every
record has a `tick`:

```sh
npx whodeployed-engine simulate --seed demo --ticks 1 | head -n 3
```

```
{"type":"span","tick":0,"traceId":"t0r0","spanId":"t0r0s0","component":"gateway","instance":"gateway-2","operation":"http.request","kind":"server","startMs":0,"durationMs":25,"status":"ok"}
{"type":"span","tick":0,"traceId":"t0r0","spanId":"t0r0s1","parentId":"t0r0s0","component":"gateway","instance":"gateway-2","operation":"auth.verify","kind":"client","peer":"auth","startMs":2,"durationMs":6,"status":"ok"}
{"type":"span","tick":0,"traceId":"t0r0","spanId":"t0r0s2","parentId":"t0r0s1","component":"auth","instance":"auth-0","operation":"auth.verify","kind":"server","startMs":2,"durationMs":6,"status":"ok"}
```

| `type` | Fields |
| --- | --- |
| `metric` | `tick, component, instance?, rps, p50, p95, p99, errorPct, cpu, mem, connections` (no `instance` = component aggregate) |
| `span` | `tick, traceId, spanId, parentId?, component, instance, operation, kind, peer?, startMs, durationMs, status` |
| `log` | `tick, component, instance, level, message, traceId?, attrs?` (`level`: `debug`, `info`, `warn`, `error`) |
| `event` | `tick, kind, target, instance?, restart?, note?` (`kind`: `deploy` or `config`) |

Optional fields (`?`) are left out when absent, never written as `null`. Within a tick, lines
come in a fixed order: events, spans, logs, metrics. Nothing is sampled away: every span is in
the output, so you can recompute every request metric from the spans yourself.

### Same seed, same bytes

Run the same command twice: both lines print the same SHA-256. Change the seed and the hash
changes.

```sh
npx whodeployed-engine simulate --seed demo --ticks 120 --fault bad_deploy | sha256sum
npx whodeployed-engine simulate --seed demo --ticks 120 --fault bad_deploy | sha256sum
npx whodeployed-engine simulate --seed other --ticks 120 --fault bad_deploy | sha256sum
```

## Library usage

`createSimulation(config)` builds the world and simulates tick 0; `advance(n)` simulates the
next `n` ticks and returns their records. `ask(question)` reads the telemetry up to the
current tick and returns an `Answer`: `{ question, data, tickCost }`. Asking never changes the
simulation, and the same question at the same tick returns the same answer.

There are 6 questions, all available at any tick:

| `kind` | Question | `tickCost` |
| --- | --- | --- |
| `dashboard` | `{ service }`: aggregate metrics of a component over the last 30 ticks | 1 |
| `logs` | `{ service, window, filter? }`: log entries of the last `window` ticks, optionally filtered by field | 1 |
| `whatChanged` | `{ window }`: deploy and config events of the last `window` ticks | 1 |
| `trace` | `{ service, percentile: 50 \| 95 \| 99 }`: the request at that latency percentile in the current tick, with its whole span tree | 2 |
| `compare` | `{ service, metric, by: 'instance' \| 'lastWeek' }`: one series per instance, or this run against "last week": the same system without faults, with a seed derived from yours | 2 |
| `askNpc` | `{ role: 'dev' \| 'dba' \| 'oncall' }`: structured hints (component, metric, current vs. usual value), no prose | 3 |

`tickCost` is what the question costs in game time; the engine reports it and does not
advance the clock on its own. Invalid input (unknown service, fault kind or metric,
`window` < 1, ...) throws an `EngineError` whose `code`, `field` and `validValues` say what
is wrong.

In the install directory, this writes `example.mjs` and runs it:

```sh
cat > example.mjs <<'EOF'
import { createSimulation, defaultShop } from '@whodeployed/engine'

// The default shop with one fault: payment leaks database connections from tick 10 on.
const sim = createSimulation({
  system: defaultShop,
  seed: 'demo',
  faults: [
    {
      kind: 'connection_pool_exhaustion',
      target: 'payment',
      startTick: 10,
      params: { poolSize: 20, leakPerTick: 2, acquireTimeoutMs: 2000 },
    },
  ],
})

// Tick 0 is already simulated; advance 30 ticks (5 minutes of game time).
sim.advance(30)
console.log(`now: tick ${sim.world.tick}`)

const changed = sim.ask({ kind: 'whatChanged', window: 30 })
console.log(`whatChanged (cost ${changed.tickCost}): ${changed.data.events.length} deploy/config events`)

// Gateway latency over the last 10 ticks, this run against the same shop without faults.
const mean = (points) => Math.round(points.reduce((sum, p) => sum + p.value, 0) / points.length)
for (const metric of ['p50', 'p95']) {
  const { data, tickCost } = sim.ask({ kind: 'compare', service: 'gateway', metric, by: 'lastWeek' })
  const [now, usual] = ['current', 'lastWeek'].map((label) => mean(data.series.find((s) => s.label === label).points.slice(-10)))
  console.log(`compare gateway ${metric} (cost ${tickCost}): ${now} ms now, ${usual} ms last week`)
}

// The gateway request at p95 in the current tick, with its whole span tree.
const { data: trace, tickCost } = sim.ask({ kind: 'trace', service: 'gateway', percentile: 95 })
console.log(`trace gateway p95 (cost ${tickCost}) at tick ${trace.tick}:`)
for (const span of trace.spans) {
  console.log(`  ${span.component} ${span.operation} ${span.durationMs} ms ${span.status}`)
}
EOF
node example.mjs
```

It prints:

```
now: tick 30
whatChanged (cost 1): 0 deploy/config events
compare gateway p50 (cost 2): 35 ms now, 39 ms last week
compare gateway p95 (cost 2): 1349 ms now, 92 ms last week
trace gateway p95 (cost 2) at tick 30:
  gateway http.request 2090 ms ok
  gateway auth.verify 8 ms ok
  auth auth.verify 8 ms ok
  auth session.get 1 ms ok
  redis session.get 1 ms ok
  gateway catalog.list 12 ms ok
  catalog catalog.list 12 ms ok
  catalog cache.get 2 ms ok
  redis cache.get 2 ms ok
  gateway payment.checkout 2068 ms ok
  payment payment.checkout 2068 ms ok
  payment db.acquire 1969 ms ok
  payment db.insert 4 ms ok
  postgres db.insert 4 ms ok
  payment queue.publish 4 ms ok
  queue queue.publish 4 ms ok
```

Nothing was deployed, and the gateway's median looks normal, but its p95 is 15 times last
week's. The slow request spends almost all of its 2 seconds in `payment` waiting for a
database connection (`db.acquire`), two hops away from the gateway. None of this is scripted:
change the seed, the target or the parameters and the numbers change with them, still
consistent with each other.

Other exports: `simulate(config, ticks)` returns the records of ticks `[0, ticks)`;
`toNdjson(records)` serializes them exactly as the CLI does; `resolveFaults(inputs, world)`
fills a partial fault (`{ kind }`) with the catalog defaults; `faultCatalog` and `faultKinds`
describe the 6 kinds. The types (`World`, `Fault`, `Question`, `Answer`, `Action`, `Signal`
and the record types) are exported too.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter ./packages/engine lint
pnpm --filter ./packages/engine typecheck
pnpm --filter ./packages/engine test
pnpm --filter ./packages/engine build
node packages/engine/dist/cli/main.js simulate --seed qa --fault slow_dependency --ticks 60 | node packages/engine/scripts/verify-coherence.mjs
```

`node packages/engine/dist/cli/main.js` runs the built CLI inside the repository; it is the
same code the tarball ships. `scripts/verify-coherence.mjs` is an independent checker that
reads NDJSON and recomputes every request metric from the spans, without importing the
engine.

## License

Apache-2.0. See `LICENSE`.
