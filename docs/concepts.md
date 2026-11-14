# Concepts

Design by Contract (DbC) is a discipline where a unit of code declares — in the language, not in a comment — the promises that hold around its execution, and the runtime enforces them.

## The three promises

Every contracted function can state three things:

1. **Preconditions** — what must be true _before_ it runs. The caller's responsibility, checked at the boundary, before the body executes. `pre: [(amount) => amount > 0]`
2. **Postconditions** — what will be true _after_ it runs. The callee's responsibility, checked on the resolved result. `post: [(result) => result >= 0]`
3. **Invariants** — what must remain true _throughout_. For objects, via `contractObject()`: checked when the object is created, after every method settles, and after every direct property write.

Plus **assertions** (`assert`, `assert.fail`) for internal claims that should never be false — "we already validated this upstream", "this branch is unreachable". And **on-error conditions** (`onError`) for when the contract of _failing_ matters: "if this throws, it must throw a `DatabaseError`".

```ts
import { contract } from 'design-contracts';

const withdraw = contract(
    function withdraw(balance: number, amount: number): number {
        return balance - amount;
    },
    {
        name: 'withdraw',
        pre: [(_balance, amount) => amount > 0],
        post: [(result) => result >= 0],
    },
);
```

## Contracts do not change signatures

This is a deliberate design constraint: a contract is **not** a type-level construct. `contract()` returns a function with the same runtime shape and the same TypeScript signature as the wrapped function. No generics are added, no wrapper types leak into your call sites, no type-level machinery is required to use it.

The trade-off: the compiler does not know contracts exist, so `divide(10, 0)` _compiles fine_. Contract violations are **runtime** events. This is the point — they catch the gap between what types can express and what values actually flow through your program.

## Contracts vs validation (Zod)

The most common misconception: _"Isn't this just Zod?"_ No — they solve different problems, and the positioning matters:

|               | Zod & co.                                             | design-contracts                                     |
| ------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Direction     | Edge → inside (parse untrusted input at the boundary) | Inside → inside (code making promises to itself)     |
| When it runs  | Once, at the boundary                                 | Every call, as long as checks are enabled            |
| Failure means | "This input is unacceptable"                          | "This part of the system broke its own promise"      |
| Typical type  | Schema describing data shape                          | Predicate describing behavioral truth                |
| Cost model    | Paid at the edge                                      | Paid per call — see [benchmarks.md](./benchmarks.md) |

Zod answers _"can I trust this value from outside?"_ Contracts answer _"is this part of my code healthy?"_ A Zod schema validates that the HTTP body is a well-formed `CreateUser`. A contract on `CreditLedger.post` proves the ledger never double-spends. You want both, at different layers.

A practical rule of thumb:

- **Zod at the boundary, contracts inside.** Validate untrusted input once, at the edge. Assert your own internal promises on every call.
- If you find yourself writing a contract for HTTP request bodies, you probably want a schema. If you find yourself writing a `class-validator` rule for an invariant the whole team keeps forgetting, you want a contract.

## When to use contracts

- **Critical cores**: financial arithmetic, permission checks, state machines — anywhere a silent wrong answer is worse than a loud exception.
- **Team boundaries inside a codebase**: the module that consumes your API should be able to trust it more than the type system alone allows.
- **AI-generated code**: types check out but behavior drifts; contracts ratchet behavior against the stated intent.
- **Gradual rollout of correctness**: `audit` mode lets you observe violations in production without changing control flow — see [modes.md](./modes.md).
- **Library code**: document and enforce your own pre/postconditions instead of trusting callers to read the docs.

## When NOT to use contracts

- **Form input, API payloads, user-facing validation** — use a schema validator (Zod, Valibot, ArkType). Contracts are not a validation library and don't produce user-friendly error messages by design.
- **Hot paths where the overhead matters and the risk is negligible** — contract wrappers cost something on every call (see [benchmarks.md](./benchmarks.md)). A tight numeric loop over millions of iterations is not where you want `post: [isFinite]`.
- **Replacing type declarations** — contracts are runtime checks, not a static analysis. They complement types; they don't subsume them.
- **As control flow** — a contract violation means a bug (or a broken integration). Don't wrap `pre` around user input and catch the violation to show a form error; that's schema validation's job.
- **Invariants that cross object boundaries** — `contractObject()` guards one object. An invariant "sum of all accounts is constant" belongs in a ledger-level contract, not on individual accounts.

## What contracts are not

- **Not types.** No compile-time checking, no inference magic.
- **Not a test suite.** Tests check specific scenarios; contracts check every execution, forever, in production if you let them.
- **Not a linter.** They don't flag suspicious code; they flag violated promises at the moment they happen.
- **Not free.** They cost nanoseconds per call in `off`/`silent` mode and microseconds in `strict`. Measure your hot paths.

## The core idea in one sentence

> Types prove your code is shaped correctly; contracts prove your code keeps its word — and they keep proving it after the tests are green.

Next: [api.md](./api.md) for the full reference.
