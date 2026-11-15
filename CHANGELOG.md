# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-11-15

Patch: concurrency semantics of object invariants.

Published to GitHub Packages as `@bejiihiu/design-contracts` (registry `https://npm.pkg.github.com`); see [getting-started.md](./docs/getting-started.md#installation) for the `.npmrc` setup.

### Fixed

- `contractObject()` — an in-flight async method no longer suspends invariant checks for external property writes. Method scope (AsyncLocalStorage-backed) tracks "inside a wrapped method" per async chain instead of one shared `methodDepth` counter for the whole wrapper: writes via `this` inside a method still defer to the post-settle check, while writes from outside the method chain — even while the method is awaiting — are checked immediately. On runtimes without `AsyncLocalStorage`, the wrapper falls back to a synchronous-only suppression (best effort, documented).
- Regression suite added covering external writes during pending async methods, nested wrapped calls, concurrent async methods on one object, and independence of multiple wrapped objects.

### Migration

Patch release; no API or behavior changes outside the fix above.

[1.0.1]: https://github.com/bejiihiu/node-contracts/releases/tag/v1.0.1

## [1.0.0] - 2026-11-15

First stable release.

Published to GitHub Packages as `@bejiihiu/design-contracts` (registry `https://npm.pkg.github.com`); npmjs is not published yet. GitHub Packages requires authentication even for public packages — see [getting-started.md](./docs/getting-started.md#installation) for the `.npmrc` setup.

### Added

- `contract()` — wraps any function or method with preconditions, postconditions, and on-error contracts. Works for sync and async functions; postconditions observe the resolved value, never a raw promise.
- `contractObject()` — object and class invariants, enforced via a `Proxy` at three boundaries: creation, method settlement, and direct property writes.
- `assert()` / `assert.fail()` — truthiness assertions for internal claims, with an `asserts condition` signature for type narrowing.
- Named conditions and composition: `condition()`, `all()`, `any()`, `not()`, `isNamedCondition()` — predicates normalize once at contract-creation time; composite failures compose into a JSON-safe `ConditionFailure` tree readable via `lastFailure`.
- `old` — pre-call value snapshots (array form by parameter name, or function form returning a record), exposed to postconditions as `context.old`.
- Stage 3 (TC39 standard) decorators: `@contractMethod(options)` for methods, accessors, and arrow-function fields, with contracts merged automatically across subclasses.
- Liskov inheritance rules for contracts: preconditions merge by disjunction (a base precondition can only get easier to satisfy), postconditions and on-error contracts union base-first (they can only get stricter). `mergeContractOptions()` and `mergeClassContracts()` for the manual path.
- Five enforcement modes — `strict`, `warn`, `silent`, `audit`, `off` — configurable globally (`configure()`), per scope (`withConfig()`, AsyncLocalStorage-backed), or per contract. `audit` delivers structured `AuditRecord`s to telemetry without changing control flow; `silent` and `off` skip predicates entirely rather than evaluating and swallowing them.
- Telemetry adapters: pino, winston, OpenTelemetry (span events), `node:diagnostics_channel`, and console — plus adapter factories for audit records. No dependencies beyond the package itself.
- Compile-time elimination: a single bundler define (`__DESIGN_CONTRACTS_ENABLED__: false`) turns every check into a no-op for production bundles.
- Dual ESM and CommonJS builds with full TypeScript type definitions for both.
- Zero runtime dependencies.

### Fixed

- Audit records now include `durationMs` (time from wrapper entry to the violation point).
- Async predicates inside `all`/`any`/`not` are awaited on the async path, including predicates hidden inside composites used in pre/post/on-error sections.
- `@contractMethod` resolves the base-class contract merge at call time, so decorated overrides work correctly regardless of class-evaluation and initialization order.
- `assert()` now follows the enforcement modes and the `assertion` disabled category: a no-op under `off`/`silent`/`disabled: ['assertion']`, a handler report without a throw under `warn`, and an `AuditRecord` with `kind: 'assertion'` under `audit`.

### Migration

First stable release; nothing to migrate.

[1.0.0]: https://github.com/bejiihiu/node-contracts/releases/tag/v1.0.0
