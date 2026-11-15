# FAQ

## Is it safe to leave contracts in production?

Yes — that is the design. Predicates should be cheap and side-effect free, and three production strategies exist:

- `audit` mode: predicates run, nothing throws, you get an `AuditRecord` per violation. This is the intended production posture.
- `NODE_ENV=production` defaults to `off` automatically (unless `NODE_CONTRACTS_MODE` overrides).
- Compile-time define (`__DESIGN_CONTRACTS_ENABLED__: false`) strips the checks from your bundle entirely (behavior-wise guaranteed; physical removal depends on your minifier).

`assert()` plays by the same rules — under `off`/`silent` (or `disabled: ['assertion']`) it is a no-op, under `warn` it reports without throwing, under `audit` it emits a record with `kind: 'assertion'`.

What you should not do is run `strict` in production and catch the violations somewhere upstack to "handle" them — at that point the contract is acting as validation, not as a contract.

## How does this relate to Zod? Do I migrate my schemas?

No. Different layers:

- **Zod (or Valibot, ArkType)**: boundary validation — untrusted input in, typed value out, once.
- **design-contracts**: internal promises — enforced on every call, in production if you want, forever.

Use both. Zod proves the request body is a well-formed `CreateUser`; the contract proves `ledger.post()` never goes negative. If you delete Zod because "we have contracts now", you have deleted your boundary; if you delete contracts because "we have Zod", your invariants are enforced nowhere except the tests you wrote.

## How much overhead do contracts add on hot paths?

On synthetic micro-benchmarks, 22–32x against a ~50ns baseline (i.e. microseconds per million calls), ~7–8x on async contracts, and ~25x for `contractObject`. `off`/`silent` add ~10x under the benchmark harness (less on a real dist build), and compile-time define removes the check cost entirely. See [benchmarks.md](./benchmarks.md) — and benchmark your own hot path before deciding. If a function is called 10M times per second and does trivial arithmetic, don't contract it; if it does an I/O roundtrip, the overhead is noise.

## Does this work under minification?

Yes, with one sharp edge: **`old: ['paramName']` (array form) resolves parameter names via `fn.toString()`**, and minification rewrites those names. In a minified production build the snapshot will be empty or partial (you will get a one-time `console.warn` per unresolvable name saying to use the function form).

The fix is the function form: `old: (args) => ({ balance: args[0].balance })`. It never depends on names. Rule of thumb: **array form for dev and server-side unminified code, function form for anything that ships minified**. This is the single most common source of confusion with `old`.

## Do native decorators work? TypeScript? Bun? Node?

`@contractMethod` targets TC39 Stage 3 decorators:

- **TypeScript >= 5.0**: supported natively with `target: "ES2022"+`. Do **not** set `experimentalDecorators` — that enables the legacy semantics this library does not support.
- **JavaScript engines**: Stage 3 decorators are supported by V8-based runtimes when configured (e.g. modern Node with type stripping, or Bun), and everywhere via a transpiler. The library call path itself does not depend on decorators at all — `contract()` works everywhere.
- **Bun**: `bun run examples/04-class-contracts.ts` runs native Stage 3 decorators directly.
- **Legacy decorators**: if your project is pinned to `experimentalDecorators`, use `contract()` wrappers and `mergeClassContracts()` instead.

## Does it work in the browser?

The core (`contract`, `contractObject`, conditions, `assert`) is plain JavaScript and runs anywhere. Two Node-specific caveats:

- `node:diagnostics_channel` (used by `diagnosticsChannelAdapter`) is Node-only — on other runtimes the adapter throws a descriptive error at creation by design. Everything else in the adapters layer works anywhere (pino/winston are libraries, not Node APIs).
- The config layer uses AsyncLocalStorage when available and falls back to a synchronous scope stack otherwise (scopes will not survive `await` on the fallback). Node >= 18 and Bun are the supported targets; "browser support" is incidental, not a guarantee.

## Does SSR change anything?

No. SSR is just "your modules run in a server process" — contracts behave identically. If you share isomorphic code between server and browser, contracts run in both; if you want them server-only, gate with `NODE_ENV`-driven config or the compile-time define. Nothing about React/Next/Remix needs special handling.

## Can I use this as my validation library?

Please don't. Contract violations in `strict` mode are bugs, not user input problems; their messages are operator-facing. If the user typed a bad email, they should get a friendly form error from your schema validator — not a `PreconditionViolationError` from a shared module, and not a 500 from an HTTP boundary. Boundary validates, contract verifies.

## What happens to predicate exceptions?

They propagate, unwrapped. If `pre` throws `new Error('db down')`, you get exactly that error, not a violation error. Predicates are userland code; masking their failures inside violation machinery would hide the real bug. This holds for composites and for async predicates.

## Why did my async predicate make the contract pass everything?

It didn't — it threw a `TypeError`, or it was awaited. The historical confusion is truthy thenables: a promise always looks truthy, so an un-awaited async predicate would vacuously "pass". The library detects thenables from predicates and awaits them; on a synchronous call path it throws `TypeError` instead of allowing the vacuous pass. If you see flaky behavior, check whether your wrapped function is actually async (an `async` keyword or a thenable return) — a synchronous function with an async predicate always throws.

## How do contracts interact with inheritance?

A subclass cannot dodge or strengthen its base class's contract: preconditions merge by disjunction (`ALL(base) OR ALL(derived)`), postconditions and on-errors union (base first). Decorators merge at call time; manual prototype wrapping uses `mergeClassContracts()`. Details and the full truth table in [inheritance.md](./inheritance.md).

## Is `withConfig()` safe under concurrency?

Yes, on runtimes with AsyncLocalStorage (Node >= 18, Bun). Each async flow sees its own scope; sibling flows and nested scopes never leak modes into each other. A configuration set during an in-flight call does not affect that call (snapshot semantics).

## Can I add contracts to an existing codebase incrementally?

Yes — that is the whole point of the modes. Wrap three risky functions in `audit` mode, watch the telemetry, promote winners to `strict`. See [migration.md](./migration.md) for the 15-minute version.
