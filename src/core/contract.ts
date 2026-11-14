/**
 * Function contracts — `contract(fn, options)` wraps `fn` with preconditions,
 * postconditions and on-error checks.
 *
 * A contract never changes `fn`'s public signature: the wrapper preserves
 * `fn.length` and `fn.name`, and honours whatever `this` value the call site
 * provides. Sync functions stay synchronous; functions returning a thenable
 * produce one derived promise that runs the post/on-error phases.
 *
 * Enforcement is controlled by the global/scoped runtime configuration plus
 * the per-contract `mode` option. `off`/`silent` never execute predicates —
 * when every category is skipped and no `old` snapshot is needed, the wrapper
 * degrades to a raw `fn.apply(...)` fast path.
 *
 * ## Config snapshot semantics
 *
 * The wrapper resolves the effective config ONCE, at call entry. The resolved
 * config (and the per-category skip decisions derived from it) is captured by
 * the call and reused by every later phase of that same call: postconditions,
 * on-error checks and the async continuation all see the entry-time config.
 *
 * Consequence (edge case, deliberate): if `configure()` or `withConfig()` runs
 * *while a call is in flight* — e.g. inside `fn` itself, or between the
 * promise resolving and the postcondition phase — the in-flight call does NOT
 * observe the new configuration. Before this optimization the async
 * continuation re-resolved the config at phase time and could pick up the
 * change. The trade is one `getEffectiveConfig()` per call instead of one per
 * phase; the observable behavior changes only for mid-flight reconfiguration
 * of an already-running call, which is not a supported pattern (handlers and
 * modes are process-wide; flipping them under a running call is racy by
 * definition). Violation *dispatch* inside `reportViolation()` still resolves
 * the effective mode at report time — it is the rare path and correctness
 * there is free.
 *
 * @example
 * ```ts
 * import { contract } from './index.js';
 *
 * const divide = contract(
 *     (a: number, b: number) => a / b,
 *     { pre: [(a, b) => b !== 0] },
 * );
 * divide(10, 2); // 5
 * divide(10, 0); // throws PreconditionViolationError
 * ```
 *
 * @example Async function — postconditions see the resolved result:
 * ```ts
 * const fetchUser = contract(
 *     async (id: string) => database.users.findById(id),
 *     {
 *         pre: [(id) => id.length > 0],
 *         post: [(user) => user !== null],
 *     },
 * );
 * ```
 */

import type { OldSpec, OldValues } from '../contracts/old.js';
import { snapshotArgs } from '../contracts/old.js';
import type {
    ContractMode,
    ContractViolationDetails,
    ContractViolationError,
} from '../errors/base.js';
import { OnErrorViolationError } from '../errors/on-error.js';
import { PostconditionViolationError } from '../errors/postcondition.js';
import { PreconditionViolationError } from '../errors/precondition.js';
import type { Mode, ResolvedConfig, ViolationCategory } from '../runtime/index.js';
import { getEffectiveConfig, reportViolation } from '../runtime/index.js';
import { isContractsCompiledIn } from '../utils/build-flag';
import { isThenable } from '../utils/thenable.js';
import type { NamedCondition } from './condition.js';
import { condition, isNamedCondition } from './condition.js';
import type { ContractMetadata } from './inheritance.js';

/** Unwraps a promise-like result type, falling back to `R` itself. */
type UnwrapPromise<R> = R extends PromiseLike<infer T> ? T : R;

/**
 * A precondition accepts named conditions or bare predicates.
 *
 * Bare predicates receive the call arguments spread out — exactly like
 * `fn` itself — and may return any truthy/falsy value (see
 * {@link ContractOptions.pre} for the coercion rule):
 *
 * ```ts
 * pre: [(amount: number) => amount > 0]
 * ```
 */
export type ConditionPredicate<A extends unknown[]> = NamedCondition<A> | ((...args: A) => unknown);

/**
 * A postcondition. The first parameter is the *resolved* result
 * (`UnwrapPromise<R>` — for `R = Promise<T>` the postcondition sees `T`, not
 * the promise), the second is the {@link ContractContext}.
 *
 * Named conditions of shape `NamedCondition<[UnwrapPromise<R>, ContractContext<A, R>]>`
 * are accepted too.
 */
export type PostPredicate<A extends unknown[], R> =
    | NamedCondition<[UnwrapPromise<R>, ContractContext<A, R>]>
    | ((result: UnwrapPromise<R>, context: ContractContext<A, R>) => unknown);

/**
 * An on-error condition. Receives the thrown/rejected error plus the
 * {@link ContractContext}. Return a falsy value to declare the error
 * illegitimate — that throws `OnErrorViolationError` (in `strict` mode) or
 * records a violation (in `warn`/`audit`).
 *
 * Named conditions of shape `NamedCondition<[unknown, ContractContext<A, R>]>`
 * are accepted too.
 */
export type ErrorPredicate<A extends unknown[], R> =
    | NamedCondition<[unknown, ContractContext<A, R>]>
    | ((error: unknown, context: ContractContext<A, R>) => unknown);

/**
 * Runtime context handed to postcondition and on-error predicates.
 *
 * `args` is a **live reference** to the argument array passed to the wrapper —
 * intentional. If a predicate (or `fn` itself) mutates the arguments, all
 * observers see the mutation. Spread it (`[...args]`) if you need a stable copy.
 *
 * `result` is only present in the postcondition context, `error` only in the
 * on-error context, `old` only in the postcondition context (and only when the
 * contract was created with both `old` and a non-empty `post`).
 */
export interface ContractContext<A extends unknown[], R> {
    /** Live reference to the argument tuple the wrapper was called with. */
    readonly args: A;
    /** The contract's name (`options.name`, else `fn.name`, else `'anonymous'`). */
    readonly contract: string;
    /** The wrapped function's name (or `'anonymous'`). */
    readonly function: string;
    /** The `this` value of the call site (`undefined` for standalone calls). */
    readonly self: unknown;
    /** The effective enforcement mode resolved for this call. */
    readonly mode: Mode;
    /** The resolved result. Present only in postcondition contexts. */
    readonly result?: UnwrapPromise<R>;
    /** The pre-call snapshot (see `options.old`). Present only in postcondition contexts. */
    readonly old?: OldValues;
    /** The error thrown by `fn`. Present only in on-error contexts. */
    readonly error?: unknown;
}

/**
 * Options for {@link contract}.
 *
 * Message precedence when a violation is reported:
 *
 * 1. the named condition's own `message` (`condition(pred, { message })`),
 * 2. `options.message` (this field),
 * 3. the default message composed by the error classes.
 *
 * @typeParam A - argument tuple of the wrapped function, inferred from `fn`.
 * @typeParam R - return type of the wrapped function.
 */
export interface ContractOptions<A extends unknown[], R> {
    /**
     * Preconditions, evaluated before `fn` runs (in declaration order).
     *
     * Predicates may return any value; truthiness is interpreted via
     * `Boolean(...)`. Return a real boolean when you can — truthy objects
     * (including promises, see below) always count as passing.
     *
     * Async predicates are supported **only inside contracts whose wrapped
     * function is async** (or otherwise returns a thenable): the wrapper
     * switches to a promise-returning path and awaits the predicates. In a
     * synchronous call path an async predicate throws a `TypeError` —
     * `contract()` cannot suspend synchronous execution, and silently
     * returning a promise would break every synchronous caller. Async
     * predicates nested inside composite conditions (`all()`/`any()`/`not()`)
     * are supported the same way — the composite's async settlement is
     * awaited as well.
     *
     * Named conditions are used as-is; bare predicates are normalized to named
     * conditions once at contract-creation time (never per call).
     */
    readonly pre?: readonly ConditionPredicate<A>[];
    /**
     * Postconditions, evaluated after `fn` resolves (in declaration order).
     *
     * The first predicate parameter is the *resolved* result; the second is
     * the {@link ContractContext}. Async postconditions are supported only
     * when `fn` returns a thenable (same rule as {@link pre}); a thenable
     * postcondition in a synchronous call path throws a `TypeError`.
     *
     * Postconditions are **not** evaluated when `fn` throws or its promise
     * rejects — see {@link onError}.
     */
    readonly post?: readonly PostPredicate<A, R>[];
    /**
     * On-error conditions, evaluated only when `fn` throws or rejects.
     *
     * Semantics:
     *
     * - they describe what must hold while the function is failing (e.g.
     *   "errors from this function must be `DatabaseError`s");
     * - a falsy return from any predicate means the failure itself broke its
     *   contract → `OnErrorViolationError` is reported (and thrown in `strict`);
     * - if every predicate passes (or none are configured), the original
     *   error propagates untouched — that is the expected failure mode;
     * - postconditions are never evaluated on the error path.
     *
     * Async predicates follow the same rule as {@link pre}.
     */
    readonly onError?: readonly ErrorPredicate<A, R>[];
    /**
     * Pre-call snapshot of selected arguments, exposed to postconditions as
     * `context.old`.
     *
     * The snapshot is taken only when **both** `old` and a non-empty `post`
     * are configured (and postconditions are not skipped by the effective
     * mode) — a snapshot nobody reads would be wasted deep-cloning.
     *
     * See `snapshotArgs` in `contracts/old.js` for the array/function forms
     * and their trade-offs.
     */
    readonly old?: OldSpec;
    /**
     * Name of this contract, used in violation messages and `ContractContext`.
     * Defaults to `fn.name`, or `'anonymous'` for unnamed functions.
     */
    readonly name?: string;
    /**
     * Per-contract enforcement mode override. Wins over `withConfig()` scopes
     * and the global `configure()` call — but not over per-category disabling
     * (`disabled` is a union across all layers).
     */
    readonly mode?: Mode;
    /**
     * Capture a stack trace on violation errors. Defaults to the resolved
     * runtime `captureStack` (itself defaulting to `true`).
     *
     * When effectively `false`, the violation error is constructed normally
     * and its `stack` is then redefined as `undefined` — the rest of the
     * error (message, structured fields, `cause`) is unaffected.
     */
    readonly captureStack?: boolean;
    /**
     * Fallback user message for violations of this contract. Loses to a named
     * condition's own `message`; wins over the composed default. Appended
     * after the composed prefix, e.g. `Precondition violated: fn (condition #0): <message>`.
     */
    readonly message?: string;
}

/** Number of wrapped-argument entries collected before dispatching on thenables. */
interface CollectedPre<A extends unknown[]> {
    readonly entry: NormalizedCondition<A>;
    readonly index: number;
    readonly raw: unknown;
}

interface NormalizedCondition<Args extends unknown[]> {
    readonly named: NamedCondition<Args>;
    /** true when the user passed a named condition — controls `conditionName` in details */
    readonly fromUserCondition: boolean;
}

type ViolationSection = 'precondition' | 'postcondition' | 'on-error';

const NO_ENTRIES: readonly [] = [];

// inline skip decision against an already-resolved config — same rule as
// canSkip(), but without re-resolving anything on the hot path
const skipCategory = (resolved: ResolvedConfig, category: ViolationCategory): boolean =>
    resolved.skipPredicates || resolved.disabled.has(category);

// tags async functions without needing AsyncFunction in the type system
const asyncFunctionCtor: unknown = Object.getPrototypeOf(async () => {
    // empty check fn, only its constructor matters
}).constructor;
const asyncGeneratorCtor: unknown = Object.getPrototypeOf(async function* () {
    yield undefined;
}).constructor;

/** Normalize one condition, evaluating the argument lazily at call time. */
const normalizeCondition = <Args extends unknown[]>(
    input: NamedCondition<Args> | ((...args: Args) => unknown),
): NormalizedCondition<Args> => {
    if (isNamedCondition<Args>(input)) {
        return { named: input, fromUserCondition: true };
    }
    // check() passes the raw value through — thenables stay detectable at the call site
    return {
        named: condition(input as unknown as (...args: Args) => boolean),
        fromUserCondition: false,
    };
};

const normalizeList = <Args extends unknown[]>(
    inputs: readonly (NamedCondition<Args> | ((...args: Args) => unknown))[] | undefined,
): readonly NormalizedCondition<Args>[] => {
    if (inputs === undefined || inputs.length === 0) return NO_ENTRIES;
    return inputs.map(normalizeCondition);
};

/** Best-effort stack stripping; used when captureStack resolves to false. */
const hideStack = (error: Error): void => {
    try {
        Object.defineProperty(error, 'stack', {
            value: undefined,
            writable: true,
            configurable: true,
        });
    } catch {
        // non-configurable stack — nothing else we can do, leave it
    }
};

const buildViolationError = (
    section: ViolationSection,
    userMessage: string | undefined,
    details: ContractViolationDetails,
): ContractViolationError => {
    switch (section) {
        case 'precondition':
            return new PreconditionViolationError(userMessage, details);
        case 'postcondition':
            return new PostconditionViolationError(userMessage, details);
        case 'on-error':
            return new OnErrorViolationError(userMessage, details);
    }
};

/**
 * Wrap `fn` so its arguments, result and failure mode are checked against a
 * contract at runtime.
 *
 * The wrapper preserves `fn.length` and `fn.name`, honours the call-site
 * `this` value, and leaves synchronous functions fully synchronous. When a
 * wrapped function returns a thenable, a single derived promise is returned
 * in its place; postconditions run after it resolves, on-error checks run
 * after it rejects, and postconditions are skipped entirely on the error path.
 *
 * `off`/`silent` modes never execute predicates — when every category is
 * skipped and no `old` snapshot is needed, the call degrades to a raw
 * `fn.apply(...)`.
 *
 * Message precedence on violation: named condition message → `options.message`
 * → composed default.
 *
 * Overloaded functions collapse to the implementation signature TS infers
 * (typically the last overload) — pass a non-overloaded reference for full
 * control.
 */
export function contract<A extends unknown[], R>(
    fn: (...args: A) => R,
    options?: ContractOptions<A, R>,
): (...args: A) => R {
    const o: ContractOptions<A, R> = options ?? {};
    const fnName = fn.name.length > 0 ? fn.name : 'anonymous';
    const contractName = o.name !== undefined && o.name.length > 0 ? o.name : fnName;

    const preEntries = normalizeList(o.pre);
    const postEntries = normalizeList<[UnwrapPromise<R>, ContractContext<A, R>]>(o.post);
    const onErrorEntries = normalizeList<[unknown, ContractContext<A, R>]>(o.onError);

    const oldSpec = o.old;
    // old only matters when postconditions exist and will actually run
    const oldPotentiallyNeeded = oldSpec !== undefined && postEntries.length > 0;

    // only used to pick sync vs promise-returning path when a predicate returns a thenable
    const probablyAsyncFn =
        (fn as { constructor?: unknown }).constructor === asyncFunctionCtor ||
        (fn as { constructor?: unknown }).constructor === asyncGeneratorCtor;

    // untyped view of fn for snapshotArgs' never[] parameter list
    const fnForSnapshot = fn as unknown as (...args: never[]) => unknown;
    const configuredMode = o.mode;

    const makePostContext = (
        args: A,
        self: unknown,
        mode: Mode,
        result: UnwrapPromise<R>,
        old: OldValues | undefined,
    ): ContractContext<A, R> => {
        const context: ContractContext<A, R> = {
            args,
            contract: contractName,
            function: fnName,
            self,
            mode,
            result,
            ...(old !== undefined ? { old } : {}),
        };
        return context;
    };

    const makeErrorContext = (
        args: A,
        self: unknown,
        mode: Mode,
        error: unknown,
    ): ContractContext<A, R> => ({
        args,
        contract: contractName,
        function: fnName,
        self,
        mode,
        error,
    });

    const reportSectionViolation = <Args extends unknown[]>(
        section: ViolationSection,
        entry: NormalizedCondition<Args>,
        index: number,
        mode: Mode,
        captureStack: boolean,
        startedAt: number,
    ): void => {
        const cond = entry.named;
        const details: ContractViolationDetails = {
            contractName,
            functionName: fnName,
            conditionIndex: index,
            // Mode and ContractMode are the same literal union — shared meaning
            mode: mode as ContractMode,
            ...(entry.fromUserCondition && cond.name.length > 0
                ? { conditionName: cond.name }
                : {}),
            // lastFailure is only meaningful right after check() returns false — fine here
            ...(cond.lastFailure !== undefined ? { cause: cond.lastFailure } : {}),
        };
        const error = buildViolationError(section, cond.message ?? o.message, details);
        if (!captureStack) hideStack(error);
        reportViolation(
            {
                kind: section,
                message: error.message,
                contractName,
                functionName: fnName,
                conditionIndex: index,
                // durationMs = wall time from wrapper entry to the point of violation
                durationMs: Math.max(0, Date.now() - startedAt),
            },
            error,
            configuredMode,
        );
    };

    const takeOldSnapshot = (args: A): OldValues | undefined =>
        oldSpec === undefined ? undefined : snapshotArgs(fnForSnapshot, args, oldSpec);

    const resolveCapture = (fallback: boolean): boolean => o.captureStack ?? fallback;

    // shared violation-free async tails — pre-checks already evaluated by callers
    const checkPostconditionAsync = async (
        result: UnwrapPromise<R>,
        args: A,
        self: unknown,
        mode: Mode,
        captureStack: boolean,
        old: OldValues | undefined,
        startedAt: number,
    ): Promise<void> => {
        const context = makePostContext(args, self, mode, result, old);
        for (const [index, entry] of postEntries.entries()) {
            // async-aware: composite children are awaited too, not just top-level preds
            const raw: unknown =
                entry.named.checkAsync !== undefined
                    ? await entry.named.checkAsync(result, context)
                    : await (entry.named.check(result, context) as unknown);
            if (!raw)
                reportSectionViolation(
                    'postcondition',
                    entry,
                    index,
                    mode,
                    captureStack,
                    startedAt,
                );
        }
    };

    const checkOnErrorAsync = async (
        error: unknown,
        args: A,
        self: unknown,
        mode: Mode,
        captureStack: boolean,
        startedAt: number,
    ): Promise<void> => {
        const context = makeErrorContext(args, self, mode, error);
        for (const [index, entry] of onErrorEntries.entries()) {
            const raw: unknown =
                entry.named.checkAsync !== undefined
                    ? await entry.named.checkAsync(error, context)
                    : await (entry.named.check(error, context) as unknown);
            if (!raw)
                reportSectionViolation('on-error', entry, index, mode, captureStack, startedAt);
        }
    };

    /**
     * Continuation for the "an async predicate appeared in `pre`" case.
     * Predicates were already invoked (callers saw the thenables); here we only
     * await them, in declaration order, then run the rest of the contract.
     *
     * `resolved`/`skipPost`/`skipOnError` are captured at wrapper entry —
     * see the "Config snapshot semantics" note on the module docs.
     */
    const continueAsync = async (
        self: unknown,
        args: A,
        preCollected: readonly CollectedPre<A>[],
        snapshotOld: boolean,
        startedAt: number,
        resolved: ResolvedConfig,
        skipPost: boolean,
        skipOnError: boolean,
    ): Promise<UnwrapPromise<R>> => {
        const mode = resolved.mode;
        const captureStack = resolveCapture(resolved.captureStack);

        for (const { entry, index, raw } of preCollected) {
            let value: unknown;
            if (isThenable(raw)) {
                value = await raw;
            } else if (entry.named.pendingVerdict !== undefined) {
                // a composite hid async work — its verdict was collected
                // during the sync check() pass, predicates ran exactly once
                value = await entry.named.pendingVerdict;
            } else {
                value = raw;
            }
            if (!value)
                reportSectionViolation('precondition', entry, index, mode, captureStack, startedAt);
        }

        const old = snapshotOld ? takeOldSnapshot(args) : undefined;
        let result: unknown;
        try {
            result = await fn.apply(self, args);
        } catch (error) {
            if (!skipOnError && onErrorEntries.length > 0) {
                await checkOnErrorAsync(error, args, self, mode, captureStack, startedAt);
            }
            throw error;
        }
        if (!skipPost) {
            await checkPostconditionAsync(
                result as UnwrapPromise<R>,
                args,
                self,
                mode,
                captureStack,
                old,
                startedAt,
            );
        }
        return result as UnwrapPromise<R>;
    };

    const wrapper = function wrapped(this: unknown, ...args: A): R {
        // compiled out entirely: no config resolution, no ALS, no Date.now()
        if (!isContractsCompiledIn()) {
            return fn.apply(this, args);
        }
        const resolved = getEffectiveConfig(configuredMode);
        const skipPre = skipCategory(resolved, 'precondition');
        const skipPost = skipCategory(resolved, 'postcondition');
        const skipOnError = skipCategory(resolved, 'on-error');
        // old is useless when postconditions cannot run
        const snapshotOld = oldPotentiallyNeeded && !skipPost;

        // every category disabled and no snapshot needed — stay as close to the raw call as possible
        if (skipPre && skipPost && skipOnError && !snapshotOld) {
            return fn.apply(this, args);
        }

        const startedAt = Date.now();
        const mode = resolved.mode;
        const captureStack = resolveCapture(resolved.captureStack);

        // PRE — invoke predicates exactly once, collect raw outcomes
        let preCollected: CollectedPre<A>[] | undefined;
        if (!skipPre) {
            preCollected = preEntries.map((entry, index) => ({
                entry,
                index,
                raw: entry.named.check(...args) as unknown,
            }));
            // thenables may hide at the top level or inside composites
            const needsAsync = preCollected.some(
                (item) => isThenable(item.raw) || item.entry.named.pendingVerdict !== undefined,
            );
            if (needsAsync) {
                if (!probablyAsyncFn) {
                    throw new TypeError(
                        `design-contracts: async predicate detected in a synchronous call path of "${fnName}"; ` +
                            'make the wrapped function async (or return a promise) to use async predicates',
                    );
                }
                // predicates were already invoked — continue with their pending results
                return continueAsync(
                    this,
                    args,
                    preCollected,
                    snapshotOld,
                    startedAt,
                    resolved,
                    skipPost,
                    skipOnError,
                ) as unknown as R;
            }
            for (const { entry, index, raw } of preCollected) {
                if (!raw)
                    reportSectionViolation(
                        'precondition',
                        entry,
                        index,
                        mode,
                        captureStack,
                        startedAt,
                    );
            }
        }

        const old = snapshotOld ? takeOldSnapshot(args) : undefined;

        let result: R;
        try {
            result = fn.apply(this, args);
        } catch (error) {
            if (!skipOnError) {
                const context = makeErrorContext(args, this, mode, error);
                for (const [index, entry] of onErrorEntries.entries()) {
                    const raw = entry.named.check(error, context) as unknown;
                    if (isThenable(raw) || entry.named.pendingVerdict !== undefined) {
                        throw new TypeError(
                            `design-contracts: async on-error predicate detected in a synchronous call path of "${fnName}"; ` +
                                'make the wrapped function async to use async predicates',
                        );
                    }
                    if (!raw)
                        reportSectionViolation(
                            'on-error',
                            entry,
                            index,
                            mode,
                            captureStack,
                            startedAt,
                        );
                }
            }
            throw error;
        }

        if (isThenable(result)) {
            // result is a thenable — post/on-error must wait for settlement
            if (skipPost && skipOnError) {
                return result; // nothing left to check — hand the original promise back
            }
            const promise = Promise.resolve(result as unknown as PromiseLike<unknown>);
            const derived = promise.then(
                (unwrapped) => {
                    if (skipPost) return unwrapped;
                    const typed = unwrapped as UnwrapPromise<R>;
                    // async predicates are fine here — we are already off the sync path
                    return checkPostconditionAsync(
                        typed,
                        args,
                        this,
                        mode,
                        captureStack,
                        old,
                        startedAt,
                    ).then(() => unwrapped);
                },
                async (error: unknown) => {
                    if (!skipOnError) {
                        await checkOnErrorAsync(error, args, this, mode, captureStack, startedAt);
                    }
                    // an on-error violation throws from reportViolation; otherwise the original error flies
                    throw error;
                },
            );
            return derived as unknown as R;
        }

        // plain synchronous result — postconditions run synchronously
        if (!skipPost) {
            const typed = result as UnwrapPromise<R>;
            const context = makePostContext(args, this, mode, typed, old);
            for (const [index, entry] of postEntries.entries()) {
                const raw = entry.named.check(typed, context) as unknown;
                if (isThenable(raw) || entry.named.pendingVerdict !== undefined) {
                    throw new TypeError(
                        `design-contracts: async postcondition predicate detected in a synchronous call path of "${fnName}"; ` +
                            'make the wrapped function async to use async predicates',
                    );
                }
                if (!raw)
                    reportSectionViolation(
                        'postcondition',
                        entry,
                        index,
                        mode,
                        captureStack,
                        startedAt,
                    );
            }
        }
        return result;
    };

    // keep contract-wrapped functions indistinguishable from the originals
    Object.defineProperty(wrapper, 'length', { value: fn.length, configurable: true });
    Object.defineProperty(wrapper, 'name', { value: fnName, configurable: true });

    // inheritance.ts reads this off the wrapper — same realm-global key, no runtime import cycle
    const CONTRACT_METADATA = Symbol.for('design-contracts/contract');
    const metadata: ContractMetadata<A, R> = { fn, name: contractName, options: o };
    Object.defineProperty(wrapper, CONTRACT_METADATA, {
        value: metadata,
        enumerable: false,
        configurable: true,
        writable: false,
    });

    return wrapper as (...args: A) => R;
}
