/**
 * OpenTelemetry-compatible adapters — no dependency on `@opentelemetry/api`.
 *
 * A violation is an *event*, not a span, so these adapters attach a span event
 * instead of starting spans of their own. Any object with `addEvent(name, attrs)`
 * satisfies the structural type — an OTel `Span` does. Nothing from the
 * `@opentelemetry/*` packages is imported or required.
 *
 * Wiring it up:
 * ```ts
 * import { trace } from '@opentelemetry/api';
 * import { configure } from 'design-contracts';
 * import { openTelemetryAdapter, openTelemetryAuditAdapter } from 'design-contracts/adapters';
 *
 * // events land on whatever span is active when the violation fires:
 * configure({
 *     mode: 'warn',
 *     onViolation: openTelemetryAdapter({ getActiveSpan: () => trace.getActiveSpan() }),
 * });
 * // or pin one span explicitly (e.g. request-scoped):
 * configure({ mode: 'audit', onAudit: openTelemetryAuditAdapter(span) });
 * ```
 *
 * If no span can be resolved for an event, the event is quietly dropped —
 * by design, mirroring OTel's own no-op philosophy when no SDK/span is wired.
 * It never throws from inside the handler.
 *
 * If the first argument has a `startSpan` method but no `addEvent` (i.e. you
 * passed a tracer), creation throws a `TypeError`: a tracer cannot address the
 * *current active* span. Pass either a span-like object or `{ getActiveSpan }`.
 *
 * Event attributes are flat and snake_case (OTel attribute style):
 * `kind`, `contract`, `function`, `condition_index`, `condition_name`, `mode`
 * (+ `context` as a JSON string when `includeContext` is set, + audit extras on
 * the audit adapter). `undefined` fields are omitted entirely.
 */

import { safeSerialize } from '../core/sanitize.js';
import type { ContractViolationError } from '../errors/index.js';
import type { AuditRecord } from '../runtime/index.js';

/** Scalar attribute value; OTel also allows arrays, which our attributes never use. */
export type OtelAttributeValue = string | number | boolean;

/**
 * Minimal structural span that can receive an event. An OTel `Span` is
 * assignable to this. Method bivariance makes the exact `addEvent` signature
 * in `@opentelemetry/api` compatible.
 */
export interface SpanEventLike {
    addEvent(name: string, attributes?: Record<string, OtelAttributeValue>): unknown;
}

export interface OpenTelemetryAdapterOptions {
    /**
     * Resolve the span to receive events, called fresh for every violation —
     * e.g. `() => trace.getActiveSpan()`. Takes precedence over an explicitly
     * passed span when it returns a span.
     */
    readonly getActiveSpan?: () => SpanEventLike | undefined;
    /** Explicit span used when `getActiveSpan` is unset or returns undefined. */
    readonly span?: SpanEventLike;
    /**
     * Include the violation's sanitized context as a `context` attribute
     * (JSON string). Default: `false` — context can carry sensitive data.
     */
    readonly includeContext?: boolean;
    /** Event name override. Default: `'design-contracts.violation'` / `'design-contracts.audit'`. */
    readonly eventName?: string;
}

interface ResolvedOtelAdapter {
    readonly emit: (attributes: Record<string, OtelAttributeValue>) => void;
    readonly includeContext: boolean;
}

function isSpanEventLike(value: unknown): value is SpanEventLike {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { addEvent?: unknown }).addEvent === 'function'
    );
}

function isTracerLike(value: unknown): boolean {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { startSpan?: unknown }).startSpan === 'function'
    );
}

function resolveAdapter(
    spanOrOptions: SpanEventLike | OpenTelemetryAdapterOptions | undefined,
    maybeOptions: OpenTelemetryAdapterOptions | undefined,
    defaultEventName: string,
): ResolvedOtelAdapter {
    let explicitSpan: SpanEventLike | undefined;
    let options: OpenTelemetryAdapterOptions | undefined;

    if (isSpanEventLike(spanOrOptions)) {
        explicitSpan = spanOrOptions;
        options = maybeOptions ?? {};
    } else if (spanOrOptions === undefined) {
        options = maybeOptions ?? {};
    } else if (maybeOptions === undefined) {
        // single argument: an options bag — or someone passing a tracer, which is our one loud mistake
        if (isTracerLike(spanOrOptions)) {
            throw new TypeError(
                'design-contracts: a tracer cannot address the currently active span. ' +
                    'Pass a span-like object (with addEvent) or { getActiveSpan: () => trace.getActiveSpan() } instead.',
            );
        }
        options = spanOrOptions;
    } else {
        // two arguments and the first is not a span — ambiguous call, refuse it
        throw new TypeError(
            'design-contracts: invalid arguments. Signatures: (options?) or (span, options?).',
        );
    }

    if (options === null || typeof options !== 'object') {
        throw new TypeError('design-contracts: options must be an object.');
    }
    if (options.getActiveSpan !== undefined && typeof options.getActiveSpan !== 'function') {
        throw new TypeError('design-contracts: options.getActiveSpan must be a function.');
    }
    if (options.span !== undefined && !isSpanEventLike(options.span)) {
        throw new TypeError(
            'design-contracts: options.span must have an addEvent(name, attributes) method.',
        );
    }

    const eventName = options.eventName ?? defaultEventName;
    const includeContext = options.includeContext === true;
    const fallbackSpan = explicitSpan ?? options.span;

    const emit = (attributes: Record<string, OtelAttributeValue>): void => {
        let target: SpanEventLike | undefined;
        try {
            target = options.getActiveSpan?.() ?? fallbackSpan;
        } catch {
            // a user-supplied resolver blew up — don't let telemetry take the app down
            target = fallbackSpan;
        }
        if (target === undefined || typeof target.addEvent !== 'function') {
            return; // no span wired — drop by design, never throw from a handler
        }
        try {
            target.addEvent(eventName, attributes);
        } catch {
            // span event failed (e.g. exotic span impl) — telemetry must never break control flow
        }
    };

    return { emit, includeContext };
}

function violationAttributes(
    violation: ContractViolationError,
    includeContext: boolean,
): Record<string, OtelAttributeValue> {
    // safeSerialize is total, but JSON.stringify itself isn't guaranteed — drop the attribute on failure
    let serializedContext: string | undefined;
    if (includeContext && violation.context !== undefined) {
        try {
            serializedContext = JSON.stringify(safeSerialize(violation.context));
        } catch {
            serializedContext = undefined;
        }
    }
    const attributes: Record<string, OtelAttributeValue> = {
        kind: violation.kind,
        mode: violation.mode,
        ...(violation.contractName !== undefined ? { contract: violation.contractName } : {}),
        ...(violation.functionName !== undefined ? { function: violation.functionName } : {}),
        ...(violation.conditionIndex !== undefined
            ? { condition_index: violation.conditionIndex }
            : {}),
        ...(violation.conditionName !== undefined
            ? { condition_name: violation.conditionName }
            : {}),
        ...(serializedContext !== undefined ? { context: serializedContext } : {}),
    };
    return attributes;
}

/**
 * Create an `onViolation` handler that records a span event.
 *
 * Signature: `openTelemetryAdapter(options?)` or `openTelemetryAdapter(span, options?)`.
 * The event resolves its target span per violation: `getActiveSpan()` first,
 * then the explicit span. No span → the event is dropped silently.
 */
export function openTelemetryAdapter(
    spanOrOptions?: SpanEventLike | OpenTelemetryAdapterOptions,
    maybeOptions?: OpenTelemetryAdapterOptions,
): (violation: ContractViolationError) => void {
    const { emit, includeContext } = resolveAdapter(
        spanOrOptions,
        maybeOptions,
        'design-contracts.violation',
    );
    return (violation) => {
        emit(violationAttributes(violation, includeContext));
    };
}

/**
 * Create an `onAudit` handler that records a span event for the audit record.
 * Same target resolution as {@link openTelemetryAdapter}; default event name
 * `'design-contracts.audit'`. Attributes: `kind`, `mode`, `contract`,
 * `function`, `condition_index`, `duration_ms`, `timestamp`.
 */
export function openTelemetryAuditAdapter(
    spanOrOptions?: SpanEventLike | OpenTelemetryAdapterOptions,
    maybeOptions?: OpenTelemetryAdapterOptions,
): (record: AuditRecord) => void {
    const { emit } = resolveAdapter(spanOrOptions, maybeOptions, 'design-contracts.audit');
    return (record) => {
        const attributes: Record<string, OtelAttributeValue> = {
            kind: record.kind,
            mode: record.mode,
            timestamp: record.timestamp,
            ...(record.contractName !== undefined ? { contract: record.contractName } : {}),
            ...(record.functionName !== undefined ? { function: record.functionName } : {}),
            ...(record.conditionIndex !== undefined
                ? { condition_index: record.conditionIndex }
                : {}),
            ...(record.durationMs !== undefined ? { duration_ms: record.durationMs } : {}),
        };
        emit(attributes);
    };
}
