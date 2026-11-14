/**
 * Console adapter — the no-dependency, good-for-examples handler.
 *
 * Emits a single line per violation: `<prefix> <kind> violation in ...: <message>`.
 * Defaults to `console.error`; pass `{ level: 'warn' }` to downgrade, e.g.
 * for `warn`-mode setups where a violation should not look like a crash.
 *
 * Usage:
 * ```ts
 * import { configure } from 'design-contracts';
 * import { consoleAdapter } from 'design-contracts/adapters';
 *
 * configure({ mode: 'warn', onViolation: consoleAdapter({ level: 'warn' }) });
 * ```
 *
 * Fail fast: adapter creation throws a clear `Error` when the host has no
 * usable console, or a `TypeError` for a level other than `'warn' | 'error'`.
 */
import type { ContractViolationError } from '../errors/index.js';
import { formatViolation } from './format.js';

export interface ConsoleAdapterOptions {
    /** Console method to emit on. Default: `'error'`. */
    readonly level?: 'warn' | 'error';
    /** Prefix prepended to the line. Default: `'[design-contracts]'`. Pass `''` to drop it. */
    readonly prefix?: string;
}

interface ConsoleLike {
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

function hostConsole(): ConsoleLike | undefined {
    const candidate = (globalThis as { console?: unknown }).console;
    if (candidate === null || typeof candidate !== 'object') {
        return undefined;
    }
    const warn = (candidate as { warn?: unknown }).warn;
    const error = (candidate as { error?: unknown }).error;
    if (typeof warn !== 'function' || typeof error !== 'function') {
        return undefined;
    }
    return {
        warn: warn.bind(candidate) as (...args: unknown[]) => void,
        error: error.bind(candidate) as (...args: unknown[]) => void,
    };
}

/**
 * Create an `onViolation` handler printing one formatted line to the console.
 * Honors `options.level` (default `'error'`) and `options.prefix`
 * (default `'[design-contracts]'`).
 */
export function consoleAdapter(
    options: ConsoleAdapterOptions = {},
): (violation: ContractViolationError) => void {
    const level = options.level ?? 'error';
    const prefix = options.prefix ?? '[design-contracts]';
    if (level !== 'warn' && level !== 'error') {
        throw new TypeError(
            `design-contracts: options.level must be "warn" or "error", got ${JSON.stringify(level)}.`,
        );
    }
    const console_ = hostConsole();
    if (console_ === undefined) {
        throw new Error(
            'design-contracts: no usable console on this host. Use a logger adapter instead.',
        );
    }
    const emit = level === 'warn' ? console_.warn : console_.error;
    return (violation) => {
        const line =
            prefix.length > 0
                ? `${prefix} ${formatViolation(violation)}`
                : formatViolation(violation);
        emit(line);
    };
}
