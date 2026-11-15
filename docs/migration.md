# Migration Guide

How to move from "we validate at tests" (or nothing) to verifiable runtime contracts, and when you should not.

Not installed yet? The package lives on GitHub Packages — the one-time setup is in [getting-started.md#installation](./getting-started.md#installation).

## The 15-minute, three-function migration

Pick the three riskiest functions in your codebase — the ones whose silent wrong answer would page someone. Financial arithmetic, permission checks, state transitions. Then:

### 1. Wrap one function (5 minutes)

```ts
import { contract } from '@bejiihiu/design-contracts';

// before
export function allocate(pool: number, share: number): number {
    return pool * share;
}

// after
export const allocate = contract(
    function allocate(pool: number, share: number): number {
        return pool * share;
    },
    {
        name: 'allocate',
        pre: [(pool, share) => pool >= 0 && share >= 0 && share <= 1],
        post: [(result) => Number.isFinite(result) && result >= 0],
    },
);
```

The export shape is unchanged — call sites don't need to know. Types are identical.

### 2. Decide what failure means (2 minutes)

Choose the mode **per function**, not globally:

```ts
const allocateStrict = contract(allocateImpl, { mode: 'strict' }); // house money — fail loud
const reportFast = contract(reportImpl, { mode: 'audit', onAudit: shipToTelemetry }); // observe first
```

A good default: `audit` for anything you have never seen hold in production before, `strict` for invariants you already trust.

### 3. Roll it out (8 minutes)

- Commit the contract.
- Deploy in `audit` mode if you took that path. Watch the violation counters for a week.
- If the counter fires, either fix the bug it found (congratulations) or fix the contract (you modelled the wrong promise).
- Promote to `strict` once quiet.

Repeat for the other two functions. That is the whole migration — there is no framework to adopt, no runtime to install, no DI container to wire.

## Incremental adoption pattern

```
day 1   → wrap the 3 riskiest functions in audit mode
week 2  → promote known-good contracts to strict; keep noisy ones in audit
week 4  → invariants on the 1–2 core objects that can go illegal
later   → vitest expectations on violation paths; mergeClassContracts for class hierarchies
```

## Coming from test-only validation

Tests are how you _check_ a contract once; contracts are how you check it **every time in production**. They complement each other:

|              | Test assertion           | Runtime contract                                |
| ------------ | ------------------------ | ----------------------------------------------- |
| When it runs | CI                       | every call                                      |
| Coverage     | scenarios you thought of | every execution                                 |
| Failure mode | red build                | throws / reports (mode-dependent)               |
| Cost         | zero at runtime          | per call (see [benchmarks.md](./benchmarks.md)) |

Migrate your _assertion vocabulary_ first (`expect(x).toBeGreaterThan(0)` → `pre: [x => x > 0]`), then your critical fixtures become contracts. Keep the tests — they now guard the contracts themselves.

## Coming from Zod/schema validation

Do not port your schemas. Contracts do not replace input parsing — that stays at the boundary in Zod. Instead:

1. Keep Zod on HTTP/RPC/env boundaries exactly as-is.
2. Add contracts **inside** — on the functions that consume the parsed values. Zod proved the input was well-shaped; the contract proves your code keeps its own promises about what it does with it.
3. Share nothing between them. Two layers, two jobs.

## Coming from ts-code-contracts / contractis / similar

The concepts map 1:1 (require/ensure → pre/post), which makes the migration mechanical:

- `require(cond)` → `pre: [cond]`
- `ensure(cond)` → `post: [cond]`
- old-values support → `old: [...]` / `old: (args) => ...`
- legacy decorator setups → rewrite with `contract()` or move to Stage 3 `@contractMethod`

Re-verify violation modes (other libraries throw unconditionally; here you can `audit` first) and expect better `old` semantics (structuredClone-based snapshots, documented fallbacks).

## When NOT to migrate

- **Form validation / request payloads** — keep Zod (or whatever you use). Contracts are not schemas.
- **Hot loops** — a contract on a function called 10M times per second is a performance decision, not a correctness one. Measure first ([benchmarks.md](./benchmarks.md)); use `off` mode there if the promise is cheap to keep.
- **Cross-service invariants** — contracts guard one process. Distributed promises need distributed protocols.
- **User-facing error messages** — contract violations are operator signals, not UX. If the user should see "email is required", that is schema validation with a message.
- **Political deadlock** — if the team won't keep the predicates honest, a contract library ships disabled checks and infinite false confidence. Migrate only what the team agrees to maintain.

## Rollback strategy

Contracts are additive and reversible: `configure({ mode: 'off' })` disables all checks process-wide without a redeploy of call sites, and the compile-time define removes them from the bundle entirely. If a contract causes an incident, you flip one config line — not a code revert.
