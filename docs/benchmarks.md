# Benchmarks

Honest numbers for what contracts cost. No "zero-cost abstractions" marketing — here is how the measurement was done and what to make of it.

## How to run them

```sh
bun run bench
```

`bench` runs `vitest bench --passWithNoTests --reporter=verbose` over `benchmarks/contract.bench.ts`. Scenarios are grouped `describe → one test → N awaited bench.run()` (ops/sec printed per line). Benchmarked in both environments: **Node 24.2.0** (`npx vitest bench`) and **Bun 1.4.2** (`bun run bench`).

## Methodology

- **Tooling**: vitest 5's built-in benchmark mode (tinybench underneath). Each scenario is a trivial standalone function — `add`, `multiply`, and friends — so the measured delta is the wrapper + predicate cost, not domain logic.
- **Scenarios**: plain call · 1 precondition · 3 preconditions · pre + post ("typical") · pre + post + `old` snapshot (array form) · `off` mode · `silent` mode · `warn` mode · async baseline vs async contract · `contractObject` with an invariant vs plain method · throwing function with and without `onError`.
- **Dist build not benchmarked.** Numbers below are against sources loaded through the vitest module-runner.

## Results — Node 24.2.0 (`npx vitest bench`)

| Scenario                                | ops/sec | vs plain     |
| --------------------------------------- | ------- | ------------ |
| plain call                              | 12.35M  | 1x           |
| contract, 1 pre                         | 565.4k  | ~22x slower  |
| contract, 3 pre                         | 388.3k  | ~32x slower  |
| contract, pre + post                    | 433.7k  | ~29x slower  |
| contract, pre + post + old (array form) | 101.3k  | ~122x slower |
| contract, `off`                         | 1.217M  | ~10x slower  |
| contract, `warn`                        | 387.2k  | ~32x slower  |
| contract, `silent`                      | 1.336M  | ~9x slower   |
| async plain                             | 1.77M   | 1x           |
| async contract, pre + post              | 238.0k  | ~7.4x slower |
| plain method call                       | 6.38M   | 1x           |
| contractObject + invariant              | 254.7k  | ~25x slower  |
| plain throw                             | 29.4k   | 1x           |
| contract + onError (throwing fn)        | 16.0k   | ~1.8x slower |

## Results — Bun 1.4.2 (`bun run bench`)

| Scenario                                | ops/sec | vs plain     |
| --------------------------------------- | ------- | ------------ |
| plain call                              | 11.90M  | 1x           |
| contract, 1 pre                         | 497.5k  | ~24x slower  |
| contract, 3 pre                         | 352.2k  | ~34x slower  |
| contract, pre + post                    | 403.7k  | ~30x slower  |
| contract, pre + post + old (array form) | 100.2k  | ~119x slower |
| contract, `off`                         | 1.039M  | ~11x slower  |
| contract, `warn`                        | 336.3k  | ~35x slower  |
| contract, `silent`                      | 1.054M  | ~11x slower  |
| async plain                             | 1.80M   | 1x           |
| async contract, pre + post              | 218.7k  | ~8.2x slower |
| plain method call                       | 6.42M   | 1x           |
| contractObject + invariant              | 233.3k  | ~27x slower  |
| plain throw                             | 26.6k   | 1x           |
| contract + onError (throwing fn)        | 15.5k   | ~1.7x slower |

## Read these numbers the honest way

1. **Upper bounds, not predictions.** The vitest module-runner adds cross-module getter overhead (it interposes proxy getters on every module-export access — that is where most of the "1 pre costs 22x" lives). A compiled `dist` build resolves these once and is cheaper in absolute terms. Treat everything here as a pessimistic ceiling; `off` in particular is only this expensive _inside the benchmark harness_.
2. **Relative orderings are meaningful.** `off` ≈ `silent` < `warn` ≈ `strict`-like typical; `old` dominates everything (a `structuredClone` per call); async contracts cost proportionally less because promise machinery dwarfs the check.
3. **`off` is not free, and that surprised us.** The goal of "off ≈ ≤ 5x" was **not** reached — ~10–11x remains under the module-runner (one `getEffectiveConfig` + one flag read + a few `Set.has` before the bare call). Physical removal requires the [compile-time define](./api.md#iscontractscompiledin--compile-time-disabling); even then, physical removal requires a minifier that inlines the flag check at the call site (e.g. terser) — esbuild with `define` + treeshake folds the branch but does not remove the whole machinery from the bundle.
4. **`warn` ≈ `strict`.** Same predicate cost; the only difference is what happens on violation. Do not reach for `warn` expecting it to be cheap — it is `strict` with a softer landing.
5. **`onError` is free on the happy path.** With no error thrown, an `onError` contract is within noise of having none.
6. **Synthetic functions.** Real contracts on real functions are dominated by the function's own work. A 30x overhead on `add()` is a large fraction of basically nothing; on a 200 µs database call it is unmeasurable.

## Practical guidance

- Wrap domain/business logic, not loops. If a contract sits under a million-iteration inner loop, that is a design smell.
- Use `silent`/`off` (or the compile-time define) for release builds that must not pay anything.
- Use `audit` in production where the per-call cost is the same as `strict` — you are paying predicates either way; spend it where you get the telemetry.
- Avoid `old` on hot paths; prefer function-form `old` that snapshots scalars, not object graphs.
- Benchmark **your own** hot path with `bun run bench`-style micro-runs before adding contracts there. The only honest benchmark for your workload is yours.

## Why dist-build numbers would be better

Module-runner overhead scales with the number of module-export accesses per wrapped call (it is per property access, not per call). A bundled, minified `dist` resolves exports statically, so the wrapper's own work (one flag check, one config read, the predicates) is all that remains. If someone benchmarks `dist`, expect materially better absolute numbers — the relative ordering above should hold. If you need them, open an issue; benchmarking the published tarball is on the roadmap.
