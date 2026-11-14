/**
 * @internal Host detection without type definitions for node globals.
 * Reads `process`/`console` off `globalThis` so this package does not depend
 * on @types/node, and so non-node hosts degrade gracefully instead of crashing.
 */

/** Minimal structural shape of node's process object that we rely on. */
export interface NodeProcess {
    env: Record<string, string | undefined>;
    cwd?(): string;
}

/** Minimal structural shape of console that we rely on. */
export interface ConsoleLike {
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

/** The host process object, or undefined outside node-like environments. */
export function hostProcess(): NodeProcess | undefined {
    const candidate = (globalThis as { process?: unknown }).process;
    if (candidate === null || typeof candidate !== 'object') {
        return undefined;
    }
    const env = (candidate as { env?: unknown }).env;
    if (env === null || typeof env !== 'object') {
        return undefined;
    }
    const cwd = (candidate as { cwd?: unknown }).cwd;
    const result: NodeProcess = { env: env as Record<string, string | undefined> };
    if (typeof cwd === 'function') {
        result.cwd = cwd as () => string;
    }
    return result;
}

function noop(): void {
    // intentionally empty: silent host keeps the library working
}

/** Console to write user-facing diagnostics to; no-ops on hosts without one. */
export function hostConsole(): ConsoleLike {
    const candidate = (globalThis as { console?: unknown }).console;
    if (candidate === null || typeof candidate !== 'object') {
        return { warn: noop, error: noop };
    }
    const warn = (candidate as { warn?: unknown }).warn;
    const error = (candidate as { error?: unknown }).error;
    return {
        warn:
            typeof warn === 'function'
                ? (warn as (...args: unknown[]) => void).bind(candidate)
                : noop,
        error:
            typeof error === 'function'
                ? (error as (...args: unknown[]) => void).bind(candidate)
                : noop,
    };
}
