# Errors

Every error thrown by `design-contracts` is an instance of `ContractViolationError`. This page is the complete reference: hierarchy, message format, serialization, and how to write handlers.

## Hierarchy

```
Error
└── ContractViolationError            (kind: ContractViolationKind)
    ├── PreconditionViolationError    (kind: 'precondition')
    ├── PostconditionViolationError   (kind: 'postcondition')
    ├── InvariantViolationError       (kind: 'invariant')
    ├── AssertionViolationError       (kind: 'assertion')
    └── OnErrorViolationError         (kind: 'on-error')
```

`kind` values are the same five strings as the runtime's `ViolationCategory` — you can use them interchangeably for lookups and logging.

## Structured fields

`ContractViolationError` is a plain `Error` plus readonly, structured metadata:

| Field                         | Type                      | Meaning                                                                                           |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `name`                        | `string`                  | Class name (e.g. `PreconditionViolationError`)                                                    |
| `kind`                        | `ContractViolationKind`   | Which section of the contract was violated                                                        |
| `contractName?`               | `string`                  | The contract's `name` (or `fn.name` / `'anonymous'`)                                              |
| `functionName?`               | `string`                  | The wrapped function's name                                                                       |
| `conditionIndex?`             | `number`                  | Zero-based index of the failing condition within its section                                      |
| `conditionName?`              | `string`                  | Name of the failing _named_ condition (bare predicates do not set this)                           |
| `conditionName` on composites | —                         | Composite name, e.g. `all(not blank, email shape)`                                                |
| `context?`                    | `Record<string, unknown>` | Only what the caller (or a failing contract) explicitly attaches — sanitized; never raw arguments |
| `mode`                        | `ContractMode`            | Effective mode when the violation occurred (defaults `'strict'`)                                  |

Notes:

- `conditionIndex` is **0-based**, counted within the `pre` / `post` / `onError` / `invariant` array.
- `context` is never populated implicitly. Raw arguments, secrets and PII are **your** responsibility — pass nothing, or pass a sanitized record.
- `cause` follows the standard `Error` `cause` semantics: failing predicates that are themselves composites chain their `ConditionFailure` tree there. When a method fails _and_ the invariant broke on settle, the method's original error is preserved as `cause`.
- For optional fields, check with `!== undefined` (`in` is unreliable — class-field declarations may create own properties with value `undefined`).

## Message format

```
<Label> violated[: functionName][ (condition #N)][ [conditionName]][: userMessage]
```

`<Label>` is `Precondition`, `Postcondition`, `Invariant`, `Assertion` or `OnError`. Missing parts are omitted without leaving dangling separators. Examples:

```
Precondition violated: divide (condition #0) [positive]: value must be positive
Postcondition violated: fetchUser (condition #0)
Invariant violated: withdraw (condition #1) [balance non-negative]: an account balance can never go negative
Assertion violated: total() called with no lines
OnError violated: charge (condition #0) [GatewayError expected]
```

The user-message part uses the standard precedence: named condition's `message` → `options.message` → composed default.

## `toJSON()`

Error trackers get a safe object, never a raw stack:

```ts
import { PreconditionViolationError } from 'design-contracts';

const error = new PreconditionViolationError('value must be positive', {
    contractName: 'divide',
    functionName: 'divide',
    conditionIndex: 0,
    conditionName: 'positive',
    context: { attempt: 2 },
});

console.log(JSON.stringify(error.toJSON(), null, 2));
```

```json
{
    "name": "PreconditionViolationError",
    "kind": "precondition",
    "message": "Precondition violated: divide (condition #0) [positive]: value must be positive",
    "mode": "strict",
    "contractName": "divide",
    "functionName": "divide",
    "conditionIndex": 0,
    "conditionName": "positive",
    "context": { "attempt": 2 }
}
```

Rules:

- `stack` is **never** serialized (it leaks absolute paths).
- `cause` serializes as `{ name, message }` when it is an `Error`, passes through when it is a primitive (string/number/boolean/bigint/null), and is **dropped** otherwise.
- `context` is emitted by reference — it is assumed already sanitized.
- Optional keys are omitted entirely rather than set to `undefined`.

## Catching each type

```ts
import {
    AssertionViolationError,
    ContractViolationError,
    InvariantViolationError,
    OnErrorViolationError,
    PostconditionViolationError,
    PreconditionViolationError,
} from 'design-contracts';

function handle(error: unknown): void {
    if (error instanceof PreconditionViolationError) {
        // bad call — the function body never ran; fix the caller
        metrics.increment('contracts.precondition', { contract: error.contractName });
        return;
    }
    if (error instanceof PostconditionViolationError) {
        // broken promise — the body ran but lied; treat as a bug in the callee
        logger.error({ err: error.toJSON() }, 'postcondition failed');
        return;
    }
    if (error instanceof InvariantViolationError) {
        // object state went illegal — the object may be half-mutated
        // (contracts report, they do not roll back)
        quarantine(error.contractName);
        return;
    }
    if (error instanceof AssertionViolationError) {
        // "impossible" happened — almost certainly a logic bug
        logger.fatal({ err: error.toJSON() }, 'assertion failed');
        return;
    }
    if (error instanceof OnErrorViolationError) {
        // the failure violated its error contract
        logger.error({ err: error.toJSON() }, 'on-error contract failed');
        return;
    }
    throw error; // not a contract violation — let it fly
}
```

Or catch the base class when you don't care which section failed:

```ts
try {
    charge(card, amount);
} catch (error) {
    if (error instanceof ContractViolationError) {
        errorTracker.captureException(error); // toJSON-aware via transport
        return;
    }
    throw error;
}
```

## Writing a violation handler

`onViolation` (used in `warn` and `audit`) receives the live error object. `onAudit` receives a plain-data `AuditRecord`.

```ts
import { configure } from 'design-contracts';

configure({
    mode: 'audit',
    onViolation: (error) => {
        // keep this cheap — it runs on the hot path of every violation
        metrics.increment(`contracts.${error.kind}`);
    },
    onAudit: (record) => {
        log.info({ record }, 'contract audit');
    },
});
```

Handlers are isolated from your control flow:

- In `warn`/`audit`, exceptions thrown **by** handlers are caught and logged to `console.error` — they never propagate.
- In `strict`, handlers are never called — the throw is the signal.
- Keep handlers side-effect-light and free of secrets. They may run on the hot path.

## Checking whether an error is safe to log

`toJSON()` output is designed for logs and trackers, but it still contains whatever you put in `context`. The library never adds raw arguments or secrets to any error automatically — if you attach context via `assert(condition, message, context)` or your own handler, you own its sensitivity.
