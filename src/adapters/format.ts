/**
 * Shared formatting helpers for the logging/telemetry adapters.
 *
 * Why here and not `src/utils/`: nothing outside the adapters consumes these
 * today, and `formatReport(report)` already exists in `src/runtime/context.ts`
 * (it formats a `ViolationReport` for the built-in warn fallback). This module
 * works on the richer `ContractViolationError` (adds `conditionName`) and is
 * shaped for adapter output. Consolidating the two is a lead-level call once
 * `src/index.ts` decides how the public surface re-exports things.
 *
 * Everything here is total — hostile input (cycles, bigints, getters) never
 * throws, it just degrades to a sanitized representation.
 */

import { sanitize } from '../core/sanitize.js';
import type { ContractViolationError } from '../errors/index.js';
import type { AuditRecord } from '../runtime/index.js';

/**
 * One-line description of a violation, e.g.
 * `precondition violation in billing / divide (condition #0) [positive]: amount must be positive`.
 *
 * No leading tag — callers (console adapter, loggers with their own prefixing)
 * decide on branding. Missing parts are dropped, no dangling separators.
 */
export function formatViolation(violation: ContractViolationError): string {
    const parts = [`${violation.kind} violation`];
    const where: string[] = [];
    if (violation.contractName !== undefined && violation.contractName.length > 0) {
        where.push(violation.contractName);
    }
    if (violation.functionName !== undefined && violation.functionName.length > 0) {
        where.push(violation.functionName);
    }
    if (where.length > 0) {
        parts.push(`in ${where.join(' / ')}`);
    }
    if (violation.conditionIndex !== undefined) {
        parts.push(`(condition #${violation.conditionIndex})`);
    }
    if (violation.conditionName !== undefined && violation.conditionName.length > 0) {
        parts.push(`[${violation.conditionName}]`);
    }
    return `${parts.join(' ')}: ${violation.message}`;
}

export interface ViolationLogObjectOptions {
    /**
     * Include the violation's sanitized `context` in the log object under `context`.
     * Default `false` — context can carry sensitive data. When enabled, the
     * context goes through `sanitize` first, so cycles cannot break logging.
     */
    readonly includeContext?: boolean;
}

/**
 * Build the meta object handed to loggers (`logger.error(meta, message)`).
 *
 * Carries `err` (the raw error, so pino's `err` serializer and winston's
 * `error` meta can do their thing) plus the structured violation fields,
 * flat, so log pipelines can index on them without digging through `err`.
 */
export function violationLogObject(
    violation: ContractViolationError,
    options: ViolationLogObjectOptions = {},
): Record<string, unknown> {
    const fields: Record<string, unknown> = {
        err: violation,
        kind: violation.kind,
        mode: violation.mode,
        ...(violation.contractName !== undefined ? { contractName: violation.contractName } : {}),
        ...(violation.functionName !== undefined ? { functionName: violation.functionName } : {}),
        ...(violation.conditionIndex !== undefined
            ? { conditionIndex: violation.conditionIndex }
            : {}),
        ...(violation.conditionName !== undefined
            ? { conditionName: violation.conditionName }
            : {}),
        ...(options.includeContext === true && violation.context !== undefined
            ? { context: sanitize(violation.context) }
            : {}),
    };
    return fields;
}

/**
 * Build the meta object handed to loggers for an audit record.
 * Audit records carry no context, so there is no options bag here.
 */
export function auditLogObject(record: AuditRecord): Record<string, unknown> {
    const fields: Record<string, unknown> = {
        kind: record.kind,
        mode: record.mode,
        timestamp: record.timestamp,
        ...(record.contractName !== undefined ? { contractName: record.contractName } : {}),
        ...(record.functionName !== undefined ? { functionName: record.functionName } : {}),
        ...(record.conditionIndex !== undefined ? { conditionIndex: record.conditionIndex } : {}),
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    };
    return fields;
}

/** Render an audit record as a single log line. */
export function formatAudit(record: AuditRecord): string {
    const parts = [`${record.kind} audit`];
    const where: string[] = [];
    if (record.contractName !== undefined && record.contractName.length > 0) {
        where.push(record.contractName);
    }
    if (record.functionName !== undefined && record.functionName.length > 0) {
        where.push(record.functionName);
    }
    if (where.length > 0) {
        parts.push(`in ${where.join(' / ')}`);
    }
    if (record.conditionIndex !== undefined) {
        parts.push(`(condition #${record.conditionIndex})`);
    }
    return `${parts.join(' ')}: ${record.message}`;
}
