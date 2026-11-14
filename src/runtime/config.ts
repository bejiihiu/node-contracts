/**
 * Global runtime configuration for node-contracts.
 *
 * Resolution order (highest priority first):
 *
 * 1. Per-contract mode (`contractMode` argument) - only overrides the mode,
 *    never the handlers.
 * 2. Scoped overrides set by `withConfig()` (AsyncLocalStorage when
 *    available) - merged over the global config.
 * 3. Global config set by `configure()`.
 * 4. Environment: `NODE_CONTRACTS_MODE` when set; otherwise
 *    `NODE_ENV === 'production' ? 'off' : 'strict'`. Unknown
 *    `NODE_CONTRACTS_MODE` values fall back to `strict` with a one-time
 *    `console.warn`.
 *
 * Handler merging: a scoped config inherits handlers it does not define
 * from the next outer layer. `disabled` is a union across all layers -
 * an inner scope can add disabled categories but cannot re-enable ones
 * disabled outer.
 */

import { hostConsole, hostProcess } from './host';
import { isMode, isViolationCategory, MODES, VIOLATION_CATEGORIES } from './modes';
import type { Mode, ViolationCategory } from './modes';

/** A single audit entry emitted in `audit` mode. `timestamp` is `Date.now()`. */
export interface AuditRecord {
    readonly kind: ViolationCategory;
    readonly message: string;
    readonly timestamp: number;
    readonly mode: Mode;
    readonly contractName?: string;
    readonly functionName?: string;
    readonly conditionIndex?: number;
    readonly durationMs?: number;
}

/**
 * Partial configuration accepted by `configure()` and `withConfig()`.
 * Only declared fields participate in resolution; absent fields inherit.
 */
export interface ContractConfig {
    mode?: Mode;
    /** Called for every violation in `warn` mode and (if set) in `audit` mode. */
    onViolation?: (error: Error) => void;
    /** Called for every violation in `audit` mode. */
    onAudit?: (record: AuditRecord) => void;
    /** Violation categories to skip entirely (preconditions, postconditions, ...). */
    disabled?: readonly ViolationCategory[];
    /** Capture a stack trace when construction violation errors. Default: true. */
    captureStack?: boolean;
    /** Fallback message used when a predicate neither returns nor throws a useful message. */
    defaultMessage?: string;
}

/** Fully resolved, immutable configuration. Safe to hold and compare. */
export interface ResolvedConfig {
    readonly mode: Mode;
    readonly onViolation: ((error: Error) => void) | undefined;
    readonly onAudit: ((record: AuditRecord) => void) | undefined;
    readonly disabled: ReadonlySet<ViolationCategory>;
    readonly captureStack: boolean;
    readonly defaultMessage: string | undefined;
    /** True when predicates must not be evaluated at all (`off` or `silent`). */
    readonly skipPredicates: boolean;
}

/** A violation, described structurally so core does not need to know the error classes. */
export interface ViolationReport {
    readonly kind: ViolationCategory;
    readonly message: string;
    readonly contractName?: string;
    readonly functionName?: string;
    readonly conditionIndex?: number;
    readonly durationMs?: number;
}

const DEFAULT_CAPTURE_STACK = true;

let globalConfig: ContractConfig = {};
let generation = 0;
let envWarned = false;

// generation-guarded resolution cache - hot path must not re-merge per call
let cachedGeneration = -1;
let cachedBase: ResolvedConfig | undefined;

export function getGeneration(): number {
    return generation;
}

export function isSkipPredicatesMode(mode: Mode): boolean {
    return mode === 'off' || mode === 'silent';
}

function readEnvMode(): Mode {
    const env = hostProcess()?.env;
    const raw = env?.['NODE_CONTRACTS_MODE'];
    if (raw !== undefined && raw !== '') {
        const normalized = raw.trim().toLowerCase();
        if (isMode(normalized)) {
            return normalized;
        }
        if (!envWarned) {
            envWarned = true;
            hostConsole().warn(
                `[node-contracts] Unknown NODE_CONTRACTS_MODE "${raw}", falling back to "strict". ` +
                    `Valid values: ${MODES.join(', ')}.`,
            );
        }
        return 'strict';
    }
    return env?.['NODE_ENV'] === 'production' ? 'off' : 'strict';
}

interface MutableResolved {
    mode: Mode;
    onViolation: ((error: Error) => void) | undefined;
    onAudit: ((record: AuditRecord) => void) | undefined;
    disabled: Set<ViolationCategory>;
    captureStack: boolean;
    defaultMessage: string | undefined;
}

function emptyMutable(): MutableResolved {
    return {
        mode: 'strict',
        onViolation: undefined,
        onAudit: undefined,
        disabled: new Set(),
        captureStack: DEFAULT_CAPTURE_STACK,
        defaultMessage: undefined,
    };
}

function applyLayer(target: MutableResolved, layer: ContractConfig): void {
    if (layer.mode !== undefined) target.mode = layer.mode;
    if (layer.onViolation !== undefined) target.onViolation = layer.onViolation;
    if (layer.onAudit !== undefined) target.onAudit = layer.onAudit;
    if (layer.disabled !== undefined) {
        for (const category of layer.disabled) target.disabled.add(category);
    }
    if (layer.captureStack !== undefined) target.captureStack = layer.captureStack;
    if (layer.defaultMessage !== undefined) target.defaultMessage = layer.defaultMessage;
}

function finalize(mutable: MutableResolved): ResolvedConfig {
    return {
        mode: mutable.mode,
        onViolation: mutable.onViolation,
        onAudit: mutable.onAudit,
        disabled: mutable.disabled,
        captureStack: mutable.captureStack,
        defaultMessage: mutable.defaultMessage,
        skipPredicates: isSkipPredicatesMode(mutable.mode),
    };
}

/** Resolve the effective config from the global layer + env only (no scopes, no contractMode). */
export function resolveBaseConfig(): ResolvedConfig {
    if (cachedGeneration === generation && cachedBase !== undefined) {
        return cachedBase;
    }
    const mutable = emptyMutable();
    // env first so configure() layers can override it
    mutable.mode = readEnvMode();
    applyLayer(mutable, globalConfig);
    const resolved = finalize(mutable);
    cachedGeneration = generation;
    cachedBase = resolved;
    return resolved;
}

/** Merge a list of scope layers (outermost first) on top of the base resolution. */
export function resolveWithLayers(outermostFirst: readonly ContractConfig[]): ResolvedConfig {
    const base = resolveBaseConfig();
    if (outermostFirst.length === 0) {
        return base;
    }
    const mutable: MutableResolved = {
        mode: base.mode,
        onViolation: base.onViolation,
        onAudit: base.onAudit,
        disabled: new Set(base.disabled),
        captureStack: base.captureStack,
        defaultMessage: base.defaultMessage,
    };
    for (const layer of outermostFirst) {
        applyLayer(mutable, layer);
    }
    return finalize(mutable);
}

/** Resolve with a per-contract mode override layered on top of `resolved`. */
export function withContractMode(resolved: ResolvedConfig, contractMode: Mode): ResolvedConfig {
    if (resolved.mode === contractMode) {
        return resolved;
    }
    return {
        ...resolved,
        mode: contractMode,
        skipPredicates: isSkipPredicatesMode(contractMode),
    };
}

/** @internal Exported for sibling runtime modules and tests; validates and throws on bad input. */
export function assertValidConfig(config: ContractConfig, source: string): void {
    if (config.mode !== undefined && !isMode(config.mode)) {
        throw new TypeError(
            `${source}: invalid mode ${JSON.stringify(config.mode)}. Valid values: ${MODES.join(', ')}.`,
        );
    }
    if (config.onViolation !== undefined && typeof config.onViolation !== 'function') {
        throw new TypeError(`${source}: onViolation must be a function.`);
    }
    if (config.onAudit !== undefined && typeof config.onAudit !== 'function') {
        throw new TypeError(`${source}: onAudit must be a function.`);
    }
    if (config.disabled !== undefined) {
        if (!Array.isArray(config.disabled)) {
            throw new TypeError(`${source}: disabled must be an array of violation categories.`);
        }
        for (const category of config.disabled) {
            if (!isViolationCategory(category)) {
                throw new TypeError(
                    `${source}: invalid disabled category ${JSON.stringify(category)}. ` +
                        `Valid values: ${VIOLATION_CATEGORIES.join(', ')}.`,
                );
            }
        }
    }
    if (config.captureStack !== undefined && typeof config.captureStack !== 'boolean') {
        throw new TypeError(`${source}: captureStack must be a boolean.`);
    }
    if (config.defaultMessage !== undefined && typeof config.defaultMessage !== 'string') {
        throw new TypeError(`${source}: defaultMessage must be a string.`);
    }
}

/** @internal Exported for sibling runtime modules; returns a defensive shallow copy with undefined keys dropped. */
export function snapshotConfig(config: ContractConfig): ContractConfig {
    const copy: ContractConfig = {};
    if (config.mode !== undefined) copy.mode = config.mode;
    if (config.onViolation !== undefined) copy.onViolation = config.onViolation;
    if (config.onAudit !== undefined) copy.onAudit = config.onAudit;
    if (config.disabled !== undefined) copy.disabled = [...config.disabled];
    if (config.captureStack !== undefined) copy.captureStack = config.captureStack;
    if (config.defaultMessage !== undefined) copy.defaultMessage = config.defaultMessage;
    return copy;
}

/**
 * Merge `config` into the global runtime configuration.
 *
 * Fields set to `undefined` are left untouched; use `resetConfig()` to clear
 * the global configuration back to environment defaults.
 *
 * @returns the previous global configuration (shallow copy), useful for save/restore in tests.
 * @throws {TypeError} when a value fails validation (unknown mode/category, wrong handler type).
 */
export function configure(config: ContractConfig): ContractConfig {
    if (config === null || typeof config !== 'object') {
        throw new TypeError('configure: expected a configuration object.');
    }
    assertValidConfig(config, 'configure');
    const previous = snapshotConfig(globalConfig);
    // merge: new object so identity changes and stale caches can never leak.
    // explicit undefined in the patch means "not provided" - strip it instead
    // of letting it clobber an inherited value.
    const patch = snapshotConfig(config);
    globalConfig = { ...globalConfig, ...patch };
    generation += 1;
    cachedGeneration = -1;
    cachedBase = undefined;
    return previous;
}

/** Return a shallow copy of the current global configuration (env defaults are not materialized). */
export function getConfig(): ContractConfig {
    return snapshotConfig(globalConfig);
}

/**
 * Reset the global configuration to empty (environment-driven resolution).
 * Intended for tests. Does not touch scoped `withConfig()` frames - those
 * end when their callback returns.
 *
 * @returns the configuration that was in place before the reset.
 */
export function resetConfig(): ContractConfig {
    const previous = snapshotConfig(globalConfig);
    globalConfig = {};
    envWarned = false;
    generation += 1;
    cachedGeneration = -1;
    cachedBase = undefined;
    return previous;
}


