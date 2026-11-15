# Getting Started

**design-contracts** is a Design by Contract library for JavaScript and TypeScript. It lets you state the promises your code makes to itself — preconditions before a call, postconditions after it, invariants on mutable state — and enforces them at runtime.

This page gets you from zero to a working contract in about five minutes.

## Installation

```sh
# npm
npm install design-contracts

# bun
bun add design-contracts

# pnpm
pnpm add design-contracts
```

Requirements:

- **Node.js >= 18** (runtime compatibility target) or **Bun**
- **ESM and CJS both supported** — pick whichever your project uses
- TypeScript is optional but recommended; no configuration is required for basic use

## Your first contract

Here is the canonical example — a contract-wrapped `divide`:

```ts
import { contract, PreconditionViolationError } from 'design-contracts';

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

console.log(divide(10, 2)); // 5

try {
    divide(10, 0);
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('blocked:', error.message);
        // blocked: Precondition violated: divide (condition #0): ...
    }
}
```

What happened on that failing call?

1. The precondition `(_a, b) => b !== 0` was evaluated **before** the function body ran.
2. The predicate returned a falsy value.
3. The default enforcement mode is `strict`, so the wrapper threw a
   `PreconditionViolationError` and **the body never executed**.

The postcondition `(result) => Number.isFinite(result)` is checked after the body returns (or, for async functions, after the promise resolves — the postcondition sees the _resolved_ value, never a raw promise).

See [examples/01-basic.ts](../examples/01-basic.ts) for a complete runnable version, and [examples/02-async.ts](../examples/02-async.ts) for async contracts.

## Verifying the install

A quick import smoke test — if this prints `ok`, everything is wired up:

```ts
// smoke.ts
import { contract } from 'design-contracts';

const add = contract((a: number, b: number): number => a + b, {
    pre: [(a, b) => Number.isFinite(a) && Number.isFinite(b)],
});

console.log(add(2, 3) === 5 ? 'ok' : 'broken');
```

```sh
node smoke.ts   # or: bun smoke.ts
```

If you prefer to stay inside the repository:

```sh
bun run examples/01-basic.ts
```

## Importing: ESM vs CJS

ESM (the package is `"type": "module"`, this is the default experience):

```ts
import { contract, configure } from 'design-contracts';
```

CommonJS:

```js
const { contract, configure } = require('design-contracts');
```

Type-only imports work the same way in both worlds:

```ts
import type { ContractOptions, ContractContext, Mode } from 'design-contracts';
```

Subpath exports are available for the adapters and decorators if you want a tighter import graph:

```ts
import { pinoAdapter } from 'design-contracts/adapters';
import { contractMethod } from 'design-contracts/decorators';
```

## TypeScript setup

**No configuration is needed** for the core API. `contract()` infers argument and return types from the wrapped function:

```ts
const divide = contract(
    function divide(a: number, b: number): number {
        return a / b;
    },
    { pre: [(_a, b) => b !== 0] }, // parameters inferred: _a: number, b: number
);
```

### Recommended `tsconfig.json`

```jsonc
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "ESNext",
        "moduleResolution": "Bundler" // or "NodeNext" if your project pins it
    }
}
```

`moduleResolution: "Bundler"` matches the package's dual ESM/CJS export map with per-condition type declarations (`index.d.ts` / `index.d.cts`). `"NodeNext"` works too — the package is published with matching `types` conditions for both.

### Decorators (`@contractMethod`)

`@contractMethod` uses **TC39 Stage 3 decorators** — the standard the TypeScript compiler supports natively since TypeScript 5.0. Requirements:

- TypeScript >= **5.0**
- `target: "ES2022"` or later
- **Do not** enable `experimentalDecorators` — that flag switches to the legacy, pre-standard decorator semantics, which is a different (and unsupported) API
- No extra compiler flags are required; standard Stage 3 decorators are emitted natively

```ts
import { contractMethod } from 'design-contracts';

class Bank {
    @contractMethod({ pre: [(amount: number) => amount > 0] })
    deposit(amount: number): number {
        // ...
        return amount;
    }
}
```

If your decorators come from the legacy `experimentalDecorators` pipeline instead, `@contractMethod` will not be invoked — use the plain `contract()` wrapper (or `mergeClassContracts()` for prototypes) in that setup. See [inheritance.md](./inheritance.md) for the decorator merge semantics.

## What happens on a violation

By default (`strict` mode), a contract violation throws a dedicated error class. The error hierarchy is:

| Error class                   | Raised when                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PreconditionViolationError`  | a `pre` predicate returned falsy before `fn` ran                                                         |
| `PostconditionViolationError` | a `post` predicate returned falsy after `fn` settled                                                     |
| `InvariantViolationError`     | an object invariant (via `contractObject`) did not hold                                                  |
| `AssertionViolationError`     | `assert()` / `assert.fail()` was triggered (thrown in `strict` mode; reported instead in `warn`/`audit`) |
| `OnErrorViolationError`       | an `onError` predicate failed while `fn` was throwing                                                    |

All of them extend `ContractViolationError`, so a single `catch (error instanceof ContractViolationError)` handles everything. Each carries structured fields (`kind`, `contractName`, `functionName`, `conditionIndex`, `conditionName`) and is safe to log via `toJSON()`. See [errors.md](./errors.md) for the full reference.

Other enforcement modes change what "a violation" means: `warn` logs and continues, `audit` reports a machine-readable record and continues, `silent` and `off` disable checks entirely (predicates are not executed). See [modes.md](./modes.md).

## Where to next

- [concepts.md](./concepts.md) — what contracts are (and are not)
- [api.md](./api.md) — the complete API reference
- [examples/README.md](../examples/README.md) — runnable examples 01–09
