/**
 * Liskov-style inheritance for contracts.
 *
 * Eiffel rules apply: preconditions are combined with a **disjunction**
 * (the derived method may accept anything the base accepts, plus anything it
 * declares itself), postconditions/on-error predicates/invariants are combined
 * with a **conjunction** (the derived method must deliver at least what the
 * base promises), and the remaining options fall back to the derived side.
 *
 * Merging never mutates (or reuses) the wrappers produced by `contract()` —
 * a fresh wrapper is created from the recorded source function and the merged
 * source options, or the original wrapper is kept as-is when merging would be
 * a pure identity.
 */

import type { ConditionInput, NamedCondition } from './condition.js';
import { all, any } from './condition.js';
import type { ConditionPredicate, ContractOptions } from './contract.js';
import { contract } from './contract.js';

/**
 * Realm-global symbol key under which `contract()` stores the metadata of the
 * wrapper it creates. `Symbol.for` keeps the key shared across dual ESM/CJS
 * installs — decorators/subclasses can read it regardless of how the library
 * was loaded. `contract.ts` uses the same key inline (no runtime import cycle).
 */
export const CONTRACT_METADATA: unique symbol = Symbol.for('design-contracts/contract');

/**
 * Metadata attached to every wrapper produced by `contract()`.
 *
 * `options` is the source object the wrapper was created from (the same
 * reference the caller passed, or a fresh empty object when omitted) — never
 * a normalized copy. Normalized `{ named, fromUserCondition }` entries are
 * intentionally not stored: merging re-wraps from source options, which
 * re-normalizes deterministically.
 *
 * `fn` is whatever was passed to `contract()` — possibly already a wrapped
 * function if the caller double-wraps.
 */
export interface ContractMetadata<A extends unknown[] = unknown[], R = unknown> {
    /** The source function given to `contract()`. */
    readonly fn: (...args: A) => R;
    /** The effective contract name (`options.name`, else `fn.name`, else `'anonymous'`). */
    readonly name: string;
    /** The source options object, exactly as passed ({} when omitted). */
    readonly options: ContractOptions<A, R>;
}

/**
 * Attach contract metadata to `fn` without wrapping it. Mostly useful for
 * tests and for interop with foreign wrappers that want to participate in
 * `mergeClassContracts`. The property is non-enumerable and `writable: false`;
 * re-attaching overwrites previous metadata (the property is `configurable: true`).
 *
 * Returns `fn` for chaining.
 */
export function attachContractMetadata<F extends (...args: never[]) => unknown>(
    fn: F,
    metadata: ContractMetadata,
): F {
    Object.defineProperty(fn, CONTRACT_METADATA, {
        value: metadata,
        enumerable: false,
        configurable: true,
        writable: false,
    });
    return fn;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
    typeof value === 'object' && value !== null;

/**
 * Read the metadata `contract()` attached to a wrapper. Returns `undefined`
 * for plain functions, non-object values, or symbol payloads that do not
 * look like {@link ContractMetadata} (defensive — the symbol is realm-global,
 * so a foreign library could forge it).
 */
export function getContractMetadata(fn: unknown): ContractMetadata | undefined {
    if (typeof fn !== 'object' && typeof fn !== 'function') return undefined;
    if (fn === null) return undefined;
    const value = (fn as Record<PropertyKey, unknown>)[CONTRACT_METADATA];
    if (!isRecord(value)) return undefined;
    const candidate = value as { options?: unknown; name?: unknown; fn?: unknown };
    if (!isRecord(candidate.options)) return undefined;
    if (typeof candidate.name !== 'string') return undefined;
    if (typeof candidate.fn !== 'function') return undefined;
    return candidate as unknown as ContractMetadata;
}

/** True when `fn` carries contract metadata readable via {@link getContractMetadata}. */
export function hasContractMetadata(fn: unknown): boolean {
    return getContractMetadata(fn) !== undefined;
}

/**
 * Sparse-safe flatten: drops holes and explicit `undefined` entries.
 * `ReadonlyArray` indexing with noUncheckedIndexedAccess needs the guard anyway.
 */
const compacted = <T>(list: readonly T[] | undefined): T[] => {
    if (list === undefined) return [];
    const out: T[] = [];
    for (const item of list) {
        if (item !== undefined) out.push(item);
    }
    return out;
};

/**
 * Bare predicates type as `(...args) => unknown` in `ContractOptions`, while
 * condition composites want `(...args) => boolean`. Runtime-wise the
 * evaluator only cares about truthiness, so this cast is safe.
 */
const asConditionInputs = <A extends unknown[]>(
    list: readonly ConditionPredicate<A>[],
): readonly ConditionInput<A>[] => list as unknown as readonly ConditionInput<A>[];

/**
 * Merge base and derived contract options per the Liskov substitution rules.
 *
 * Semantics (all of it, precisely):
 *
 * - **pre** — Eiffel disjunction, section-wise:
 *   `any(all(...base.pre), all(...derived.pre))` when both sides declare a
 *   non-empty list; the effective precondition passes when **every base
 *   precondition holds OR every derived precondition holds**. This can only
 *   weaken `base.pre`, never strengthen it. An `all()` of one side alone
 *   is skipped — a single-sided list is forwarded as-is (same array
 *   reference). When `base.pre` is empty/undefined and `derived.pre` is
 *   set, the derived list applies verbatim (there is no base side to
 *   disjoin with) — strengthening relative to *no* base precondition is
 *   possible and remains the caller's responsibility.
 * - **post** — full union: `[...base.post, ...derived.post]`. Every
 *   predicate from both sides must hold.
 * - **onError** — full union, same rule.
 * - **old** — `derived.old ?? base.old`.
 * - **mode** — `derived.mode ?? base.mode`.
 * - **name** — `derived.name ?? base.name`.
 * - **captureStack** — `derived.captureStack ?? base.captureStack`
 *   (a boolean `false` is a real value, not "unset").
 * - **message** — `derived.message ?? base.message`.
 * - **invariant** — not represented in `ContractOptions` (object invariants
 *   live in the object-contracts module), so there is nothing to merge here.
 *   The rule for object invariants is the same union: every invariant of
 *   every ancestor plus the derived one must hold.
 *
 * Identity: when `derived` is `undefined` the `base` object is returned
 * as-is; when `base` is `undefined` the `derived` object is returned as-is;
 * when both are `undefined`, `undefined` is returned. When both are defined
 * a **new** options object is always produced.
 */
export function mergeContractOptions<A extends unknown[], R>(
    base?: ContractOptions<A, R> | undefined,
    derived?: ContractOptions<A, R> | undefined,
): ContractOptions<A, R> | undefined {
    if (base === undefined) return derived;
    if (derived === undefined) return base;

    // pre — Eiffel disjunction, section-wise: (all base) OR (all derived)
    const basePre = compacted(base.pre);
    const derivedPre = compacted(derived.pre);
    let pre: readonly ConditionPredicate<A>[] | undefined;
    if (basePre.length > 0 && derivedPre.length > 0) {
        const disjunction: NamedCondition<A> = any(
            all(...asConditionInputs(basePre)),
            all(...asConditionInputs(derivedPre)),
        );
        pre = [disjunction];
    } else if (basePre.length > 0) {
        pre = base.pre;
    } else if (derivedPre.length > 0) {
        pre = derived.pre;
    }

    // post / onError — plain union of both sides
    const mergeUnion = <P>(
        fromBase: readonly P[] | undefined,
        fromDerived: readonly P[] | undefined,
    ): readonly P[] | undefined => {
        if (fromBase === undefined) return fromDerived;
        if (fromDerived === undefined) return fromBase;
        return [...compacted(fromBase), ...compacted(fromDerived)];
    };
    const post = mergeUnion(base.post, derived.post);
    const onError = mergeUnion(base.onError, derived.onError);

    const old = derived.old ?? base.old;
    const mode = derived.mode ?? base.mode;
    const name = derived.name ?? base.name;
    const captureStack = derived.captureStack ?? base.captureStack;
    const message = derived.message ?? base.message;

    return {
        ...(pre !== undefined ? { pre } : {}),
        ...(post !== undefined ? { post } : {}),
        ...(onError !== undefined ? { onError } : {}),
        ...(old !== undefined ? { old } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(captureStack !== undefined ? { captureStack } : {}),
        ...(message !== undefined ? { message } : {}),
    };
}

/** Options for {@link mergeClassContracts}. */
export interface MergeClassContractsOptions {
    /** Also merge own static methods of the constructor against the base class's statics. Default `false`. */
    readonly statics?: boolean;
}

type AnyConstructor = abstract new (...args: never[]) => unknown;

/** Skip `Function`/`Object` self and non-constructor ends of a constructor chain. */
const isConstructor = (value: unknown): value is AnyConstructor => typeof value === 'function';

/**
 * Find contract metadata for `key` walking the base prototype chain, nearest
 * ancestor first. Stops before `Object.prototype`.
 */
const findNearestBaseMetadata = (
    baseProto: object,
    key: PropertyKey,
): ContractMetadata | undefined => {
    let current: object | null = baseProto;
    while (current !== null && current !== Object.prototype) {
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (descriptor !== undefined && typeof descriptor.value === 'function') {
            const metadata = getContractMetadata(descriptor.value);
            if (metadata !== undefined) return metadata;
        }
        current = Object.getPrototypeOf(current) as object | null;
    }
    return undefined;
};

/** Same walk over the constructor chain (for statics). */
const findNearestBaseStaticMetadata = (
    base: AnyConstructor,
    key: PropertyKey,
): ContractMetadata | undefined => {
    let current: AnyConstructor | null = base;
    const baseFunction = Function.prototype as unknown;
    while (
        current !== null &&
        (current as unknown) !== baseFunction &&
        (current as unknown) !== Object
    ) {
        const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
        if (descriptor !== undefined && typeof descriptor.value === 'function') {
            const metadata = getContractMetadata(descriptor.value);
            if (metadata !== undefined) return metadata;
        }
        current = Object.getPrototypeOf(current) as AnyConstructor | null;
    }
    return undefined;
};

/**
 * Replace the method at `target[key]` with a `contract()`-wrapped version
 * whose options merge the base and derived sides. No-op (keeps the original)
 * when the merged options are identical to the derived wrapper's own options.
 */
const rewrapMerged = (
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor,
    derivedMeta: ContractMetadata,
    baseMeta: ContractMetadata,
): void => {
    const merged = mergeContractOptions(baseMeta.options, derivedMeta.options);
    // merged === derived options only when the base side had no options at all
    const wrapper =
        merged === undefined || merged === derivedMeta.options
            ? (descriptor.value as (...args: never[]) => unknown)
            : (contract(derivedMeta.fn, merged as ContractOptions<unknown[], unknown>) as (
                  ...args: never[]
              ) => unknown);
    Object.defineProperty(target, key, { ...descriptor, value: wrapper });
};

/**
 * Merge contracts of a class hierarchy, in place, **without** touching the
 * base class or any existing wrapper.
 *
 * For each own (not inherited) prototype method of `Derived` that carries
 * contract metadata, the nearest same-name method found on
 * `Base.prototype`'s chain carrying metadata is merged in via
 * {@link mergeContractOptions}; the entry on `Derived.prototype` is replaced
 * with a **new** `contract()`-wrapped function built from the recorded
 * source function and merged options. Neither the base wrapper nor the
 * derived wrapper is mutated or reused.
 *
 * Notes and limitations, all deliberate:
 *
 * - Own methods only — inherited entries are not copied or re-wrapped.
 * - Accessors (`get`/`set`) are skipped entirely: wrapping them would
 *   change semantics rather than reinforce them. Documented, not an error.
 * - Instance arrow-function fields live on the instance, not the prototype —
 *   out of scope here.
 * - A derived override *without* contract metadata is left untouched (not
 *   auto-wrapped from the base side): merging is opt-in on both sides.
 * - The nearest contracted ancestor wins for one merge. For deep hierarchies,
 *   merge **bottom-up** (`Child` after `Parent`) so each level accumulates
 *   its ancestors' options into its own wrapper metadata.
 * - When `Base` is omitted it is resolved from `Derived`'s prototype chain
 *   (the direct parent constructor, skipping `Object`). If there is none —
 *   nothing to merge.
 * - With `statics: true`, the same walk is applied to `Derived`'s own static
 *   (function-valued) properties against `Base`'s constructor chain.
 *   `length`/`name`/`prototype` are always skipped.
 *
 * Returns `Derived` so calls chain.
 */
export function mergeClassContracts<D extends AnyConstructor>(
    Derived: D,
    Base?: AnyConstructor | undefined,
    options?: MergeClassContractsOptions,
): D {
    const derivedProto = (Derived as unknown as { prototype?: object }).prototype;
    if (derivedProto === undefined) return Derived;

    let baseProto: object | null = null;
    let baseCtor: AnyConstructor | undefined = Base;
    if (baseCtor === undefined) {
        const parent = Object.getPrototypeOf(derivedProto) as object | null;
        const ctor =
            parent !== null ? (parent as { constructor?: unknown }).constructor : undefined;
        if (isConstructor(ctor) && ctor !== Object) {
            baseCtor = ctor;
        }
    }
    if (baseCtor !== undefined) {
        baseProto = baseCtor.prototype as object;
    }

    if (baseProto !== null) {
        for (const key of Reflect.ownKeys(derivedProto)) {
            if (key === 'constructor') continue;
            const descriptor = Reflect.getOwnPropertyDescriptor(derivedProto, key);
            if (descriptor === undefined) continue;
            // accessors skipped — wrapping changes semantics, not reinforces
            if (descriptor.get !== undefined || descriptor.set !== undefined) continue;
            if (typeof descriptor.value !== 'function') continue;
            const derivedMeta = getContractMetadata(descriptor.value);
            if (derivedMeta === undefined) continue;
            const baseMeta = findNearestBaseMetadata(baseProto, key);
            if (baseMeta === undefined) continue;
            rewrapMerged(derivedProto, key, descriptor, derivedMeta, baseMeta);
        }
    }

    if (options?.statics === true && baseCtor !== undefined) {
        for (const key of Reflect.ownKeys(Derived)) {
            if (key === 'prototype' || key === 'length' || key === 'name') continue;
            const descriptor = Reflect.getOwnPropertyDescriptor(Derived, key);
            if (descriptor === undefined) continue;
            if (typeof descriptor.value !== 'function') continue;
            const derivedMeta = getContractMetadata(descriptor.value);
            if (derivedMeta === undefined) continue;
            const baseMeta = findNearestBaseStaticMetadata(baseCtor, key);
            if (baseMeta === undefined) continue;
            rewrapMerged(Derived, key, descriptor, derivedMeta, baseMeta);
        }
    }

    return Derived;
}
