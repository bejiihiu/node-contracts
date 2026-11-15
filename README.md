# design-contracts

**Design by Contract for JavaScript and TypeScript.**

design-contracts checks the promises your code makes to itself while the program is running, right next to the business logic it describes: preconditions on inputs, postconditions on results, invariants on objects and classes, and assertions for the assumptions that cannot be expressed any other way. Conditions can look back at values from before the call, and contracts respect the Liskov substitution principle, so an override can weaken a precondition or strengthen a postcondition — never the reverse.

[![package](https://img.shields.io/badge/package-v1.0.0-0066CC)](https://github.com/bejiihiu/node-contracts/packages)
[![CI](https://github.com/bejiihiu/node-contracts/actions/workflows/ci.yml/badge.svg)](https://github.com/bejiihiu/node-contracts/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green)](https://github.com/bejiihiu/node-contracts/blob/main/LICENSE)

## What it does

- Preconditions, postconditions, and on-error contracts for any function or method, sync and async
- Named conditions and reusable building blocks — all, any, not — that compose failures into readable trees
- Object and class invariants, verified on construction, after every method call, and on direct property writes
- Stage 3 (TC39 standard) decorators for classes, with contracts merged automatically in subclasses
- Liskov inheritance rules for contracts: a base precondition disjoins (it can only get easier to satisfy), postconditions and on-error contracts union (they can only get stricter), and base-class invariants always hold
- Snapshots of pre-call values (the old store), so a postcondition can say "the balance decreased by exactly the withdrawn amount"
- Five enforcement modes — strict, warn, silent, audit, off — global, scoped, or per contract
- Compile-time elimination: a single build-time flag turns every check into a no-op for production bundles
- Zero runtime dependencies, a dual ESM and CommonJS build, and complete TypeScript type definitions
- Typed errors you can catch by kind, and adapters for pino, winston, OpenTelemetry, node:diagnostics_channel, and the console

## Not types, not Zod — on purpose

TypeScript's static types describe shapes at compile time, and validators like Zod check data at the boundary — both are excellent at what they do, and neither can see inside your own functions at runtime. Contracts fill that gap: they verify behavior where types cannot reach and where an invalid state would otherwise propagate silently. Use all three layers together — types at the compiler, schemas at the edges, contracts inside. See [concepts](https://github.com/bejiihiu/node-contracts/blob/main/docs/concepts.md) for the full rationale and [the FAQ](https://github.com/bejiihiu/node-contracts/blob/main/docs/faq.md) for common questions.

## Installation

The package is published on GitHub Packages as `@bejiihiu/design-contracts`, not on npmjs yet. GitHub Packages requires authentication even for public packages, so installing it involves a one-time `.npmrc` configuration for the `@bejiihiu` scope plus a token with `read:packages` (or the built-in `GITHUB_TOKEN` in CI). Step-by-step instructions including the `.npmrc` configuration live in [getting-started](https://github.com/bejiihiu/node-contracts/blob/main/docs/getting-started.md). The package runs on Node.js 18 or later and on Bun, ships both ESM and CommonJS builds, and includes type definitions for both.

## Enforcement modes

Contracts should not be an all-or-nothing decision. Every contract can run in one of five modes, configurable globally, per scope, or per contract — so you can roll contracts out to a critical service without gambling on day one.

| Mode   | Behavior                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| strict | A violated condition throws a typed error. This is the default outside production.                                             |
| warn   | The violation is reported through your handler (or the console) and execution continues.                                       |
| silent | Predicates are not executed at all; violations are dropped.                                                                    |
| audit  | Predicates run and violations are delivered as structured records to your telemetry, but nothing throws. Built for production. |
| off    | Checks are disabled entirely; predicates are never called, so disabled code costs nothing.                                     |

The [modes documentation](https://github.com/bejiihiu/node-contracts/blob/main/docs/modes.md) covers each one in depth, including rollout recipes and per-contract overrides.

## Performance, honestly

Contracts are not free — every checked call pays for the wrapper and for the conditions you attach, and snapshots in particular cost a copy per call. Whether that matters depends on where the contract lives: a check on a payment authorization is noise; a check in a tight inner loop may not be. The published methodology, measured numbers for the current release, and candid caveats are in [benchmarks](https://github.com/bejiihiu/node-contracts/blob/main/docs/benchmarks.md). Measure your own hot paths before wrapping them.

## Documentation

| Page                                                                                              | What it covers                                                                 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Getting started](https://github.com/bejiihiu/node-contracts/blob/main/docs/getting-started.md)   | Install, first contract, what happens on a violation                           |
| [Concepts](https://github.com/bejiihiu/node-contracts/blob/main/docs/concepts.md)                 | The philosophy — contracts vs validation, when to use each                     |
| [API reference](https://github.com/bejiihiu/node-contracts/blob/main/docs/api.md)                 | Complete API reference — contracts, conditions, assertions, decorators, config |
| [Errors](https://github.com/bejiihiu/node-contracts/blob/main/docs/errors.md)                     | The error hierarchy, message format, and writing handlers                      |
| [Modes](https://github.com/bejiihiu/node-contracts/blob/main/docs/modes.md)                       | The five enforcement modes in depth, plus rollout recipes                      |
| [Inheritance](https://github.com/bejiihiu/node-contracts/blob/main/docs/inheritance.md)           | Liskov rules, precondition disjunction, postcondition union                    |
| [Async](https://github.com/bejiihiu/node-contracts/blob/main/docs/async.md)                       | Async contracts, async predicates, thenables, concurrency                      |
| [Object contracts](https://github.com/bejiihiu/node-contracts/blob/main/docs/object-contracts.md) | Invariants for objects and classes via proxies                                 |
| [Adapters](https://github.com/bejiihiu/node-contracts/blob/main/docs/adapters.md)                 | pino, winston, OpenTelemetry, diagnostics_channel, and the console             |
| [Benchmarks](https://github.com/bejiihiu/node-contracts/blob/main/docs/benchmarks.md)             | Methodology, measured overhead, honest caveats                                 |
| [Migration](https://github.com/bejiihiu/node-contracts/blob/main/docs/migration.md)               | Adding contracts to three critical functions in fifteen minutes                |
| [FAQ](https://github.com/bejiihiu/node-contracts/blob/main/docs/faq.md)                           | Frequent questions — production safety, Zod, minification, decorators          |
| [Documentation index](https://github.com/bejiihiu/node-contracts/blob/main/docs/index.md)         | The full documentation index                                                   |

Runnable, numbered examples covering the same ground live in [examples/README.md](https://github.com/bejiihiu/node-contracts/blob/main/examples/README.md) — they run end to end and print what they do.

## Standard track

Design by Contract is being pursued for ECMAScript standardization through the TC39 process; the Stage 0 proposal, the prior-art survey, and the reference model live in [proposal-design-by-contract](https://github.com/bejiihiu/proposal-design-by-contract). The library doubles as the proposal's reference implementation.

## When not to use this

If all you need is to validate external input — a request body, a configuration file, a third-party payload — a schema validator is the right tool, and design-contracts will not replace it. Contracts pay off where an invariant can be stated precisely and cheaply, inside code you own; they are a poor fit for expensive checks, for one-off scripts, and for teams without a habit of writing down assumptions. If you are new to Design by Contract, start with audit mode on a few critical functions and see what it reports — a full-coverage rollout is rarely the right first step.

## Contributing

Bug reports and feature requests go through the [GitHub issue tracker](https://github.com/bejiihiu/node-contracts/issues), and the [contributing guide](https://github.com/bejiihiu/node-contracts/blob/main/CONTRIBUTING.md) covers the development flow, testing, and release process. If you found a security issue instead, please follow [SECURITY.md](https://github.com/bejiihiu/node-contracts/blob/main/SECURITY.md) rather than opening a public issue.

## Status

design-contracts 1.0.0 is a stable release. The public API follows semver, and breaking changes — when they happen — are documented with a migration path in [migration.md](https://github.com/bejiihiu/node-contracts/blob/main/docs/migration.md). Changes are listed in [CHANGELOG.md](https://github.com/bejiihiu/node-contracts/blob/main/CHANGELOG.md).

## License

MIT — see [LICENSE](https://github.com/bejiihiu/node-contracts/blob/main/LICENSE).
