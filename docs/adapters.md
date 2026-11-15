# Adapters

Ready-made adapters wire contract violations and audit records into your logging and telemetry stack. Every adapter is a **factory**: pass your logger/tracer/console in, get an `onViolation` or `onAudit` handler out, hand it to `configure()`.

Design rules that hold for all adapters:

- **Nothing connects implicitly** — no side effects at import time, no global hooks.
- **No hard dependencies** — pino, winston, `@opentelemetry/api` are not dependencies of this package. Adapters are structurally typed; whatever you pass just needs the right shape.
- **`includeContext` defaults to `false` everywhere** — context can carry sensitive data. Opt in per adapter; when enabled, context is passed through `sanitize` (cycles cannot crash your logger).
- **Handler failures never break your app** — exceptions from `warn`/`audit` handlers are caught and written to `console.error` by the runtime.

All examples below are complete and runnable as written (minus having pino/winston installed when you actually use them). See [examples/08-telemetry.ts](../examples/08-telemetry.ts) for the diagnostics_channel flow end-to-end.

---

## pino

Structural shape expected: an object with level methods (`logger.error(meta, message)`) and, optionally, `.child(bindings)`. A real [`pino`](https://getpino.io) instance satisfies this out of the box.

```ts
import pino from 'pino';
import { configure } from '@bejiihiu/design-contracts';
import { pinoAdapter, pinoAuditAdapter } from '@bejiihiu/design-contracts/adapters';

const logger = pino({ level: 'info' });

configure({
    mode: 'audit',
    onViolation: pinoAdapter(logger),
    onAudit: pinoAuditAdapter(logger, { level: 'info' }),
});
```

Emitted shape:

```ts
logger.error(
    {
        err: violation, // the ContractViolationError itself
        kind: 'postcondition',
        mode: 'audit',
        contractName: 'fetchUser',
        functionName: 'fetchUser',
        conditionIndex: 0,
        conditionName: 'user found',
        // context: {...}           // only with includeContext: true
    },
    'Postcondition violated: fetchUser (condition #0) [user found]',
);
```

Options (`PinoAdapterOptions`):

| Option           | Default                                  | Meaning                                                                                                                        |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `level`          | `'error'` (violations), `'warn'` (audit) | Level to emit on                                                                                                               |
| `includeContext` | `false`                                  | Attach the sanitized context under `context`                                                                                   |
| `childBindings`  | —                                        | Bind a child logger with these bindings **at creation time** (requires `.child()` — `TypeError` otherwise) and emit through it |

Missing or non-function `level` → `TypeError` at creation. A pino-like object that is not an object at all → `TypeError` at creation. Fail fast, never silently no-op.

```ts
// child logger bound once — { component: 'billing' } rides on every line
const billingLogger = pinoAdapter(logger, { childBindings: { component: 'billing' } });
```

## winston

Structural shape expected: either `logger.log(level, message, meta)` (winston 3 style — preferred) or `logger[level](message, meta)` (convenience methods). The adapter auto-detects at creation.

```ts
import winston from 'winston';
import { configure } from '@bejiihiu/design-contracts';
import { winstonAdapter, winstonAuditAdapter } from '@bejiihiu/design-contracts/adapters';

const logger = winston.createLogger({
    transports: [new winston.transports.Console()],
});

configure({
    mode: 'audit',
    onViolation: winstonAdapter(logger),
    onAudit: winstonAuditAdapter(logger),
});
```

Options identical to pino (`level`, `includeContext`, `childBindings`). If neither `.log` nor a callable `logger[level]` exists → `TypeError` at creation.

## OpenTelemetry

Emits span **events**, not spans — a violation is a point in time, not an interval. No import of `@opentelemetry/api`; anything with `addEvent(name, attributes?)` works.

```ts
import { trace } from '@opentelemetry/api';
import { configure } from '@bejiihiu/design-contracts';
import {
    openTelemetryAdapter,
    openTelemetryAuditAdapter,
} from '@bejiihiu/design-contracts/adapters';

configure({
    mode: 'audit',
    // getActiveSpan is evaluated fresh on EVERY violation — a new active span means a new target
    onViolation: openTelemetryAdapter({ getActiveSpan: () => trace.getActiveSpan() }),
    onAudit: openTelemetryAuditAdapter({ getActiveSpan: () => trace.getActiveSpan() }),
});
```

Explicit span works too — useful in tests:

```ts
const events: Array<{ name: string; attrs?: Record<string, unknown> }> = [];
const fakeSpan = { addEvent: (name, attrs) => events.push({ name, attrs }) };

configure({ onViolation: openTelemetryAdapter(fakeSpan) });
```

Options (`OpenTelemetryAdapterOptions`):

| Option           | Default                                                     | Meaning                                                                |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `getActiveSpan`  | —                                                           | Resolve the span per violation; takes precedence over an explicit span |
| `span`           | —                                                           | Explicit fallback span                                                 |
| `includeContext` | `false`                                                     | Attach context under a `context` attribute (JSON string)               |
| `eventName`      | `'design-contracts.violation'` / `'design-contracts.audit'` | Event name override                                                    |

Attributes are snake_case: `kind`, `mode`, `contract?`, `function?`, `condition_index?`, `condition_name?` (audit adds `duration_ms`, `timestamp`). Undefined fields are omitted.

Rules:

- Span resolution order: `getActiveSpan()` → explicit `span` → drop silently. Telemetry never breaks your app.
- If `getActiveSpan()` throws, the adapter falls back to the explicit span.
- Passing a **tracer** (object with `startSpan`, no `addEvent`) → `TypeError` at creation. A tracer cannot address the currently active span.
- `openTelemetryAdapter(span, options)` — two-arg form with a non-span first argument → `TypeError`.

## diagnostics_channel

Publishes to `node:diagnostics_channel` (stable on Node >= 15.1, works in Bun). Zero cost when nobody subscribes.

```ts
import diagnostics_channel from 'node:diagnostics_channel';
import { configure } from '@bejiihiu/design-contracts';
import {
    diagnosticsChannelAdapter,
    diagnosticsChannelAuditAdapter,
    CONTRACTS_VIOLATION_CHANNEL,
    CONTRACTS_AUDIT_CHANNEL,
} from '@bejiihiu/design-contracts/adapters';

diagnostics_channel.channel(CONTRACTS_VIOLATION_CHANNEL).subscribe(({ violation }) => {
    myPipeline.send({ violation });
});

configure({
    mode: 'audit',
    onViolation: diagnosticsChannelAdapter(),
    onAudit: diagnosticsChannelAuditAdapter(),
});
```

Channels and payloads:

| Constant                      | Channel                      | Event                                   |
| ----------------------------- | ---------------------------- | --------------------------------------- |
| `CONTRACTS_VIOLATION_CHANNEL` | `design-contracts:violation` | `{ violation: ContractViolationError }` |
| `CONTRACTS_AUDIT_CHANNEL`     | `design-contracts:audit`     | `{ record: AuditRecord }`               |

Custom channel names: `diagnosticsChannelAdapter('my-org:violation')` — blank/empty names throw `TypeError`. The same probe logic is exported for subscribers (`loadDiagnosticsChannel()`, `getViolationChannel()`, `getAuditChannel()`) if you cannot use static imports.

The adapter throws a descriptive error **at creation** if `diagnostics_channel` is genuinely unavailable — no silent no-ops on exotic runtimes.

Events delivered to subscribers are **read-only**: the objects on the channel are live references into the runtime's reporting machinery — mutate them and you corrupt the record other subscribers see (or crash the caller). Read what you need, copy it if you must keep it, never write to it.

## console

One line per violation through `console.warn` or `console.error`:

```ts
import { configure } from '@bejiihiu/design-contracts';
import { consoleAdapter } from '@bejiihiu/design-contracts/adapters';

configure({ mode: 'warn', onViolation: consoleAdapter({ level: 'warn' }) });
// [design-contracts] precondition violation in divide / divide (condition #0): ...
```

Options: `level: 'warn' | 'error'` (default `'error'`), `prefix` (default `'[design-contracts]'`; empty string allowed). Bad level → `TypeError` at creation. Missing `console` → descriptive error at creation.

## Custom adapter from scratch

Every adapter is just a function `(violation: ContractViolationError) => void`. Write your own when none fit:

```ts
import {
    configure,
    type ContractViolationError,
    type AuditRecord,
} from '@bejiihiu/design-contracts';

const toDatadog = (error: ContractViolationError): void => {
    datadog.increment('contract.violation', {
        kind: error.kind,
        contract: error.contractName ?? 'unknown',
        mode: error.mode,
    });
};

const auditToDatadog = (record: AuditRecord): void => {
    datadog.increment('contract.audit', { kind: record.kind });
};

configure({ mode: 'audit', onViolation: toDatadog, onAudit: auditToDatadog });
```

Keep it defensive: do not throw inside handlers (in `warn`/`audit` the runtime catches and logs your exceptions, but don't rely on it), do not leak secrets, do not do I/O that can block the call path.

## Combining handlers

`onViolation` is a single function — for fan-out, compose:

```ts
const tee =
    (...handlers: Array<(error: ContractViolationError) => void>) =>
    (error: ContractViolationError) => {
        for (const handler of handlers) {
            try {
                handler(error);
            } catch (cause) {
                console.error(cause);
            }
        }
    };

configure({
    mode: 'audit',
    onViolation: tee(pinoAdapter(logger), toDatadog),
});
```

## Format helpers

`formatViolation(violation)`, `formatAudit(record)`, `violationLogObject(violation, { includeContext })`, `auditLogObject(record)` are exported for when you need the same rendering without a factory:

```ts
import { formatViolation, violationLogObject } from '@bejiihiu/design-contracts/adapters';

const line = formatViolation(error); // one-line human string
const meta = violationLogObject(error); // { err, kind, mode, ... } for loggers
```
