# Examples

Runnable, self-contained examples for `design-contracts` — no install, no
network, no mocks. Each file runs top-to-bottom and prints what it does.

## Prerequisites

Bun (the examples import from `../src/index.js`, so they always track the
current source tree) and a clone of the repository. From the repo root:

```sh
bun run examples/01-basic.ts
```

Every example exits with code 0. There are no `package.json` scripts for the
examples — run them directly.

(`globals.d.ts` is build plumbing: the repo compiles with `"types": []`, so
the examples declare a minimal `console` signature there. It is not an
example and not needed in your own project.)

## The examples

| File | What it shows | Expected output (abridged) |
| --- | --- | --- |
| `01-basic.ts` | `pre`/`post` on plain functions, try/catch on violations | `divide(10, 2) = 5`, three caught `PreconditionViolationError`s, one caught `PostconditionViolationError` |
| `02-async.ts` | Contracts on async code: pre before the query, post on the resolved value, in-memory "database" | happy path fetch, caught pre violation, caught post violation on the corrupt `ghost` row, `total queries: 2` |
| `03-old-values.ts` | `old` snapshots — array form (`['account', 'amount']`) and function form — checked in postconditions | both withdrawals verified, overdraft rejected by `pre`, balance untouched |
| `04-class-contracts.ts` | `@contractMethod` decorators (TC39 Stage 3) on a class, `contract()` on a field, `contractObject()` invariants | decorator violation caught, statement field contract caught, two `InvariantViolationError`s (method settle + direct write) |
| `05-composition.ts` | Named conditions + `all`/`any`/`not`, composite failure inspection | passing calls, three violations with readable condition names, `lastFailure` JSON dump |
| `06-modes.ts` | `strict` / `warn` / `audit` / `off` on the same contract, incl. predicate-skip counting | strict throws, warn logs and continues, audit prints a JSON record, off evaluates 0 predicates |
| `07-inheritance.ts` | Single-level `@contractMethod`, then explicit Liskov merge via `mergeClassContracts()` (disjunction pre, unioned post) through base-typed call sites | base-compliant payload passes, both-fail throws, sloppy override rejected by base postcondition |
| `08-telemetry.ts` | `mode: 'audit'` + `diagnosticsChannelAuditAdapter()`, subscriber on `design-contracts:audit` | subscriber prints the `{ record }` event, function result returned normally |
| `09-custom-handler.ts` | Custom `onViolation` handler (toy logger) + `withConfig()` scoped mode overrides | global `warn` logs, `strict` scope throws, `off` scope skips checks entirely, global `warn` again outside the scopes |

## Reading order

Start with `01-basic.ts`, then `02-async.ts` and `03-old-values.ts` — the
three build the mental model (pre → body → post, plus snapshots).
`04` through `07` layer classes, conditions, modes and inheritance on top.
`08` and `09` show how to ship it: telemetry via `node:diagnostics_channel`
and scoped enforcement.

## Notes

- All examples assume the default `strict` mode unless they explicitly
  reconfigure it (examples 06 and 09).
- `08-telemetry.ts` timestamps (`timestamp`, `durationMs`) vary per run.
- Examples use only the public API surface from `src/index.ts`.
