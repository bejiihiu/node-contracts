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
 * Hot path notes: `getEffectiveConfig()` and `canSkip()` are O(1) with no
 * allocations on repeated calls with the same scope chain. Resolution is
 * cached against a generation counter bumped by `configure()`/`resetConfig()`,
 * and per-scope merges are cached on the scope node identity via a WeakMap,
 * so a scope created once and used for many calls resolves once.
 */

import { createRequire } from 'node:module';
import { isContractsCompiledIn } from '../utils/build-flag';
import type { ContractViolationError } from '../errors/base.js';
import {
    assertValidConfig,
    getGeneration,
    resolveBaseConfig,
    resolveWithLayers,
    snapshotConfig,
    withContractMode,
} from './config';
import type {
    AuditRecord,
    ContractConfig,
    ResolvedConfig,
    ViolationReport,
} from './config';
import { hostConsole, hostProcess } from './host';
import type { Mode, ViolationCategory } from './modes';

interface ScopeNode {
    local: ContractConfig;
    parent: ScopeNode | undefined;
}

interface AsyncLocalStorageLike<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
}

function detectAsyncLocalStorage(): AsyncLocalStorageLike<ScopeNode> | undefined {
    try {
        // createRequire keeps this import-safe: the require() call is what
        // actually probes for node:async_hooks, so environments without it
        // fall back instead of failing module load.
        const cwd = hostProcess()?.cwd?.() ?? '/';
        const require_ = createRequire(`${cwd}/design-contracts.cjs`);
        const mod = require_('node:async_hooks') as {
            AsyncLocalStorage?: new () => AsyncLocalStorageLike<ScopeNode>;
        };
        if (mod === null || typeof mod !== 'object' || typeof mod.AsyncLocalStorage !== 'function') {
            return undefined;
        }
        return new mod.AsyncLocalStorage();
    } catch {
        return undefined;
    }
}

const als = detectAsyncLocalStorage();
const fallbackStack: ScopeNode[] = [];

// scope node identity -> resolved config, guarded by generation
const scopeCache = new WeakMap<ScopeNode, { generation: number; resolved: ResolvedConfig }>();
// resolved config -> per-contract mode overrides, so per-call merges do not allocate
const overrideCache = new WeakMap<ResolvedConfig, Partial<Record<Mode, ResolvedConfig>>>();

function currentScopeNode(): ScopeNode | undefined {
    if (als) {
        return als.getStore();
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
            for (let current: ScopeNode | undefined = node; current !== undefined; current = current.parent) {
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
    const node: ScopeNode = { local: snapshotConfig(config), parent: currentScopeNode() };
    if (als) {
        return als.run(node, fn);
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
export function formatViolation(report: ViolationReport): string {
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
                    host.error(`[design-contracts] onViolation handler threw: ${formatCause(handlerError)}`);
                }
            } else {
                host.warn(formatViolation(report));
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
                ...(report.conditionIndex !== undefined ? { conditionIndex: report.conditionIndex } : {}),
                ...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
            };
            const auditHandler = resolved.onAudit;
            if (auditHandler !== undefined) {
                try {
                    auditHandler(record);
                } catch (handlerError) {
                    host.error(`[design-contracts] onAudit handler threw: ${formatCause(handlerError)}`);
                }
            }
            const violationHandler = resolved.onViolation;
            if (violationHandler !== undefined) {
                try {
                    violationHandler(error);
                } catch (handlerError) {
                    host.error(`[design-contracts] onViolation handler threw: ${formatCause(handlerError)}`);
                }
            }
            return;
        }
    }
}
