/**
 * Adapters publishing contract events on `node:diagnostics_channel`.
 *
 * Two named channels (stable since Node 15.1, `diagnostics_channel` itself is
 * marked stable in modern Node):
 *
 * - `design-contracts:violation` — one event per violation: `{ violation }`
 * - `design-contracts:audit`     — one event per audit record: `{ record }`
 *
 * Subscribers can get the channel two ways: with this module (helpers below)
 * or by name via `diagnostics_channel.channel(name)` — the registry is global,
 * so both return the same channel instance. Subscribing from outside costs
 * nothing when nobody publishes.
 *
 * Fail fast, not silent: `diagnosticsChannelAdapter()` /
 * `diagnosticsChannelAuditAdapter()` probe for `node:diagnostics_channel` at
 * creation time and throw a clear `Error` when it is unavailable (some edge
 * runtimes). There is deliberately no silent no-op mode — a violation that
 * goes nowhere is worse than a loud misconfiguration. The module itself stays
 * import-safe everywhere: no node builtin is touched at module top level.
 *
 * The probe is layered, in order:
 * 1. `process.getBuiltinModule('diagnostics_channel')` (node >= 20.16 / >= 22.3, bun)
 * 2. `process.getBuiltinModule('module').createRequire(...)` → `diagnostics_channel` (older node ESM)
 * 3. plain `require('node:diagnostics_channel')` (CJS)
 */

import type { ContractViolationError } from '../errors/index.js';
import type { AuditRecord } from '../runtime/index.js';

/** Channel name used by `diagnosticsChannelAdapter`. */
export const CONTRACTS_VIOLATION_CHANNEL = 'design-contracts:violation';
/** Channel name used by `diagnosticsChannelAuditAdapter`. */
export const CONTRACTS_AUDIT_CHANNEL = 'design-contracts:audit';

/** Structural shape of a diagnostics_channel Channel — anything with `publish` works. */
export interface ChannelLike {
    publish(message: unknown): void;
    readonly hasSubscribers?: boolean;
}

/** Structural shape of the diagnostics_channel module — only what we use. */
export interface DiagnosticsChannelModule {
    channel(name: string | symbol): ChannelLike;
}

interface ProcessWithGetBuiltinModule {
    getBuiltinModule?: (id: string) => unknown;
    cwd?: () => string;
}

function asDiagnosticsChannelModule(value: unknown): DiagnosticsChannelModule | undefined {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const channel = (value as { channel?: unknown }).channel;
    if (typeof channel !== 'function') {
        return undefined;
    }
    return value as DiagnosticsChannelModule;
}

function probeViaGetBuiltinModule(): DiagnosticsChannelModule | undefined {
    const proc = (globalThis as { process?: unknown }).process as
        | ProcessWithGetBuiltinModule
        | undefined;
    const getBuiltinModule = proc?.getBuiltinModule;
    if (typeof getBuiltinModule !== 'function') {
        return undefined;
    }
    try {
        return asDiagnosticsChannelModule(getBuiltinModule.call(proc, 'diagnostics_channel'));
    } catch {
        // not available under that exact name — try the createRequire route below
        return undefined;
    }
}

function probeViaCreateRequire(): DiagnosticsChannelModule | undefined {
    const proc = (globalThis as { process?: unknown }).process as
        | ProcessWithGetBuiltinModule
        | undefined;
    const getBuiltinModule = proc?.getBuiltinModule;
    if (typeof getBuiltinModule !== 'function') {
        return undefined;
    }
    try {
        const moduleModule = getBuiltinModule.call(proc, 'module') as
            | { createRequire?: (filename: string) => (id: string) => unknown }
            | undefined;
        if (typeof moduleModule?.createRequire !== 'function') {
            return undefined;
        }
        const cwd = typeof proc?.cwd === 'function' ? proc.cwd() : '/';
        const require_ = moduleModule.createRequire(`${cwd}/design-contracts.cjs`);
        return asDiagnosticsChannelModule(require_('node:diagnostics_channel'));
    } catch {
        return undefined;
    }
}

function probeViaPlainRequire(): DiagnosticsChannelModule | undefined {
    // CJS builds and CommonJS-ish hosts (bun in CJS mode, some electron setups)
    const candidate = (globalThis as { require?: unknown }).require;
    if (typeof candidate !== 'function') {
        return undefined;
    }
    try {
        return asDiagnosticsChannelModule(
            (candidate as (id: string) => unknown)('node:diagnostics_channel'),
        );
    } catch {
        return undefined;
    }
}

/**
 * Resolve `node:diagnostics_channel` on this runtime, or throw a clear `Error`.
 * Exported for subscribers that want the same fail-fast probe.
 */
export function loadDiagnosticsChannel(): DiagnosticsChannelModule {
    const mod = probeViaGetBuiltinModule() ?? probeViaCreateRequire() ?? probeViaPlainRequire();
    if (mod === undefined) {
        throw new Error(
            'design-contracts: node:diagnostics_channel is not available on this runtime ' +
                '(needs node >= 15.1 or bun). Use consoleAdapter or a logger adapter instead.',
        );
    }
    return mod;
}

function acquireChannel(name: string): ChannelLike {
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new TypeError('design-contracts: channel name must be a non-empty string.');
    }
    const mod = loadDiagnosticsChannel();
    const channel = mod.channel(name);
    if (channel === null || typeof channel !== 'object' || typeof channel.publish !== 'function') {
        throw new Error(
            `design-contracts: diagnostics_channel returned an unusable channel for "${name}".`,
        );
    }
    return channel;
}

/** The `design-contracts:violation` channel (created lazily, throws on unsupported runtimes). */
export function getViolationChannel(): ChannelLike {
    return acquireChannel(CONTRACTS_VIOLATION_CHANNEL);
}

/** The `design-contracts:audit` channel (created lazily, throws on unsupported runtimes). */
export function getAuditChannel(): ChannelLike {
    return acquireChannel(CONTRACTS_AUDIT_CHANNEL);
}

/**
 * Create an `onViolation` handler publishing `{ violation }` on a diagnostics channel.
 * Defaults to `design-contracts:violation`; pass `channelName` for a custom channel.
 * Subscribers receive the raw error object — they should treat its fields as read-only.
 */
export function diagnosticsChannelAdapter(
    channelName: string = CONTRACTS_VIOLATION_CHANNEL,
): (violation: ContractViolationError) => void {
    const channel = acquireChannel(channelName);
    return (violation) => {
        channel.publish({ violation });
    };
}

/**
 * Create an `onAudit` handler publishing `{ record }` on a diagnostics channel.
 * Defaults to `design-contracts:audit`; pass `channelName` for a custom channel.
 */
export function diagnosticsChannelAuditAdapter(
    channelName: string = CONTRACTS_AUDIT_CHANNEL,
): (record: AuditRecord) => void {
    const channel = acquireChannel(channelName);
    return (record) => {
        channel.publish({ record });
    };
}
