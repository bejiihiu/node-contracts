/**
 * Adapters for winston-compatible loggers.
 *
 * Structural typing only — `design-contracts` does not depend on `winston`.
 *
 * Dispatch is auto-detected at adapter creation time, in this order:
 * 1. `logger.log` is a function → `logger.log(level, message, meta)` (winston's
 *    native form, and also how many winston-alike/compat loggers behave).
 * 2. `logger[level]` is a function → `logger[level](message, meta)` (winston's
 *    convenience methods, e.g. `logger.error(msg, meta)`).
 * 3. Otherwise → `TypeError` at creation. No silent no-ops.
 *
 * `meta` is always a plain object (winston merges it into the log line).
 *
 * Usage:
 * ```ts
 * import winston from 'winston';
 * import { configure } from 'design-contracts';
 * import { winstonAdapter, winstonAuditAdapter } from 'design-contracts/adapters';
 *
 * const logger = winston.createLogger();
 * configure({ mode: 'warn', onViolation: winstonAdapter(logger) });
 * configure({ mode: 'audit', onAudit: winstonAuditAdapter(logger) });
 * ```
 *
 * When `childBindings` is set, the adapter binds a child once at creation and
 * emits through it (requires the logger to expose `.child()`); otherwise the
 * adapter logs through the logger as passed.
 */

import type { ContractViolationError } from '../errors/index.js';
import type { AuditRecord } from '../runtime/index.js';
import { auditLogObject, formatAudit, formatViolation, violationLogObject } from './format.js';

/**
 * Structural shape of a winston logger. Both dispatch styles are supported;
 * see the module docblock for detection order. Real winston loggers satisfy this.
 */
export interface WinstonLikeLogger {
    log?(level: string, message: string, meta?: Record<string, unknown>): unknown;
    child?(bindings: Record<string, unknown>): WinstonLikeLogger;
    readonly [level: string]: unknown;
}

export interface WinstonAdapterOptions {
    /** Level to emit on. Default: `'error'` for violations. */
    readonly level?: string;
    /**
     * Include the violation's sanitized context in the meta object under `context`.
     * Default: `false` — context can carry sensitive data.
     */
    readonly includeContext?: boolean;
    /**
     * When set, the adapter binds a child logger with these bindings at creation
     * time and emits through it. Requires the logger to expose `.child()`.
     */
    readonly childBindings?: Record<string, unknown>;
}

interface ResolvedDispatch {
    readonly dispatch: (message: string, meta: Record<string, unknown>) => void;
}

function resolveDispatch(
    logger: WinstonLikeLogger,
    options: WinstonAdapterOptions,
    defaultLevel: string,
): ResolvedDispatch {
    if (logger === null || typeof logger !== 'object') {
        throw new TypeError(
            'design-contracts: logger must be an object with a .log method or level methods.',
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
    if (typeof target.log === 'function') {
        const log = target.log;
        return {
            dispatch: (message, meta) => {
                log.call(target, level, message, meta);
            },
        };
    }
    const candidate = target[level];
    if (typeof candidate === 'function') {
        return {
            dispatch: (message, meta) => {
                (
                    candidate as (
                        this: WinstonLikeLogger,
                        message: string,
                        meta?: Record<string, unknown>,
                    ) => void
                ).call(target, message, meta);
            },
        };
    }
    throw new TypeError(
        `design-contracts: logger has neither a callable .log method nor a callable "${level}" method. ` +
            "Pass options.level matching one of your logger's levels.",
    );
}

/**
 * Create an `onViolation` handler for a winston-like logger.
 *
 * Emits the one-line violation description as the message and the structured
 * violation fields (including `err`) as meta. Dispatch style is auto-detected
 * at creation; see the module docblock.
 */
export function winstonAdapter(
    logger: WinstonLikeLogger,
    options: WinstonAdapterOptions = {},
): (violation: ContractViolationError) => void {
    const { dispatch } = resolveDispatch(logger, options, 'error');
    const includeContext = options.includeContext === true;
    return (violation) => {
        dispatch(formatViolation(violation), violationLogObject(violation, { includeContext }));
    };
}

/**
 * Create an `onAudit` handler for a winston-like logger.
 *
 * Audit records are not errors, so the default level is `'warn'` (overridable
 * via `options.level`). Emits the one-line audit description as the message and
 * the structured audit fields as meta.
 */
export function winstonAuditAdapter(
    logger: WinstonLikeLogger,
    options: WinstonAdapterOptions = {},
): (record: AuditRecord) => void {
    const { dispatch } = resolveDispatch(logger, options, 'warn');
    return (record) => {
        dispatch(formatAudit(record), auditLogObject(record));
    };
}
