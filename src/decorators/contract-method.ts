/**
 * Stage 3 (TC39 standard) decorator for function contracts.
 *
 * `@contractMethod(options)` attaches the same {@link ContractOptions} that
 * `contract()` accepts to a class method, getter, setter, or arrow-function
 * field. When a same-name member with contract metadata exists on a base
 * class, the contracts are merged with the Liskov rules — the base
 * precondition holds OR the derived one does, postconditions are unioned —
 * which is what makes contract-decorated overrides behave like substitutable
 * members instead of merely wrapped ones.
 *
 * Stage 3 decorators receive only `value` and `context` — never the class
 * being defined — so the base-class merge cannot happen at decoration time.
 * It happens lazily instead:
 *
 * - methods/accessors: the merged contract is computed on the first call, or
 *   earlier via `addInitializer` (class definition for static members, first
 *   construction for instance members).
 * - fields: computed inside the initializer, which runs with `this` bound to
 *   the instance (or the constructor for static fields) — per instance, like
 *   the field itself.
 *
 * The prototype chain is discovered through the `this` value the call site
 * provides, which is exactly the hierarchy the caller sees. Ancestors are
 * defined (and their member decorators applied) before descendants, so by
 * the time any derived member is first reached, the base's metadata is in
 * place. After the first construction a member reports its fully merged
 * metadata via `getContractMetadata()`; before any construction it reports
 * its own options only (provisional).
 *
 * Private members are never merged — their names are not comparable across
 * the chain — and always get their own contract only, applied eagerly.
 * Accessors merge against same-name accessors on the base, methods against
 * members with a data descriptor, fields against function-valued members — a
 * getter never merges with a setter or a method.
 *
 * Calling an extracted member on an unrelated receiver (`const fn = obj.m;
 * fn.call(other)`) loses the base merge — the home level cannot be located —
 * and the member falls back to its own contract only. `super` calls are not
 * a problem: levels above the member's own level are always skipped, so a
 * base wrapper reached via `super` never absorbs the derived contract.
 */

import type { ContractOptions } from '../core/contract.js';
import { contract } from '../core/contract.js';
import type { ContractMetadata } from '../core/inheritance.js';
import {
    CONTRACT_METADATA,
    getContractMetadata,
    mergeContractOptions,
} from '../core/inheritance.js';

/** Options accepted by {@link contractMethod} — identical to `contract()`'s. */
export type ContractMethodOptions<A extends unknown[] = AnyArgs, R = unknown> = ContractOptions<
    A,
    R
>;

// biome-ignore lint/suspicious/noExplicitAny: predicate params need implicit any so `pre: [e => e.id.length > 0]` compiles unannotated
type AnyArgs = any[];
// biome-ignore lint/suspicious/noExplicitAny: erased boundary type — the decorator must accept any function value, casts are adapted per call site
type AnyFunction = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: homogeneous options shape for internal merging
type AnyContractOptions = ContractOptions<any[], any>;
// biome-ignore lint/suspicious/noExplicitAny: metadata at the erased boundary
type AnyMetadata = ContractMetadata<any[], any>;
type DecoratorKind = 'method' | 'getter' | 'setter' | 'field';

const OBJECT_PROTO = Object.prototype as object | null;
const FUNCTION_PROTO = Function.prototype as object;

const isObjectish = (value: unknown): value is object =>
    (typeof value === 'object' && value !== null) || typeof value === 'function';

/** anchor for member calls: the constructor for statics, the instance prototype otherwise */
const contextAnchor = (self: unknown, isStatic: boolean): object | undefined => {
    if (isStatic) return isObjectish(self) ? self : undefined;
    if (self !== null && typeof self === 'object') {
        return (Object.getPrototypeOf(self) as object | null) ?? undefined;
    }
    return undefined;
};

const stripPre = (options: AnyContractOptions): AnyContractOptions => {
    const { pre: _pre, ...rest } = options;
    return rest;
};

/** own options, with `pre` dropped for getters (a zero-arg member has nothing to check) */
const ownOptionsFor = (kind: DecoratorKind, options: AnyContractOptions): AnyContractOptions =>
    kind === 'getter' ? stripPre(options) : options;

/**
 * nearest same-name contracted member on the chain at/above `anchor`.
 *
 * Levels strictly above our home level (subclass overrides) must be ignored,
 * or a base wrapper called via `super` from a derived instance would absorb
 * the derived contract. Home is located by matching `self` on a data/accessor
 * descriptor; everything before it is skipped. Fields are stored on instances
 * (or defined later on the constructor), so their home level is invisible at
 * init time — they treat the whole walk as candidates instead.
 */
const findBaseMetadata = (
    anchor: object,
    key: PropertyKey,
    kind: DecoratorKind,
    self: unknown,
): ContractMetadata | undefined => {
    let current: object | null = anchor;
    let selfSeen = kind === 'field'; // fields have no visible home entry — accept all candidates
    while (current !== null && current !== OBJECT_PROTO && current !== FUNCTION_PROTO) {
        let descriptor: PropertyDescriptor | undefined;
        try {
            descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        } catch {
            return undefined; // hostile proxy — no merge is better than a thrown class definition
        }
        if (descriptor !== undefined) {
            let candidate: unknown;
            if (kind === 'getter') candidate = descriptor.get;
            else if (kind === 'setter') candidate = descriptor.set;
            else candidate = descriptor.value; // method and field both look at the data descriptor
            if (typeof candidate === 'function') {
                if (candidate === self) selfSeen = true;
                else if (selfSeen) {
                    const metadata = getContractMetadata(candidate);
                    if (metadata !== undefined) return metadata;
                    // same-named member without a contract in between — keep walking, like mergeClassContracts
                }
            }
        }
        current = Object.getPrototypeOf(current) as object | null;
    }
    return undefined;
};

const contractNameOf = (fn: AnyFunction, options: AnyContractOptions): string => {
    const name = options.name ?? fn.name;
    return name.length > 0 ? name : 'anonymous';
};

const makeMeta = (fn: AnyFunction, options: AnyContractOptions): AnyMetadata => ({
    fn,
    name: contractNameOf(fn, options),
    options,
});

/** merged options against a `this`-anchored chain; own options when no anchor/merge possible */
const resolveMerged = (
    anchor: object | undefined,
    key: PropertyKey,
    kind: DecoratorKind,
    self: unknown,
    ownOptions: AnyContractOptions,
): AnyContractOptions => {
    if (anchor === undefined) return ownOptions;
    const baseMeta = findBaseMetadata(anchor, key, kind, self);
    if (baseMeta === undefined) return ownOptions;
    return mergeContractOptions(baseMeta.options, ownOptions) ?? ownOptions;
};

export interface ContractMethodDecorator {
    // method — the wrapper type comes from the method itself, never from the options
    <This, Args extends unknown[], Return>(
        value: (this: This, ...args: Args) => Return,
        context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Return>,
    ): (this: This, ...args: Args) => Return;
    // getter — zero args, `post` rides the contract, `pre` is stripped
    <This, Return>(
        value: (this: This) => Return,
        context: ClassGetterDecoratorContext<This, Return>,
    ): (this: This) => Return;
    // setter — `pre` predicates receive (value) through contract's normal arg spread
    <This, Arg>(
        value: (this: This, value: Arg) => void,
        context: ClassSetterDecoratorContext<This, Arg>,
    ): (this: This, value: Arg) => void;
    // field whose initializer produces a function (arrow-function fields, mostly)
    <This, Value extends AnyFunction>(
        value: undefined,
        context: ClassFieldDecoratorContext<This, Value>,
    ): (this: This, initialValue: Value) => Value;
}

/**
 * Attach a contract to a class member. Instance and `static` methods are both
 * supported, as are getters and setters — and fields whose initializer
 * produces a function, typically an arrow-function field. See the module
 * header for how the base-class merge works.
 *
 * Notes:
 * - a getter must not declare `pre` — it takes no arguments, so the decorator
 *   throws a `TypeError` at class definition time instead of silently running
 *   vacuous predicates. Use `post` to check the returned value.
 * - a setter's `pre` predicates receive the assigned value.
 * - a field whose initializer does not produce a function throws a
 *   `TypeError`; wrap the value in `contract()` by hand or use a method.
 * - private members never merge with base contracts.
 */
export function contractMethod<A extends unknown[] = AnyArgs, R = unknown>(
    options?: ContractMethodOptions<A, R>,
): ContractMethodDecorator {
    const opts = (options ?? {}) as AnyContractOptions;

    const decorate = (
        value: AnyFunction | undefined,
        context:
            | ClassMethodDecoratorContext
            | ClassGetterDecoratorContext
            | ClassSetterDecoratorContext
            | ClassFieldDecoratorContext,
    ): unknown => {
        const key = context.name;
        const kind = context.kind;

        if (kind === 'field') {
            if (value !== undefined) {
                throw new TypeError('contractMethod: field decorators never receive a value');
            }
            return decorateField(key, opts, context.static);
        }

        if (value === undefined) {
            throw new TypeError(`contractMethod: decorator received no value for kind "${kind}"`);
        }
        if (kind === 'getter' && opts.pre !== undefined) {
            throw new TypeError(
                'contractMethod: preconditions make no sense on a getter — it takes no arguments. ' +
                    'Use `post` to check the returned value instead.',
            );
        }
        if (context.private === true) {
            // private names are not comparable across the chain — own contract only, eagerly
            return contract(value, ownOptionsFor(kind, opts)) as AnyFunction;
        }

        const ownOptions = ownOptionsFor(kind, opts);
        let ensured: { inner: AnyFunction; meta: AnyMetadata } | undefined;
        let transientMeta: AnyMetadata | undefined;

        const ensure = (anchor: object | undefined) => {
            if (ensured !== undefined) return ensured;
            const merged = resolveMerged(anchor, key, kind, wrapper, ownOptions);
            const inner = contract(value, merged) as AnyFunction;
            const e = { inner, meta: makeMeta(value, merged) };
            if (anchor !== undefined) ensured = e; // deterministic chain — cache it
            return e;
        };

        const wrapper = function contractMethodWrapper(this: unknown, ...args: unknown[]): unknown {
            return ensure(contextAnchor(this, context.static)).inner.apply(this, args);
        } as AnyFunction;

        Object.defineProperty(wrapper, 'length', { value: value.length, configurable: true });
        Object.defineProperty(wrapper, 'name', {
            value: value.name.length > 0 ? value.name : 'anonymous',
            configurable: true,
        });
        Object.defineProperty(wrapper, CONTRACT_METADATA, {
            get() {
                if (ensured !== undefined) return ensured.meta;
                transientMeta ??= ensure(undefined).meta;
                return transientMeta;
            },
            enumerable: false,
            configurable: true,
        });

        context.addInitializer(function (this: unknown) {
            // statics: runs at class definition time, this = constructor
            // instance members: runs at construction time, this = instance
            const anchor = contextAnchor(this, context.static);
            if (anchor !== undefined) ensure(anchor);
        });

        return wrapper;
    };

    return decorate as unknown as ContractMethodDecorator;
}

const decorateField = (key: PropertyKey, options: AnyContractOptions, isStatic: boolean) => {
    let resolvedOptions: AnyContractOptions | undefined;

    const resolveOpts = (anchor: object | undefined, self: unknown) => {
        if (resolvedOptions !== undefined) return resolvedOptions;
        const merged = resolveMerged(anchor, key, 'field', self, options);
        if (anchor !== undefined) resolvedOptions = merged;
        return merged;
    };

    return function contractMethodFieldInitializer(this: unknown, initialValue: unknown): unknown {
        if (typeof initialValue !== 'function') {
            throw new TypeError(
                `contractMethod: @${String(key)} is not callable — contractMethod on a field ` +
                    'expects the initializer to produce a function (for example, an arrow-function ' +
                    'field). Wrap the value in contract() by hand, or use @contractMethod on a method instead.',
            );
        }
        const opts = resolveOpts(contextAnchor(this, isStatic), initialValue);
        // fresh wrapper per instance, like the field itself; contract() attaches the metadata
        return contract(initialValue as AnyFunction, opts) as AnyFunction;
    };
};
