# Modes

`design-contracts` has five enforcement modes. They are the main lever for adopting contracts without breaking production, and this page covers them in depth.

## Reference table

| Mode     | Predicates run? | On violation                        | Handlers called?                             | Typical use                                |
| -------- | --------------- | ----------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `strict` | yes             | throw the violation error           | no                                           | development, CI, critical paths            |
| `warn`   | yes             | report, continue execution          | `onViolation` (else one-line `console.warn`) | staging, gradual rollout                   |
| `silent` | **no**          | nothing — completely ignored        | no                                           | emergency kill switch, zero predicate cost |
| `audit`  | yes             | emit an `AuditRecord`, continue     | `onAudit` (and `onViolation` if set)         | production telemetry                       |
| `off`    | **no**          | nothing — bare `fn.apply` fast path | no                                           | production with compile-time define        |

The one non-obvious property: **`silent` and `off` do not evaluate predicates.** "Skip" means skip — no wasted work and no accidental side effects inside predicates. Contrast with "evaluate, catch, swallow", which is strictly worse and is deliberately not how this library behaves.

`assert()` / `assert.fail()` play by the same rules: under `off`/`silent` (or with `disabled: ['assertion']`) they are no-ops — nothing throws and no handler runs; under `warn` the failure is reported to `onViolation` without throwing; under `audit` it is emitted as an `AuditRecord` with `kind: 'assertion'`; only `strict` throws.

## Setting the mode

Three layers, highest priority first:

```ts
import { contract, withConfig, configure } from 'design-contracts';

const fn = contract(impl, { mode: 'warn' }); // 1. per-contract

withConfig({ mode: 'audit' }, () => fn()); // 2. scoped (ALS)

configure({ mode: 'strict' }); // 3. global
```

…and below the global layer, the environment:

- `NODE_CONTRACTS_MODE=warn` — trimmed, lowercased; unknown values fall back to `strict` with a one-time `console.warn`.
- otherwise `NODE_ENV === 'production'` → `off`; anything else → `strict`.

Per-contract `mode` only ever overrides the **mode** — handlers and `disabled` come from the outer layers. `disabled` is a union across all layers: an inner scope can add disabled categories but cannot re-enable an outer-disabled one.

## `strict` — fail fast

The default. A violation throws; a precondition failure prevents the body from running; a postcondition failure replaces the return value with a throw.

```ts
import { contract, PreconditionViolationError } from 'design-contracts';

const divide = contract((a: number, b: number) => a / b, {
    pre: [(_a, b) => b !== 0],
});

divide(10, 0); // throws PreconditionViolationError; body never ran
```

Use in tests, CI, and any path where a violated promise means "stop everything".

## `warn` — report and continue

```ts
import { configure, contract, resetConfig } from 'design-contracts';

resetConfig();
configure({
    mode: 'warn',
    onViolation: (error) => logger.warn({ err: error.toJSON() }, error.message),
});

divide(10, 0); // logs; returns Infinity
```

Without `onViolation`, the library writes a compact single line to `console.warn`:

```
[design-contracts] precondition violation in divide / divide (condition #0): ...
```

`warn` is your rollout mode: you get signal on real traffic without risking an outage from a false positive. Cost note: `warn` evaluates predicates exactly like `strict` — it is not a "free" mode, it is `strict` with a different dispatch on violation.

### Rollout recipe

1. Ship critical-path contracts in `warn` with structured logging.
2. Alert on `kind: 'postcondition'` / `'invariant'` spikes; ignore one-off noise.
3. Fix or tighten the contracts; flip to `strict` once the false-positive rate is zero.

## `silent` — the kill switch

Violations are ignored; **predicates are not evaluated at all**. This is not "swallow the throw" — the wrapper short-circuits before reaching any predicate, so silent mode is nearly as fast as `off`.

```ts
configure({ mode: 'silent' });
```

Use when you need a runtime off-switch without redeploying, or while hunting a predicate with a bug in it.

## `audit` — production telemetry without control flow changes

Predicates run; thrown errors are converted into structured records; execution continues no matter what. This is the mode nobody else ships — it is the intended way to run DbC permanently in production.

```ts
import { configure, resetConfig } from 'design-contracts';

resetConfig();
configure({
    mode: 'audit',
    onAudit: (record) => {
        telemetry.increment('contract_violations', {
            kind: record.kind,
            contract: record.contractName,
        });
    },
    // optional — receives the same error object as warn mode
    onViolation: (error) => alerting.captureException(error),
});
```

An `AuditRecord` looks like:

```json
{
    "kind": "postcondition",
    "message": "Postcondition violated: fetchUser (condition #0)",
    "timestamp": 1731571200000,
    "mode": "audit",
    "contractName": "fetchUser",
    "functionName": "fetchUser",
    "conditionIndex": 0,
    "durationMs": 3
}
```

`durationMs` measures from wrapper entry to the violation point (including the function call and any prior phases). If neither `onAudit` nor `onViolation` is set, records are **dropped silently** — the library keeps no hidden global log by design.

Handler exceptions are caught and written to `console.error`; audit can never break business logic. Postconditions in `audit` mode still cannot "fail" the call — the violation is recorded and the resolved value is handed to the caller as-is.

### Audit recipe

1. Deploy with `audit` + `onAudit` wired to your metrics backend (or `diagnosticsChannelAuditAdapter()` — see [adapters.md](./adapters.md)).
2. Watch the counters. A contract firing often means one of two things: a real bug, or a wrong contract.
3. Fix, then promote to `strict` per contract (`contract(fn, { mode: 'strict' })`) — you do not have to flip the whole process at once.

## `off` — production with zero check cost

Predicates are not evaluated; wrappers take a bare `fn.apply(this, args)` fast path (one `isContractsCompiledIn()` check and one resolved-config read away from the raw call). Combined with a **compile-time define**, the checks fold away even in the emitted bundle — see [api.md](./api.md#iscontractscompiledin--compile-time-disabling).

```ts
configure({ mode: 'off' });
```

`NODE_ENV=production` already defaults to `off` when `NODE_CONTRACTS_MODE` is unset, so a stock Node service in production pays almost nothing by default.

## Per-contract mode

`mode` on `ContractOptions` wins over everything except the compile-time flag:

```ts
const fragile = contract(impl, { mode: 'strict' }); // always strict, even under configure({ mode: 'off' })
const noisy = contract(impl, { mode: 'warn' }); // always warn
```

## Scoped mode with `withConfig`

`withConfig` applies a mode to a dynamic extent, including async continuations:

```ts
import { withConfig } from 'design-contracts';

const rows = await withConfig({ mode: 'audit', onAudit: ship }, async () => {
    const data = await load(); // contracts inside see audit mode
    await enrich(data); // across awaits, too
    return data; // scope ends here
});
```

Nested scopes compose outer→inner; inner wins per field. The config is snapshotted on entry. Concurrent async work under different scopes does not leak into each other (AsyncLocalStorage).

## Mixing modes deliberately

A healthy production setup is usually layered:

```ts
configure({ mode: 'audit', onAudit: ship }); // default: observe everything

const reconcile = contract(reconcileImpl, { mode: 'strict' }); // this one is proven — keep it loud
const legacyCharge = contract(chargeImpl, { mode: 'silent' }); // legacy path, known-noisy contract
```

## Mode resolution cheat sheet

For one specific call, the effective mode is:

```
contract(fn, { mode })  >  withConfig scope  >  configure() global  >  env
```

The effective `disabled` set is the **union** of every layer. `captureStack` resolves innermost-defined-wins, as do `onViolation`/`onAudit`/`defaultMessage`.
