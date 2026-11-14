/**
 * Adapters for pino-compatible loggers.
 *
 * Structural typing only — `design-contracts` does not depend on `pino`.
 * Pass any logger that behaves like pino's: level methods taking `(meta, message)`.
 *
 * Usage:
 * ```ts
 * import pino from 'pino';
 * import { configure } from 'design-contracts';
 * import { pinoAdapter, pinoAuditAdapter } from 'design-contracts/adapters';
 *
 * const logger = pino();
 * configure({ mode: 'warn', onViolation: pinoAdapter(logger) });
 * configure({ mode: 'audit', onAudit: pinoAuditAdapter(logger) });
 * ```
 *
 * If you want a pino child with bindings, bind it yourself and pass it in —
 * or pass `childBindings` in the options, in which case the adapter binds a
 * child once at creation and logs through it. When `childBindings` is set but
 * the logger has no `.child()`, adapter creation throws a `TypeError`.
 *
 * `logger[level]` is resolved and validated at adapter creation time: a typo'd
 * level fails fast with a `TypeError` instead of silently dropping violations.
 */

import type { ContractViolationError } from '../errors/index.js';
import type { AuditRecord } from '../runtime/index.js';
import { auditLogObject, formatAudit, formatViolation, violationLogObject } from './format.js';

/**
 * Structural shape of a pino logger: level methods reachable by name,
 * plus the optional `child(bindings)` factory. Real pino loggers satisfy this.
 */
export interface PinoLikeLogger {
    readonly [level: string]: unknown;
    child?(bindings: Record<string, unknown>): PinoLikeLogger;
}

export interface PinoAdapterOptions {
    /** Level to emit on. Default: `'error'` for violations. */
    readonly level?: string;
    /**
     * Include the violation's sanitized context in the log object under `context`.
     * Default: `false` — context can carry sensitive data.
     */
    readonly includeContext?: boolean;
    /**
     * When set, the adapter binds a child logger with these bindings at creation
     * time and emits through it. Requires the logger to expose `.child()`.
     */
    readonly childBindings?: Record<string, unknown>;
}

interface ResolvedTarget {
    readonly target: PinoLikeLogger;
    readonly log: (meta: Record<string, unknown>, message: string) => void;
}

function resolveTarget(
    logger: PinoLikeLogger,
    options: PinoAdapterOptions,
    defaultLevel: string,
): ResolvedTarget {
    if (logger === null || typeof logger !== 'object') {
        throw new TypeError(
            'design-contracts: logger must be an object with level methods (e.g. a pino instance).',
        );
    }
    let target = logger;
    if (options.childBindings !== undefined) {
        if (typeof logger.child !== 'function') {
            throw new TypeError(
                'design-contracts: options.childBindings is set but the logger has no .child() method.',
            );
        }
        target = logger.child(options.childBindings);
    }
    const level = options.level ?? defaultLevel;
    const candidate = target[level];
    if (typeof candidate !== 'function') {
        throw new TypeError(
            `design-contracts: logger has no callable "${level}" method. ` +
                "Pass options.level matching one of your logger's levels.",
        );
    }
    const log = (meta: Record<string, unknown>, message: string): void => {
        (
            candidate as (
                this: PinoLikeLogger,
                meta: Record<string, unknown>,
                message?: string,
            ) => void
        ).call(target, meta, message);
    };
    return { target, log };
}

/**
 * Create an `onViolation` handler for a pino-like logger.
 *
 * Emits `logger[level]({ err, kind, mode, ...fields }, message)` where `message`
 * is the one-line violation description. `err` is the raw violation error, so
 * pino's default `err` serializer captures stack and these fields.
 */
export function pinoAdapter(
    logger: PinoLikeLogger,
    options: PinoAdapterOptions = {},
): (violation: ContractViolationError) => void {
    const { log } = resolveTarget(logger, options, 'error');
    const includeContext = options.includeContext === true;
    return (violation) => {
        log(violationLogObject(violation, { includeContext }), formatViolation(violation));
    };
}

/**
 * Create an `onAudit` handler for a pino-like logger.
 *
 * Audit records are not errors, so the default level is `'warn'` (overridable
 * via `options.level`). Emits `logger[level]({ kind, mode, timestamp, ... }, message)`.
 */
export function pinoAuditAdapter(
    logger: PinoLikeLogger,
    options: PinoAdapterOptions = {},
): (record: AuditRecord) => void {
    const { log } = resolveTarget(logger, options, 'warn');
    return (record) => {
        log(auditLogObject(record), formatAudit(record));
    };
}
