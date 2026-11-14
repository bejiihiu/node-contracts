# API Reference

Complete reference for the `design-contracts` public API. Everything on this page is exported from the package root (`design-contracts`) unless noted otherwise; adapters and decorators are also available from the `design-contracts/adapters` and `design-contracts/decorators` subpath exports.

Small, focused guides: [object-contracts.md](./object-contracts.md) · [inheritance.md](./inheritance.md) · [async.md](./async.md) · [modes.md](./modes.md) · [adapters.md](./adapters.md) · [errors.md](./errors.md)

---

## `contract(fn, options?)`

Wraps `fn` in a contract. Returns a function with the same runtime shape and inferred TypeScript signature.

```ts
import { contract } from 'design-contracts';

const divide = contract(
    function divide(a: number, b: number): number {
        return a / b;
    },
    {
        name: 'divide',
        pre: [(_a, b) => b !== 0],
        post: [(result) => Number.isFinite(result)],
    },
);
```

### `ContractOptions`

| Field          | Type                               | Default                                  | Meaning                                                            |
| -------------- | ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `pre`          | `readonly ConditionPredicate<A>[]` | `[]`                                     | Preconditions, evaluated before `fn` runs, in declaration order    |
| `post`         | `readonly PostPredicate<A, R>[]`   | `[]`                                     | Postconditions, evaluated after `fn` settles, in declaration order |
| `onError`      | `readonly ErrorPredicate<A, R>[]`  | `[]`                                     | Error conditions, evaluated only when `fn` throws or rejects       |
| `old`          | `OldSpec`                          | —                                        | Pre-call snapshot of arguments, exposed to `post` as `context.old` |
| `name`         | `string`                           | `fn.name`, else `'anonymous'`            | Contract name used in violation messages and `ContractContext`     |
| `mode`         | `Mode`                             | — (resolved from config)                 | Per-contract enforcement mode override                             |
| `captureStack` | `boolean`                          | resolved `captureStack` (default `true`) | Capture a stack trace on violation errors                          |
| `message`      | `string`                           | —                                        | Fallback user message; see precedence below                        |

**Message precedence** when a violation is reported:

1. The named condition's own `message` (`condition(pred, { message })`)
2. `options.message`
3. The default message composed by the error classes

**Coerced truthiness.** Predicates may return any value; truthiness is interpreted via `Boolean(...)`. Return real booleans when you can. The one exception that always looks truthy is a thenable — which is why an async predicate in a synchronous call path throws a `TypeError` instead of silently passing (see [async.md](./async.md)).

**Fast path.** When the effective mode skips every category and no `old` snapshot is needed, the wrapper performs a bare `fn.apply(this, args)` — no predicate evaluation, no promise wrapping, no config-driven logging. Return values and rejection identity are passed through untouched.

**Preserved identity.** `fn.length` and `fn.name` are redefined on the wrapper. Overloaded functions collapse to the implementation signature the wrapper was created from.

### `ConditionPredicate`

```ts
type ConditionPredicate<A extends unknown[]> = NamedCondition<A> | ((...args: A) => unknown);
```

Named conditions are used as-is; bare predicates are normalized to named conditions **once**, at contract-creation time (never per call).

### `PostPredicate`

```ts
type PostPredicate<A extends unknown[], R> =
    | NamedCondition<[UnwrapPromise<R>, ContractContext<A, R>]>
    | ((result: UnwrapPromise<R>, context: ContractContext<A, R>) => unknown);
```

The first parameter is the **resolved** result — for `R = Promise<T>` the postcondition sees `T`, never the promise.

### `ErrorPredicate`

```ts
type ErrorPredicate<A extends unknown[], R> =
    | NamedCondition<[unknown, ContractContext<A, R>]>
    | ((error: unknown, context: ContractContext<A, R>) => unknown);
```

A falsy return means the failure itself broke its contract → `OnErrorViolationError`. A truthy return (or no `onError` configured) means the original error propagates untouched.

### `ContractContext`

Passed as the second argument to postconditions and on-error predicates.

| Field      | Present        | Meaning                                                                                                                 |
| ---------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `args`     | always         | **Live reference** to the argument tuple the wrapper was called with. Spread it (`[...args]`) if you need a stable copy |
| `contract` | always         | The contract's name (`options.name`, else `fn.name`, else `'anonymous'`)                                                |
| `function` | always         | The wrapped function's name (or `'anonymous'`)                                                                          |
| `self`     | always         | The `this` value of the call site (`undefined` for standalone calls)                                                    |
| `mode`     | always         | The effective enforcement mode for this call                                                                            |
| `result`   | `post` only    | The resolved result                                                                                                     |
| `old`      | `post` only    | The pre-call snapshot (only when `old` was configured _and_ `post` is non-empty _and_ postconditions are not skipped)   |
| `error`    | `onError` only | The error thrown/rejected by `fn`                                                                                       |

### Example: full pre/post/old/onError

```ts
import { contract } from 'design-contracts';

const charge = contract(
    async function charge(cardId: string, amountCents: number): Promise<Receipt> {
        return gateway.charge(cardId, amountCents);
    },
    {
        name: 'charge',
        pre: [(_cardId, amountCents) => Number.isInteger(amountCents) && amountCents > 0],
        post: [(receipt) => receipt.status === 'captured'],
        onError: [(error) => error instanceof GatewayError],
        old: ['amountCents'],
    },
);
```

See [examples/01-basic.ts](../examples/01-basic.ts) and [examples/03-old-values.ts](../examples/03-old-values.ts).

---

## `condition(predicate, options?)` — named conditions

A named condition is a reusable, self-describing predicate object. It carries a name and an optional message that surface in violation errors, plus a `lastFailure` record for programmatic inspection.

```ts
import { condition } from 'design-contracts';

const positive = condition((n: number) => n > 0, {
    name: 'positive',
    message: 'value must be positive',
});

positive.check(5); // true
positive.check(-1); // false
positive.lastFailure;
// { operator: 'condition', index: 0, conditionId: 'condition-1',
//   conditionName: 'positive', message: '...', cause: undefined, components: undefined }
```

- **Name resolution**: `options.name` → `predicate.name` → `'anonymous'`.
- **ID**: auto-assigned `condition-N` from a module-local monotonic counter, or set via `options.id` for stability across restarts.
- Named conditions are **not callable** — they carry a `check(...args): boolean` method. Predicates that throw propagate as-is (never wrapped, never swallowed).
- `check()` is synchronous. Composite conditions additionally expose `checkAsync(...args)` (see below) — used automatically when everything settles asynchronously.
- `lastFailure` is valid synchronously after a `false` result; for async settlement read it after `checkAsync()` / the async phase settles.

### `condition` options

| Field     | Type     | Meaning                                         |
| --------- | -------- | ----------------------------------------------- |
| `name`    | `string` | Display name used in errors and composite names |
| `message` | `string` | User-facing message (highest precedence)        |
| `id`      | `string` | Explicit stable id (instead of `condition-N`)   |

### `all(...conditions)` / `any(...conditions)` / `not(condition)`

Composites build bigger conditions out of smaller ones. They accept named conditions **and** bare predicates (normalized via `condition()`). The composite itself is a named condition with a readable generated name (e.g. `all(not blank, email shape)`).

```ts
import { all, any, not, condition, contract } from 'design-contracts';

const notBlank = condition((s: string) => s.trim().length > 0, { name: 'not blank' });
const trusted = all(notBlank, (s: string) => !s.includes('mailinator'));
```

Semantics:

- `all` — every child must pass. Short-circuits on the first `false`; `index` in `lastFailure` points at the failing child. `all()` with no children → `true`.
- `any` — at least one child must pass. Stop-on-first-pass for passing; on full failure, `index: -1` and `components` lists every child's failure. `any()` with no children → `false`.
- `not` — inverts its child. Fails (with `index: 0`) when the child unexpectedly passes.
- Nesting composes recursively; `cause` chains reference the failing child composite.
- Async children are awaited when the composite is evaluated through the async path — see [async.md](./async.md).

### `isNamedCondition(value)`

Type guard checking the realm-global `Symbol.for('design-contracts/named-condition')` brand (survives dual ESM/CJS loading) plus the expected shape:

```ts
import { isNamedCondition } from 'design-contracts';

isNamedCondition(positive); // true
isNamedCondition((n: number) => n > 0); // false
```

### `ConditionFailure`

`lastFailure` shape (all JSON-safe):

```ts
interface ConditionFailure {
    operator: 'condition' | 'all' | 'any' | 'not';
    index: number; // failing child index; -1 for any() full-failure
    conditionId: string; // id of the failing composite/leaf
    conditionName: string;
    message?: string;
    cause?: ConditionFailure; // chained child failure for composites
    components?: ConditionFailure[]; // per-child failures (any() only)
}
```

See [examples/05-composition.ts](../examples/05-composition.ts).

---

## `assert(condition, message?, context?)`

A truthiness assertion that throws `AssertionViolationError` when the condition is falsy. Unlike section predicates it is **not** tied to a call — use it anywhere you need "this must hold right now":

```ts
import { assert } from 'design-contracts';

function total(lines: readonly Line[]): number {
    assert(lines.length > 0, 'total() called with no lines', { caller: 'invoice-service' });
    return lines.reduce((sum, line) => sum + line.amount, 0);
}
```

- `assert.fail(message?, context?): never` — unconditionally throws `AssertionViolationError`. Useful as an "unreachable" marker.
- The assertion signature `asserts condition` narrows the type at the call site.
- `context` is passed through `sanitize()` — a record stays as-is; any other value is squashed into `{ value: ... }`; cycles and non-JSON values are replaced with safe markers. It never throws, regardless of what you pass.

---

## `contractObject(target, options?)` — object invariants

Wraps an object (or class instance) in a `Proxy` and enforces invariants at three boundaries: creation, method settlement, and direct property writes. Full guide: [object-contracts.md](./object-contracts.md).

```ts
import { condition, contractObject } from 'design-contracts';

const balanceNonNegative = condition((self: BankAccount) => self.balance >= 0, {
    name: 'balance non-negative',
});

const account = contractObject(new BankAccount('Ada', 100), {
    name: 'ada account',
    invariant: [balanceNonNegative],
});
```

- Options: `invariant` (readonly array, see `ObjectInvariant`), `name`, `mode` (per-object override), `captureStack`.
- Invariants are named conditions (`check(self)`) or bare predicates (`(self) => unknown`, truthy passes).
- Methods bound through the wrapper see `this === wrapper`; extracted methods keep working.
- Checked at `'<init>'`, on each method's settle, and at `'<set>'` for direct writes. Checks after **every** method, not "did it mutate" — deep-diffing was rejected by design.
- Nested objects are **not** wrapped. Class instances with `#private` fields do not work (private brand checks fail through the proxy).
- Invariant predicates must be pure reads. If one throws, the exception propagates unwrapped.

---

## `old` — pre-call snapshots

`old` declares which arguments to snapshot **before** `fn` runs. The snapshot is exposed to postconditions as `context.old` and is only taken when `old` is configured, `post` is non-empty, and postconditions are not skipped by the effective mode.

### Array form

```ts
{
    old: ['account', 'amount'],
    post: [(result, ctx) => result === (ctx.old?.['account'] as Account).balance - Number(ctx.old?.['amount'])],
}
```

Parameter names are resolved by **`fn.toString()` introspection**. This is best-effort: single-parameter arrow functions, parenthesized signatures, rest parameters (captured as the whole tail array), and destructured slots are all handled. Two consequences:

- **Minification breaks this form.** If your production build minifies parameter names, the snapshot comes back empty (or partially empty) and the library emits one `console.warn` per unresolvable name — per process, deduplicated. The warning tells you to switch to the function form.
- Use the **function form** for anything that ships to production minified. This is the single most important gotcha in the library.

### Function form

```ts
{
    old: (args) => ({
        balance: (args[0] as Account).balance,
        amount: args[1] as number,
    }),
}
```

The callback receives the raw argument array and returns a record. No implicit cloning is applied to what you return — do it yourself (`captureValue` is exported for exactly this). A non-record return (array, `null`, scalar) throws `TypeError`. Exceptions from the callback propagate as-is; they are userland code and are never wrapped.

### `captureValue(value)` / `isReferenceCapture(value)`

`captureValue` snapshots one value with a documented strategy:

| Value shape                                                        | How it is captured                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| Primitives, `symbol`, `undefined`, `bigint`                        | by value                                                 |
| Arrays, plain objects, `Map`, `Set`, `Date`                        | deep clone via `structuredClone` (cycles included)       |
| Functions                                                          | live reference, tagged in a `WeakSet`                    |
| Class instance containing a function member                        | live reference (clone would drop the function) + flagged |
| Plain object containing a function member                          | shallow `{ ...value }`, **not** flagged                  |
| Other non-cloneable graphs (DOM nodes, Proxies over hostile traps) | live reference + flagged                                 |

`isReferenceCapture(value)` returns `true` for values captured by live reference rather than by clone. It never throws.

### `snapshotArgs(fn, args, spec)`

The machinery behind `old`, exported for advanced use. Returns a fresh `Record<string, unknown>` per call. Missing names or out-of-range indices are skipped (with a one-time `console.warn` per key); total introspection failure yields `{}`.

---

## Merging contracts: `mergeContractOptions(base?, derived?)` and `mergeClassContracts(Derived, Base?, options?)`

For Liskov-style inheritance of contracts — the full story is in [inheritance.md](./inheritance.md). Summary of the rules:

- **Effective precondition** = `ALL(base.pre) OR ALL(derived.pre)` — one disjunction collected via `any(all(...base.pre), all(...derived.pre))`. A derived contract can relax, never strengthen, what base-typed callers rely on.
- **Effective postcondition** = `base.post ∪ derived.post` (base first) — every base postcondition still applies.
- **Effective onError** = `base.onError ∪ derived.onError` (base first).
- **`old` / `mode` / `name` / `captureStack` / `message`** = `derived ?? base`.

`mergeContractOptions` is pure and returns a new options object (or `undefined` when both sides are absent). `mergeClassContracts` rewraps `Derived.prototype[name]` with a merged `contract()` wrapper for every same-name method that carries contract metadata, walking the nearest-ancestor chain. Base and derived original wrappers are never mutated. Accessors (`get`/`set`) are skipped. Static members merge only with `{ statics: true }`.

```ts
import { contract, mergeClassContracts } from 'design-contracts';

mergeClassContracts(
    class Upper extends Lower {
        override save = function save(payload: string) {
            /* ... */
        };
    },
);
```

---

## Decorators: `@contractMethod(options?)`

Stage 3 (TC39 standard) decorators with the same options as `contract()`:

```ts
import { contractMethod } from 'design-contracts';

class Bank {
    @contractMethod({ pre: [(amount: number) => amount > 0] })
    deposit(amount: number): number {
        /* ... */
        return amount;
    }
}
```

Supported member kinds:

- **Methods** (instance and static) — full contract, `this` preserved, `fn.length`/`fn.name` preserved.
- **Getters** — `pre` is **forbidden** (a zero-argument member has nothing to check); passing `pre` throws `TypeError` at class-definition time. Use `post` to check the returned value.
- **Setters** — `pre` receives the assigned value: `pre: [(value) => typeof value === 'string']`.
- **Fields holding arrow functions** — wrapped per instance. Non-function field initializers throw `TypeError` at init time. Static arrow-function fields merge against the constructor chain.

Merge behavior (the reason these exist): when a derived member is decorated, the decorator lazily merges the nearest contract-carrying same-name member found walking up the chain — **at call time**, on the first call, then caches the merged wrapper on the decorator. No `addInitializer` ordering, no class-evaluation ordering, no engine differences. Private members are never merged; extracted members called on a foreign receiver fall back to their own contract only. See [inheritance.md](./inheritance.md).

TypeScript requirements: TypeScript >= 5.0, `target` ES2022+, Stage 3 decorators (no `experimentalDecorators`). See [getting-started.md](./getting-started.md#decorators-contractmethod).

---

## Configuration

Global, scoped, and per-contract configuration. Resolution order (highest priority first):

1. **Per-contract `mode`** — overrides only the mode, never handlers.
2. **`withConfig()` scope** — AsyncLocalStorage-backed; inherited by nested async continuations.
3. **`configure()` global** — merged on top of the environment defaults.
4. **Environment** — `NODE_CONTRACTS_MODE` (trimmed, lowercased, validated; unknown values fall back to `strict` with a one-time `console.warn`), else `NODE_ENV === 'production' ? 'off' : 'strict'`.

`disabled` is a **union across all layers** — an inner scope can add disabled categories but can never re-enable one disabled outer.

### `configure(config): ContractConfig`

Merges `config` into the global configuration and returns the **previous** global config (shallow copy) — convenient for save/restore in tests. `undefined` fields are treated as "not set" and do not clobber inherited values. Throws `TypeError` on invalid values (unknown mode/category, non-function handlers, non-boolean `captureStack`, non-string `defaultMessage`).

```ts
import { configure, resetConfig } from 'design-contracts';

configure({
    mode: 'warn',
    onViolation: (error) => logger.warn({ err: error }, error.message),
    onAudit: (record) => logger.info({ record }, record.message),
    disabled: ['postcondition'],
    captureStack: false,
    defaultMessage: 'contract breached',
});
```

### `getConfig(): ContractConfig`

Returns a shallow copy of the current global configuration (environment defaults are not materialized into it).

### `resetConfig(): ContractConfig`

Clears the global configuration back to environment-driven resolution and returns the configuration that was in place. Intended for tests. Scoped `withConfig()` frames are unaffected — they end when their callback returns.

### `withConfig(config, fn): R`

Runs `fn` with `config` applied for its dynamic extent — including across `await`s, thanks to AsyncLocalStorage. The config is snapshotted on entry (mutating your object afterwards has no effect). Nested `withConfig` calls layer outer→inner; inner wins per field. Throws if the ambient runtime has no AsyncLocalStorage and the fallback sync stack is exhausted (only a concern on exotic runtimes without `node:async_hooks`).

```ts
import { withConfig } from 'design-contracts';

const result = withConfig({ mode: 'audit', onAudit: ship }, () => charge(card, 100));
```

### Handler failure semantics

In `warn` and `audit` modes, exceptions thrown **by** your handlers are caught and written to `console.error`. Handler failures never change control flow — a broken logger cannot break your business logic. In `strict` mode no handlers run at all.

---

## Enforcement modes

| Mode     | Predicates executed? | On violation                                                              | Use for                                |
| -------- | -------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `strict` | yes                  | throws the violation error; `fn` not called on pre-failure                | development, CI, critical paths        |
| `warn`   | yes                  | reports to `onViolation` (or one-line `console.warn`) and continues       | gradual rollout, staging               |
| `silent` | **no**               | ignored completely                                                        | kill switch with zero predicate cost   |
| `audit`  | yes                  | emits an `AuditRecord` to `onAudit` (and `onViolation` if set), continues | production telemetry                   |
| `off`    | **no**               | nothing — `fn.apply` fast path                                            | production with compile-time stripping |

`canSkip` semantics: `silent` and `off` short-circuit **before any predicate runs** — it is not "evaluate and swallow". An `onViolation`/`onAudit` that is not configured simply drops the record; the library keeps no hidden global log. See [modes.md](./modes.md) for end-to-end recipes.

### Audit record shape

```ts
interface AuditRecord {
    kind: 'precondition' | 'postcondition' | 'invariant' | 'assertion' | 'on-error';
    message: string;
    timestamp: number; // Date.now()
    mode: 'audit';
    contractName?: string;
    functionName?: string;
    conditionIndex?: number;
    durationMs?: number; // time from wrapper entry to violation point
}
```

### Disabling categories

`disabled: ViolationCategory[]` accepts any union of `'precondition' | 'postcondition' | 'invariant' | 'assertion' | 'on-error'`. Disabled categories are skipped entirely, regardless of mode. Per-contract `mode` does **not** override `disabled`; `disabled` wins.

---

## `isContractsCompiledIn()` — compile-time disabling

The library reads a global constant, `__DESIGN_CONTRACTS_ENABLED__`, through a `typeof` guard. When your bundler defines it as `false`, every contract wrapper folds to a bare `fn.apply(this, args)` — no config resolution, no predicate calls.

```ts
import { isContractsCompiledIn } from 'design-contracts';

isContractsCompiledIn(); // true unless your bundler defines the constant to false
```

Two layers to be honest about:

- **Behavior (always guaranteed)**: with the flag `false`, predicates never execute and observable behavior does not depend on checks.
- **Physical removal (minifier-dependent)**: the constant folds inside the flag module either way, but whether the dead branches elsewhere disappear depends on your minifier. terser's `compress` inlines the trivial `isContractsCompiledIn()` and drops them; esbuild's minifier folds the function but does not inline cross-module calls, so the gated branches remain (unreachable, not removed). Verify with your own bundle output if the last few bytes genuinely matter.

### Bundler define recipes

**esbuild** (build script):

```ts
import { build } from 'esbuild';

await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    minify: true,
    define: { __DESIGN_CONTRACTS_ENABLED__: 'false' },
});
```

**tsup** (`tsup.config.ts`):

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    minify: true,
    esbuildOptions(options) {
        options.define = {
            ...options.define,
            __DESIGN_CONTRACTS_ENABLED__: 'false',
        };
    },
});
```

**Vite** (`vite.config.ts`):

```ts
import { defineConfig } from 'vite';

export default defineConfig({
    define: { __DESIGN_CONTRACTS_ENABLED__: false }, // raw false — Vite stringifies non-strings for you
});
```

**webpack** (`webpack.config.js`):

```js
const webpack = require('webpack');

module.exports = {
    mode: 'production',
    plugins: [new webpack.DefinePlugin({ __DESIGN_CONTRACTS_ENABLED__: 'false' })],
};
```

**Rollup** (`rollup.config.js`):

```js
import replace from '@rollup/plugin-replace';

export default {
    plugins: [
        replace({ preventAssignment: true, values: { __DESIGN_CONTRACTS_ENABLED__: 'false' } }),
    ],
};
```

Gotchas that bite:

- The replacement must be the **bare boolean** `false`. A quoted `'"false"'` is a truthy string — contracts stay enabled while looking disabled.
- To strip contracts only in production from a single define site: `define: { __DESIGN_CONTRACTS_ENABLED__: String(process.env.NODE_ENV !== 'production') }`.
- The `typeof` guard is deliberate: without a define, the identifier is undeclared and the checks stay **on**. Silence never disables contracts.

---

## Errors

Full reference in [errors.md](./errors.md). Hierarchy:

```
Error
└── ContractViolationError        kind: precondition | postcondition | invariant | assertion | on-error
    ├── PreconditionViolationError
    ├── PostconditionViolationError
    ├── InvariantViolationError
    ├── AssertionViolationError
    └── OnErrorViolationError
```

Every instance carries readonly structured fields — `kind`, `contractName?`, `functionName?`, `conditionIndex?`, `conditionName?`, `context?`, `mode` — plus `toJSON()` producing a log-safe object (no `stack`, `cause` serialized as `{ name, message }`). Default message format: `<Label> violated[: functionName][ (condition #N)][ [conditionName]][: userMessage]`.

```ts
import { ContractViolationError } from 'design-contracts';

try {
    divide(10, 0);
} catch (error) {
    if (error instanceof ContractViolationError) {
        console.error(error.toJSON());
    }
}
```

---

## `sanitize(value, options?)` / `safeSerialize(value)`

JSON-safe serialization of hostile values, used internally for context squashing and exposed for your own logging:

```ts
import { sanitize, safeSerialize } from 'design-contracts';

sanitize({ a: 1, b: [1, 2, 3] }); // { a: 1, b: [1, 2, 3] }
sanitize(new Map([['k', 'v']])); // { '[type]': 'Map', entries: ... } — compact form
```

Behavior: cycles → `'[Circular]'` (per-path active set), excessive depth → `'[MaxDepth]'`, item overflow → `'[... N more items]'`, long strings truncated with `...[truncated N chars]`, `bigint` → `'10n'`, non-finite numbers → `String(value)`, `undefined` → `'[undefined]'`, functions → `'[Function: name]'`, class instances → own enumerable props plus a `'[type]': ctor.name` key. Getters and `toJSON` are **never** invoked — hostile objects cannot crash the serializer.

Options (with clamps): `maxDepth` (default 4), `maxItems` (default 100), `maxStringLength` (default 500). `safeSerialize` is a thin alias of `sanitize(value)` with default options. Limitations: output is a _description_, not a round-trippable encoding — don't persist it and expect equality.

---

## Adapters

Ready-made telemetry adapters — factories returning `onViolation` / `onAudit` handlers. Nothing connects implicitly; no dependencies beyond the package; structurally typed. Full guide with copy-paste examples in [adapters.md](./adapters.md).

| Factory                                                        | Destination                                                                             | Default level/event                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `pinoAdapter` / `pinoAuditAdapter`                             | pino-like loggers (`logger[level](meta, message)`)                                      | `error` / `warn`                                        |
| `winstonAdapter` / `winstonAuditAdapter`                       | winston-like loggers (`.log(level, msg, meta)` or `[level](msg, meta)` — auto-detected) | `error` / `warn`                                        |
| `openTelemetryAdapter` / `openTelemetryAuditAdapter`           | span events via `span.addEvent`                                                         | `design-contracts.violation` / `design-contracts.audit` |
| `diagnosticsChannelAdapter` / `diagnosticsChannelAuditAdapter` | `node:diagnostics_channel`                                                              | `design-contracts:violation` / `design-contracts:audit` |
| `consoleAdapter`                                               | `console.warn` / `console.error` with a prefix                                          | `error`, prefix `[design-contracts]`                    |

Notes that matter:

- All adapters take `includeContext` with **default `false`** — context can carry sensitive data. Opt in explicitly; when enabled, context is run through `safeSerialize`.
- `childBindings` (pino/winston) binds a child logger once at creation and emits through it; without `.child()` it throws `TypeError`.
- OTel resolution order: `getActiveSpan()` (evaluated fresh per violation) → explicit `span` argument → dropped silently. Tracers (objects with `startSpan`) are rejected with `TypeError`.
- diagnostics_channel uses the channels `CONTRACTS_VIOLATION_CHANNEL = 'design-contracts:violation'` and `CONTRACTS_AUDIT_CHANNEL = 'design-contracts:audit'`, events `{ violation }` / `{ record }`. Subscribing costs nothing when nobody listens.
- Import from `design-contracts/adapters` or the root — both work.

Custom adapter from scratch is three lines: `configure({ onViolation: (error) => myLogger(error) })`. See [adapters.md](./adapters.md).

---

## Measured overhead

Measured on **Node 24.2.0** and **Bun 1.4.2** with `vitest bench` (tinybench). These are upper-bound, pessimistic numbers — the benchmark runs against sources through the vitest module-runner, which adds cross-module getter overhead that a compiled `dist` build does not pay. See [benchmarks.md](./benchmarks.md) for methodology and the full table.

| Scenario                   | Node 24.2.0                    | Bun 1.4.2    |
| -------------------------- | ------------------------------ | ------------ |
| plain call                 | 12.35M ops/s                   | 11.90M ops/s |
| contract, 1 pre            | 565k (~22x)                    | 498k (~24x)  |
| contract, pre + post       | 434k (~29x)                    | 404k (~30x)  |
| contract, `off` mode       | 1.22M (~10x)                   | 1.04M (~11x) |
| async contract, pre + post | 238k (~7.4x vs async baseline) | 219k (~8.2x) |
| contractObject + invariant | 255k (~25x)                    | 233k (~27x)  |

Honest tuning guidance: `off` via compile-time define (zero ALS, zero resolution) > `silent` ≈ `off` via runtime mode > everything else. `silent`/`off` do not run predicates at all. `warn` costs about the same as `strict`; the only difference is the dispatch on violation. `old` snapshots are the most expensive feature (deep clone on **every** call).

See [benchmarks.md](./benchmarks.md) for the full methodology and caveats.
