/**
 * Scoped runtime context for design-contracts.
 *
 * `withConfig()` layers a partial configuration on top of the global one for
 * the duration of a callback, without touching global state. It uses
 * `AsyncLocalStorage` when available (node >= 12.20, bun, deno) so scopes
 * propagate across `await`s; otherwise it falls back to a global stack that
 * only wraps synchronous execution (the scope is popped before any returned
 * promise settles  -  documented limitation, scoped checks inside async
 * continuations will then see the outer config).
 *
 * AsyncLocalStorage detection is lazy: nothing is probed at import time, the
 * first actual use of the ALS layer resolves it (and caches the result).
 * Importing the package never touches node builtins. The probe is layered,
 * mirroring the diagnostics-channel adapter:
 * 1. `process.getBuiltinModule('async_hooks')` (node >= 20.16 / >= 22.3, bun)
 * 2. `process.getBuiltinModule('module').createRequire(...)` → `node:async_hooks` (older node ESM)
 * 3. plain `require('node:async_hooks')` (CJS)
 *
 * Hot path notes: `getEffectiveConfig()` and `canSkip()` are O(1) with no
 * allocations on repeated calls with the same scope chain. Resolution is
 * cached against a generation counter bumped by `configure()`/`resetConfig()`,
 * and per-scope merges are cached on the scope node identity via a WeakMap,
 * so a scope created once and used for many calls resolves once.
 */

import type { ContractViolationError } from '../errors/base.js';
import { isContractsCompiledIn } from '../utils/build-flag.js';
import type { AuditRecord, ContractConfig, ResolvedConfig, ViolationReport } from './config.js';
import {
    assertValidConfig,
    getGeneration,
    resolveBaseConfig,
    resolveWithLayers,
    snapshotConfig,
    withContractMode,
} from './config.js';
import { hostConsole } from './host.js';
import type { Mode, ViolationCategory } from './modes.js';

interface ScopeNode {
    local: ContractConfig;
    parent: ScopeNode | undefined;
}

interface AsyncLocalStorageLike<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
}

interface ProcessWithGetBuiltinModule {
    getBuiltinModule?: (id: string) => unknown;
    cwd?: () => string;
}

const processWithProbe = (): ProcessWithGetBuiltinModule | undefined => {
    const candidate = (globalThis as { process?: unknown }).process;
    if (candidate === null || typeof candidate !== 'object') {
        return undefined;
    }
    return candidate as ProcessWithGetBuiltinModule;
};

const asAsyncLocalStorageCtor = (
    value: unknown,
): (new () => AsyncLocalStorageLike<ScopeNode>) | undefined => {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const ctor = (value as { AsyncLocalStorage?: unknown }).AsyncLocalStorage;
    return typeof ctor === 'function'
        ? (ctor as new () => AsyncLocalStorageLike<ScopeNode>)
        : undefined;
};

// layer 1 — process.getBuiltinModule('async_hooks') (node >= 20.16 / >= 22.3, bun)
const probeViaGetBuiltinModule = (): AsyncLocalStorageLike<ScopeNode> | undefined => {
    const proc = processWithProbe();
    const getBuiltinModule = proc?.getBuiltinModule;
    if (typeof getBuiltinModule !== 'function') {
        return undefined;
    }
    try {
        const ctor = asAsyncLocalStorageCtor(getBuiltinModule.call(proc, 'async_hooks'));
        return ctor === undefined ? undefined : new ctor();
    } catch {
        return undefined;
    }
};

// layer 2 — createRequire from the module builtin (older node ESM)
const probeViaCreateRequire = (): AsyncLocalStorageLike<ScopeNode> | undefined => {
    const proc = processWithProbe();
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
        const ctor = asAsyncLocalStorageCtor(require_('node:async_hooks'));
        return ctor === undefined ? undefined : new ctor();
    } catch {
        return undefined;
    }
};

// layer 3 — plain require('node:async_hooks') (CJS builds, CommonJS-ish hosts)
const probeViaPlainRequire = (): AsyncLocalStorageLike<ScopeNode> | undefined => {
    const candidate = (globalThis as { require?: unknown }).require;
    if (typeof candidate !== 'function') {
        return undefined;
    }
    try {
        const ctor = asAsyncLocalStorageCtor(
            (candidate as (id: string) => unknown)('node:async_hooks'),
        );
        return ctor === undefined ? undefined : new ctor();
    } catch {
        return undefined;
    }
};

// null = not probed yet. Probed once, lazily, then cached forever.
let als: AsyncLocalStorageLike<ScopeNode> | undefined | null = null;
const fallbackStack: ScopeNode[] = [];

const asyncLocalStorage = (): AsyncLocalStorageLike<ScopeNode> | undefined => {
    if (als === null) {
        als = probeViaGetBuiltinModule() ?? probeViaCreateRequire() ?? probeViaPlainRequire();
    }
    return als ?? undefined;
};

// scope node identity -> resolved config, guarded by generation
const scopeCache = new WeakMap<ScopeNode, { generation: number; resolved: ResolvedConfig }>();
// resolved config -> per-contract mode overrides, so per-call merges do not allocate
const overrideCache = new WeakMap<ResolvedConfig, Partial<Record<Mode, ResolvedConfig>>>();

function currentScopeNode(): ScopeNode | undefined {
    const store = asyncLocalStorage();
    if (store !== undefined) {
        return store.getStore();
    }
    return fallbackStack.at(-1);
}

/**
 * Resolve the effective configuration: per-contract mode (if given) over
 * scoped `withConfig()` layers over global `configure()` over environment.
 * The returned object is immutable and cached  -  do not mutate it.
 */
export function getEffectiveConfig(contractMode?: Mode): ResolvedConfig {
    const node = currentScopeNode();
    let resolved: ResolvedConfig;
    if (node === undefined) {
        resolved = resolveBaseConfig();
    } else {
        const cached = scopeCache.get(node);
        const generation = getGeneration();
        if (cached?.generation === generation) {
            resolved = cached.resolved;
        } else {
            // unwind the chain, then apply outermost -> innermost
            const outermostFirst: ContractConfig[] = [];
            for (
                let current: ScopeNode | undefined = node;
                current !== undefined;
                current = current.parent
            ) {
                outermostFirst.push(current.local);
            }
            outermostFirst.reverse();
            resolved = resolveWithLayers(outermostFirst);
            scopeCache.set(node, { generation, resolved });
        }
    }
    if (contractMode === undefined) {
        return resolved;
    }
    if (resolved.mode === contractMode) {
        return resolved;
    }
    let perMode = overrideCache.get(resolved);
    if (perMode === undefined) {
        perMode = {};
        overrideCache.set(resolved, perMode);
    }
    const hit = perMode[contractMode];
    if (hit !== undefined) {
        return hit;
    }
    const merged = withContractMode(resolved, contractMode);
    perMode[contractMode] = merged;
    return merged;
}

/**
 * Cheap predicate fast-path check. Returns `true` when the predicate for
 * `category` does not need to run: effective mode is `off`/`silent`, or the
 * category is disabled in every applicable layer.
 *
 * O(1), allocation-free on hot paths. Call this once per check site instead
 * of re-resolving the configuration manually.
 *
 * When the bundle was built with `__DESIGN_CONTRACTS_ENABLED__` defined as
 * `false`, predicates are compiled out entirely: this returns `true` before
 * touching the configuration, so no predicate ever runs in that build.
 */
export function canSkip(category: ViolationCategory, contractMode?: Mode): boolean {
    // contracts compiled out: always skip, don't even resolve the config.
    // the flag folds to a constant under a define; physical removal of the
    // branch below depends on the minifier inlining isContractsCompiledIn()
    if (!isContractsCompiledIn()) {
        return true;
    }
    const resolved = getEffectiveConfig(contractMode);
    return resolved.skipPredicates || resolved.disabled.has(category);
}

/**
 * Run `fn` with `config` layered over the current configuration (global,
 * or the enclosing `withConfig()` scope). Nothing is mutated globally and
 * the override disappears when `fn` returns. Works for async callbacks
 * when `AsyncLocalStorage` is available.
 *
 * @returns whatever `fn` returns.
 * @throws {TypeError} when `config` fails validation.
 */
export function withConfig<R>(config: ContractConfig, fn: () => R): R {
    assertValidConfig(config, 'withConfig');
    const store = asyncLocalStorage();
    const node: ScopeNode = { local: snapshotConfig(config), parent: currentScopeNode() };
    if (store !== undefined) {
        return store.run(node, fn);
    }
    fallbackStack.push(node);
    try {
        return fn();
    } finally {
        // pop our own frame even if fn threw; never pop blindly so nested
        // frames stay balanced when fn re-enters withConfig synchronously
        const index = fallbackStack.lastIndexOf(node);
        if (index !== -1) {
            fallbackStack.splice(index, 1);
        }
    }
}

/** Compact one-line description of a violation for default console output. */
export function formatReport(report: ViolationReport): string {
    const parts = [`[design-contracts] ${report.kind} violation`];
    const where: string[] = [];
    if (report.contractName !== undefined) where.push(report.contractName);
    if (report.functionName !== undefined) where.push(report.functionName);
    if (where.length > 0) parts.push(`in ${where.join(' / ')}`);
    if (report.conditionIndex !== undefined) parts.push(`(condition #${report.conditionIndex})`);
    return `${parts.join(' ')}: ${report.message}`;
}

function formatCause(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
}

/**
 * Dispatch a violation according to the effective mode.
 *
 * - `strict`  -  throws `error` (handlers are not called).
 * - `warn`  -  calls `onViolation` if set (handler failures are caught and
 *   logged, they never replace the control flow); otherwise writes a
 *   compact `console.warn` line. Execution continues either way.
 * - `silent` / `off`  -  no-op.
 * - `audit`  -  builds an `AuditRecord` and sends it to `onAudit` (if set),
 *   then to `onViolation` (if set). Handler failures are caught and logged.
 *   With neither handler configured the record is dropped  -  the library
 *   keeps no hidden audit log by design.
 */
export function reportViolation(
    report: ViolationReport,
    error: ContractViolationError,
    contractMode?: Mode,
): void {
    const resolved = getEffectiveConfig(contractMode);
    const host = hostConsole();
    switch (resolved.mode) {
        case 'strict':
            throw error;
        case 'warn': {
            const handler = resolved.onViolation;
            if (handler !== undefined) {
                try {
                    handler(error);
                } catch (handlerError) {
                    host.error(
                        `[design-contracts] onViolation handler threw: ${formatCause(handlerError)}`,
                    );
                }
            } else {
                host.warn(formatReport(report));
            }
            return;
        }
        case 'silent':
        case 'off':
            return;
        case 'audit': {
            const record: AuditRecord = {
                kind: report.kind,
                message: report.message,
                timestamp: Date.now(),
                mode: resolved.mode,
                ...(report.contractName !== undefined ? { contractName: report.contractName } : {}),
                ...(report.functionName !== undefined ? { functionName: report.functionName } : {}),
                ...(report.conditionIndex !== undefined
                    ? { conditionIndex: report.conditionIndex }
                    : {}),
                ...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
            };
            const auditHandler = resolved.onAudit;
            if (auditHandler !== undefined) {
                try {
                    auditHandler(record);
                } catch (handlerError) {
                    host.error(
                        `[design-contracts] onAudit handler threw: ${formatCause(handlerError)}`,
                    );
                }
            }
            const violationHandler = resolved.onViolation;
            if (violationHandler !== undefined) {
                try {
                    violationHandler(error);
                } catch (handlerError) {
                    host.error(
                        `[design-contracts] onViolation handler threw: ${formatCause(handlerError)}`,
                    );
                }
            }
            return;
        }
    }
}
