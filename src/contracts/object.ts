/**
 * Mutable-state object contracts.
 *
 * `contractObject()` wraps an object whose state can change and enforces
 * invariants on that state. It returns a NEW wrapper object (a `Proxy` of the
 * target) that has the same own properties and methods as the target.
 *
 * ## When invariants are checked
 *
 * 1. **After creation** — {@link contractObject} evaluates the invariants once
 *    against the initial state before returning the wrapper. A violation in
 *    `strict` mode makes {@link contractObject} throw.
 * 2. **After every wrapped method call** — once, after the method has finished.
 *    For synchronous methods that is right after the method body runs; for
 *    methods that throw, the invariants are still checked (the state may have
 *    been mutated before the throw) and the method's own error is preserved as
 *    the `cause` of a violation error. For methods that return a thenable the
 *    check runs after the promise settles — on fulfill *and* on reject — and a
 *    strict-mode violation rejects the returned promise with the violation
 *    error instead of the (non-existent) return value. This covers the async
 *    half of "after every method", which a purely synchronous check cannot see.
 * 3. **After direct property writes** — the `set` trap writes the value and
 *    then checks the invariants. A write that happens *inside* a wrapped method
 *    is NOT checked at the assignment site; it is checked exactly once when the
 *    method settles (and for async methods, inside the continuations the
 *    check is deferred the same way). This keeps one check per boundary
 *    instead of one check per assignment.
 *
 * Invariants are deliberately NOT re-checked on every `get`: reading must stay
 * cheap and side-effect free, and reads cannot invalidate state.
 *
 * We do not try to detect whether a method actually mutated state. Every
 * public method is treated as a potential mutator and checked unconditionally.
 * This is the only honest default — detecting mutation reliably would mean
 * deep-diffing on every call, which is neither cheap nor complete.
 *
 * ## Method binding
 *
 * Functions reached through the wrapper are returned bound to the wrapper
 * (cached, so `wrapper.m === wrapper.m` holds). `this` inside methods is the
 * wrapper itself, so `this.balance` reads go through the `get` trap and
 * `this.balance = x` writes go through the `set` trap — the same invariants
 * apply to self-mutation as to outside writes. Extracted methods keep the
 * binding: `const m = wrapper.deposit; m(1)` still sees the wrapper as `this`.
 *
 * ## Invariant contract
 *
 * Invariants receive the wrapper as `self` and must **only read** — an
 * invariant that writes is not re-checked (see re-entrancy below) and can
 * mask the very inconsistency it is meant to catch. Keep invariants pure.
 *
 * ## Re-entrancy
 *
 * While the invariant list is being evaluated a guard flag is set on the
 * wrapper. Writes that happen *inside* an invariant (which are unsupported,
 * but cannot be stopped) go through the `set` trap without triggering a nested
 * invariant pass, so an invariant can never recurse into itself infinitely.
 * The outer check then reports whatever it sees. The flag is reset in a
 * `finally`, so a throwing predicate does not poison later checks.
 *
 * Predicate exceptions are NOT wrapped: a predicate that throws propagates
 * its own error unchanged, mirroring the semantics of named conditions.
 *
 * ## Enforcement modes
 *
 * Invariant evaluation honours `canSkip('invariant', mode)`: under `off` or
 * `silent` the predicates are not executed at all, under `warn` the violation
 * is reported to `onViolation` (or logged) and execution continues, under
 * `audit` an audit record of kind `'invariant'` is emitted, under `strict`
 * an {@link InvariantViolationError} is thrown. `options.mode` overrides the
 * effective mode for this object only, exactly like the per-contract mode
 * override elsewhere in the library.
 *
 * ## Types
 *
 * `contractObject<T extends object>(target: T, options?: ContractObjectOptions<T>): T`
 * returns the wrapper typed as `T`. At runtime the value is a `Proxy`, not the
 * original object, but its shape is identical (own properties, prototype,
 * `instanceof`) so TypeScript's view stays accurate for everything except
 * object identity (`wrapper !== target`).
 *
 * ## Limits (deliberate)
 *
 * - **Nested objects are not wrapped.** If `self.items.push(x)` mutates an
 *   inner array, the invariants of the outer object do NOT run. Wrap nested
 *   objects yourself with nested `contractObject()` calls if you need that.
 *   Auto-wrapping was rejected: it is surprising, allocates proxies nobody
 *   asked for, and breaks identity expectations.
 * - **Class instances are not the target audience.** Methods bound to the
 *   proxy cannot access `#private` fields (the proxy is not the instance),
 *   so invariants + private fields do not mix. Plain objects are fully
 *   supported; class instances work as long as they avoid `#private` state.
 * - Accessor properties (`get`/`set` on the plain object) run with `this`
 *   bound to the wrapper; their writes go through the `set` trap like any
 *   other, so invariants still apply.
 * - `captureStack: false` suppresses the stack trace on violation errors
 *   produced by this module (a small win on hot, known-failing paths).
 *
 * ## Error fields
 *
 * A violation produced here fills `kind: 'invariant'`, `contractName`
 * (`options.name`, else the constructor name, else `'object'`),
 * `functionName` (the invoked method's property key, `'<set>'` for a direct
 * write, `'<init>'` for the post-creation check), `conditionIndex` (index of
 * the invariant in `options.invariant`) and `conditionName` (the named
 * condition's name, the predicate's own name, or `'anonymous'`).
 */

import { isNamedCondition, type NamedCondition } from '../core/index.js';
import type { ContractViolationDetails } from '../errors/index.js';
import { InvariantViolationError } from '../errors/index.js';
import type { Mode } from '../runtime/index.js';
import { canSkip, getEffectiveConfig, isMode, reportViolation } from '../runtime/index.js';

/**
 * One invariant of a contracted object.
 *
 * A named condition (`NamedCondition<[Self]>`) is evaluated via `.check(self)`
 * and may carry a failure `message` that ends up in the violation error.
 * A bare predicate is treated as a boolean-ish test of `self` — any truthy
 * value passes.
 */
export type ObjectInvariant<Self extends object = object> =
    | NamedCondition<[Self]>
    | ((self: Self) => unknown);

/**
 * Options for {@link contractObject}.
 *
 * - `invariant` — invariants checked at the boundaries described in the module
 *   docs. Omit (or pass an empty array) to get a pass-through wrapper that
 *   still binds methods to itself; the checks cost one guard-flag read then.
 * - `name` — contract name used in violation reports. Defaults to the target's
 *   constructor name, or `'object'` for plain objects.
 * - `mode` — per-object enforcement-mode override. Wins over scoped
 *   `withConfig()` and the global configuration for this object only.
 * - `captureStack` — capture a stack trace when a violation error is created.
 *   Defaults to the effective runtime configuration (`true` by default).
 */
export interface ContractObjectOptions<Self extends object = object> {
    readonly invariant?: readonly ObjectInvariant<Self>[];
    readonly name?: string;
    readonly mode?: Mode;
    readonly captureStack?: boolean;
}

type AnyFunction = (...args: never[]) => unknown;

const initCheckName = '<init>';
const setCheckName = '<set>';

function isThenable(value: unknown): value is PromiseLike<unknown> {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return false;
    }
    try {
        // hostile thenables may throw on the .then probe — if they do, treat
        // the value as a plain object and let the caller deal with it
        return typeof (value as { then?: unknown }).then === 'function';
    } catch {
        return false;
    }
}

function propToString(prop: PropertyKey): string {
    return typeof prop === 'symbol' ? prop.toString() : String(prop);
}

function predicateName(predicate: (...args: never[]) => unknown): string {
    const name = predicate.name.trim();
    return name.length > 0 ? name : 'anonymous';
}

function invariantName<Self extends object>(entry: ObjectInvariant<Self>): string {
    if (isNamedCondition(entry)) {
        return entry.name;
    }
    return predicateName(entry as AnyFunction);
}

function defaultContractName(target: object, name: string | undefined): string {
    if (name !== undefined) {
        return name;
    }
    const ctor = (target as { constructor?: unknown }).constructor;
    const ctorName =
        ctor !== null && typeof ctor === 'function' ? (ctor as { name?: unknown }).name : undefined;
    // plain old objects all have "Object" as constructor — not a useful label
    if (typeof ctorName === 'string' && ctorName.length > 0 && ctorName !== 'Object') {
        return ctorName;
    }
    return 'object';
}

function suppressStack(error: Error): void {
    try {
        // v8/jsc: writable own prop; spidermonkey: accessor with a setter — both fine
        (error as { stack?: unknown }).stack = undefined;
    } catch {
        // stack could not be suppressed — whatever, the rest of the error is intact
    }
}

/**
 * Wrap an object so its invariants are enforced at every state boundary.
 *
 * See the module docs for the full semantics: when the checks run, how methods
 * are bound, what `self` means inside an invariant, and what is intentionally
 * not supported.
 *
 * ```ts
 * const account = contractObject(
 *     {
 *         balance: 100,
 *         deposit(amount: number) {
 *             this.balance += amount;
 *         },
 *     },
 *     { invariant: [(self) => self.balance >= 0], name: 'account' },
 * );
 * account.deposit(50); // invariants checked after the call
 * account.balance = -1; // throws InvariantViolationError (strict mode)
 * ```
 *
 * @param target - the object to wrap. The returned wrapper proxies it; the
 *   target itself is mutated in place and should not be used directly
 *   afterwards (writes through it bypass the invariants).
 * @param options - invariants and per-object overrides, see
 *   {@link ContractObjectOptions}.
 * @returns the wrapper, typed as `T`. Runtime-wise it is a `Proxy`.
 * @throws {TypeError} when `target` is not an object, `options.mode` is not a
 *   valid mode, or an invariant entry is neither a named condition nor a
 *   function.
 * @throws {InvariantViolationError} in `strict` mode when an invariant does not
 *   hold after creation, after a method call, or after a direct property
 *   write.
 */
export function contractObject<T extends object>(
    target: T,
    options: ContractObjectOptions<T> = {},
): T {
    if (typeof target !== 'object' || target === null) {
        throw new TypeError('contractObject: target must be an object.');
    }
    if (options === null || typeof options !== 'object') {
        throw new TypeError('contractObject: options must be an object when provided.');
    }
    const mode = options.mode;
    if (mode !== undefined && !isMode(mode)) {
        throw new TypeError(
            `contractObject: invalid mode ${JSON.stringify(mode)}. Valid values: strict, warn, silent, audit, off.`,
        );
    }
    const invariants = options.invariant;
    if (invariants !== undefined) {
        if (!Array.isArray(invariants)) {
            throw new TypeError('contractObject: options.invariant must be an array.');
        }
        for (const entry of invariants) {
            if (!isNamedCondition(entry) && typeof entry !== 'function') {
                throw new TypeError(
                    'contractObject: every invariant must be a named condition or a function.',
                );
            }
        }
    }

    const contractName = defaultContractName(target, options.name);
    // resolved once per call site through the runtime caches — cheap
    const captureStack = options.captureStack ?? getEffectiveConfig(mode).captureStack;
    // re-entrancy guard: set while an invariant pass is running
    let checking = false;
    // how many wrapped-method frames are currently on the stack (or in flight for
    // async methods). Writes inside a method defer to the post-settle check instead
    // of each triggering one — otherwise a 3-assignment method reports 3 times.
    let methodDepth = 0;
    // per-wrapper cache: original fn -> property key -> bound fn. Keyed by key
    // too so aliased functions still report the right method name.
    const boundMethods = new WeakMap<AnyFunction, Map<PropertyKey, AnyFunction>>();

    // assigned right after the trap closures below — they can't fire before that
    let wrapper: T;

    const checkInvariants = (functionName: string, cause?: unknown): void => {
        if (invariants === undefined || invariants.length === 0) {
            return;
        }
        if (checking) {
            // re-entered from inside an invariant (e.g. it wrote to the wrapper) —
            // never recurse, the outer pass reports what it sees
            return;
        }
        if (canSkip('invariant', mode)) {
            return;
        }
        checking = true;
        try {
            for (let index = 0; index < invariants.length; index += 1) {
                const entry = invariants[index];
                if (entry === undefined) {
                    continue; // hole in a sparse array — nonsense input, skip it
                }
                let passed = false;
                if (isNamedCondition(entry)) {
                    passed = entry.check(wrapper);
                } else {
                    // bare predicate, any truthy value passes
                    passed = Boolean((entry as (self: T) => unknown)(wrapper));
                }
                if (passed) {
                    continue;
                }
                const conditionName = invariantName(entry);
                const userMessage = isNamedCondition(entry) ? entry.message : undefined;
                const details: ContractViolationDetails = {
                    contractName,
                    functionName,
                    conditionIndex: index,
                    conditionName,
                    ...(cause !== undefined ? { cause } : {}),
                };
                const error = new InvariantViolationError(userMessage, details);
                if (!captureStack) {
                    suppressStack(error);
                }
                reportViolation(
                    {
                        kind: 'invariant',
                        message: error.message,
                        contractName,
                        functionName,
                        conditionIndex: index,
                    },
                    error,
                    mode,
                );
                // strict throws out of reportViolation — the finally below still runs
            }
        } finally {
            checking = false;
        }
    };

    const makeBound = (fn: AnyFunction, prop: PropertyKey): AnyFunction => {
        const functionName = propToString(prop);
        // the reported name is the property key we were accessed under, not fn.name —
        // "account.deposit" is what the user actually called
        const bound = function (this: unknown, ...args: never[]): unknown {
            methodDepth += 1;
            let result: unknown;
            try {
                result = fn.apply(wrapper, args);
            } catch (methodError) {
                methodDepth -= 1;
                // a method that threw still gets its invariants checked — the state
                // may be half-mutated, which is exactly when they matter
                checkInvariants(functionName, methodError);
                throw methodError;
            }
            if (isThenable(result)) {
                // the state after an async method only exists once the promise settles —
                // check there instead of at return time. Both paths check: a rejected
                // method may have mutated before rejecting. methodDepth stays > 0 until
                // settle, so intermediate writes inside continuations don't double-report.
                const onFulfilled = (value: unknown): unknown => {
                    methodDepth -= 1;
                    checkInvariants(functionName);
                    return value;
                };
                const onRejected = (methodError: unknown): unknown => {
                    methodDepth -= 1;
                    checkInvariants(functionName, methodError);
                    throw methodError;
                };
                try {
                    return result.then(onFulfilled, onRejected);
                } catch (thenError) {
                    // a hostile thenable threw synchronously on .then — balance the counter
                    methodDepth -= 1;
                    throw thenError;
                }
            }
            methodDepth -= 1;
            checkInvariants(functionName);
            return result;
        };
        return bound as AnyFunction;
    };

    const handler: ProxyHandler<T> = {
        get(targetRef: T, prop: string | symbol, receiver: unknown): unknown {
            const value: unknown = Reflect.get(targetRef, prop, receiver as T);
            if (typeof value !== 'function') {
                return value;
            }
            const fn = value as AnyFunction;
            let byProp = boundMethods.get(fn);
            if (byProp === undefined) {
                byProp = new Map();
                boundMethods.set(fn, byProp);
            }
            const cached = byProp.get(prop);
            if (cached !== undefined) {
                return cached;
            }
            const bound = makeBound(fn, prop);
            byProp.set(prop, bound);
            return bound;
        },
        set(targetRef: T, prop: string | symbol, value: unknown, receiver: unknown): boolean {
            const ok = Reflect.set(targetRef, prop, value, receiver);
            if (!ok) {
                // non-writable non-configurable own prop — let the assignment fail loudly
                return false;
            }
            // inside a wrapped method the write is checked once, when the method settles
            if (methodDepth === 0) {
                checkInvariants(setCheckName);
            }
            return true;
        },
    };

    wrapper = new Proxy(target, handler);

    // boundary (a): the initial state must satisfy the invariants too
    checkInvariants(initCheckName);

    return wrapper;
}
