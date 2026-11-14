/**
 * Named conditions — the reusable unit of a node-contracts assertion.
 *
 * A named condition is a plain data structure plus a `check()` method. It is
 * deliberately NOT callable: conditions travel through contracts, evaluators
 * and error payloads, and a `.check(...)` call is unambiguous about where
 * evaluation happens. Calling a condition as a function never worked, is not
 * supported, and never will be.
 *
 * Composites (`all`, `any`, `not`) are named conditions too, so they nest
 * freely and report which component failed through `lastFailure`.
 */

/** Which composite operator produced a condition. */
export type ConditionOperator = 'all' | 'any' | 'not';

/**
 * Details about the most recent failing `check()` call.
 *
 * Only composite conditions populate this (plain conditions fail without
 * sub-structure). The shape is pure JSON-safe data so it can be attached
 * to error contexts without further processing.
 *
 * - `operator` — the composite that rejected the input.
 * - `index` — zero-based index of the failed component in `all`, `0` for
 *   `not`, and `-1` for `any` (there is no single culprit, every child
 *   failed; see `components`).
 * - `conditionId` / `conditionName` — the failing child, or the composite
 *   itself for `any` failures.
 * - `message` — the failing child's own message override, if it had one.
 * - `cause` — the child's own `lastFailure`, when the child was itself a
 *   composite. Chains arbitrarily deep.
 * - `components` — per-child failures in declaration order, only for `any`.
 */
export interface ConditionFailure {
    readonly operator: ConditionOperator;
    readonly index: number;
    readonly conditionId: string;
    readonly conditionName: string;
    readonly message: string | undefined;
    readonly cause: ConditionFailure | undefined;
    readonly components: readonly ConditionFailure[] | undefined;
}

/**
 * A named condition.
 *
 * `lastFailure` is the only mutable field: every `check()` call clears it,
 * and composite operators repopulate it when they fail. Read it right after
 * a `false` result — later calls (possibly on other conditions) will have
 * cleared or replaced it. JS stays single-threaded and `check()` is fully
 * synchronous, so this is safe as long as you read it before returning to
 * the event loop.
 *
 * `components` and `operator` are `undefined` for plain conditions created
 * via {@link condition}. `predicate` on a composite holds the composed
 * function; prefer `check()`, which additionally maintains `lastFailure`.
 */
export interface NamedCondition<Args extends unknown[]> {
    /** Brand tag, handy for cross-checking with {@link isNamedCondition}. */
    readonly _tag: 'node-contracts/condition';
    /** Explicit name, else the predicate's own name, else 'anonymous'. */
    readonly name: string;
    /** Stable identifier. Auto-assigned `condition-N` per process unless overridden. */
    readonly id: string;
    /** User-provided failure message override, if any. */
    readonly message: string | undefined;
    /** The raw predicate, or the composed predicate for composites. */
    readonly predicate: (...args: Args) => boolean;
    /** Composite operator when built via {@link all}/{@link any}/{@link not}, else undefined. */
    readonly operator: ConditionOperator | undefined;
    /** Child conditions for composites, in declaration order; undefined otherwise. */
    readonly components: readonly NamedCondition<Args>[] | undefined;
    /** Failure details from the most recent `check()` call, or undefined after success. */
    lastFailure: ConditionFailure | undefined;
    /** Evaluate the condition. Refreshes `lastFailure` synchronously. */
    check(...args: Args): boolean;
}

export interface ConditionOptions {
    /** Display name. Falls back to the predicate's `.name`, then to 'anonymous'. */
    readonly name?: string;
    /** Failure message used when the condition rejects (evaluators may surface it). */
    readonly message?: string;
    /**
     * Explicit, stable identifier.
     *
     * Auto ids are `condition-<n>` with a process-local monotonic counter:
     * they are deterministic within a process (nice for logs and tests) but
     * not stable across restarts. Pass an explicit id when the id needs to
     * survive restarts, e.g. `id: 'precondition:user-email'`.
     */
    readonly id?: string;
}

/** Anything a composite accepts: a named condition or a bare predicate (normalized via {@link condition}). */
export type ConditionInput<Args extends unknown[] = unknown[]> =
    | NamedCondition<Args>
    | ((...args: Args) => boolean);

// Symbol.for lives in the realm-wide registry, so `isNamedCondition` works
// even when the library is loaded twice (dual ESM/CJS packaging or an
// npm/yarn mix). A plain string brand would work too, but this keeps the
// global namespace clean while staying cross-instance safe.
const CONDITION_BRAND: unique symbol = Symbol.for('node-contracts/named-condition');

let idCounter = 0;
const nextConditionId = (): string => {
    idCounter += 1;
    return `condition-${idCounter}`;
};

const resolveName = (
    predicate: { readonly name: string },
    explicit: string | undefined,
): string => {
    const fromOption = explicit?.trim();
    if (fromOption !== undefined && fromOption.length > 0) return fromOption;
    const fromPredicate = predicate.name.trim();
    if (fromPredicate.length > 0) return fromPredicate;
    return 'anonymous';
};

const compositeName = <Args extends unknown[]>(
    operator: ConditionOperator,
    children: readonly NamedCondition<Args>[],
): string => `${operator}(${children.map((child) => child.name).join(', ')})`;

const childFailure = <Args extends unknown[]>(
    operator: ConditionOperator,
    index: number,
    child: NamedCondition<Args>,
): ConditionFailure => ({
    operator,
    index,
    conditionId: child.id,
    conditionName: child.name,
    message: child.message,
    cause: child.lastFailure,
    components: undefined,
});

/**
 * Shared failure tracking for composites. Kept separate from the composed
 * predicate so the predicate stays a plain boolean function for anyone who
 * introspects it; the tracked path is what `check()` runs.
 */
const runAll = <Args extends unknown[]>(
    children: readonly NamedCondition<Args>[],
    args: Args,
): ConditionFailure | undefined => {
    for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (child === undefined) continue; // sparse by construction, but noUncheckedIndexedAccess wants this
        if (!child.check(...args)) return childFailure('all', index, child);
    }
    return undefined;
};

const runAny = <Args extends unknown[]>(
    children: readonly NamedCondition<Args>[],
    args: Args,
): ConditionFailure | undefined => {
    const failures: ConditionFailure[] = [];
    for (let index = 0; index < children.length; index++) {
        const child = children[index];
        if (child === undefined) continue;
        if (child.check(...args)) return undefined;
        failures.push(childFailure('any', index, child));
    }
    // no component passed, so name the composite itself as the culprit
    return {
        operator: 'any',
        index: -1,
        conditionId: '',
        conditionName: '',
        message: undefined,
        cause: undefined,
        components: failures,
    };
};

interface ConditionInit<Args extends unknown[]> {
    readonly name: string;
    readonly id: string;
    readonly message: string | undefined;
    readonly predicate: (...args: Args) => boolean;
    readonly operator: ConditionOperator | undefined;
    readonly components: readonly NamedCondition<Args>[] | undefined;
}

const defineCondition = <Args extends unknown[]>(
    init: ConditionInit<Args>,
    evaluate: (self: NamedCondition<Args>, args: Args) => boolean,
): NamedCondition<Args> => {
    const condition: NamedCondition<Args> = {
        _tag: 'node-contracts/condition',
        id: init.id,
        name: init.name,
        message: init.message,
        predicate: init.predicate,
        operator: init.operator,
        components: init.components,
        lastFailure: undefined,
        check(...args: Args): boolean {
            condition.lastFailure = undefined;
            return evaluate(condition, args);
        },
    };
    // not enumerable on purpose: keeps accidental spreads/JSON.dumps tidy
    Object.defineProperty(condition, CONDITION_BRAND, { value: true, enumerable: false });
    return condition;
};

/** Normalize a bare predicate or a named condition into a named condition. */
const normalize = <Args extends unknown[]>(input: ConditionInput<Args>): NamedCondition<Args> =>
    isNamedCondition<Args>(input) ? input : condition(input);

/**
 * Create a named condition from a predicate.
 *
 * `Args` is inferred conservatively from the predicate itself; when in
 * doubt, spell it out: `condition<[number]>((n) => n > 0)`.
 *
 * ```ts
 * const positiveNumber = condition<[number]>((n) => n > 0, {
 *     name: 'positiveNumber',
 *     message: 'Expected a positive number',
 * });
 * ```
 */
export function condition<Args extends unknown[]>(
    predicate: (...args: Args) => boolean,
    options?: ConditionOptions,
): NamedCondition<Args> {
    const message = options?.message;
    return defineCondition<Args>(
        {
            name: resolveName(predicate, options?.name),
            id: options?.id ?? nextConditionId(),
            message,
            predicate,
            operator: undefined,
            components: undefined,
        },
        (_self, args) => predicate(...args),
    );
}

/**
 * Logical AND over named conditions. Short-circuits on the first failure.
 * Accepts named conditions or bare predicates (normalized via {@link condition}).
 * `all()` with no components always passes, mirroring `Array.every`.
 */
export function all<Args extends unknown[]>(
    ...conditions: readonly ConditionInput<Args>[]
): NamedCondition<Args> {
    const children = conditions.map((input) => normalize(input));
    const name = compositeName('all', children);
    const composed = (...args: Args): boolean => {
        for (const child of children) {
            if (!child.check(...args)) return false;
        }
        return true;
    };
    return defineCondition<Args>(
        {
            name,
            id: nextConditionId(),
            message: undefined,
            predicate: composed,
            operator: 'all',
            components: children,
        },
        (self, args) => {
            const failure = runAll(children, args);
            self.lastFailure = failure;
            return failure === undefined;
        },
    );
}

/**
 * Logical OR over named conditions. Short-circuits on the first pass.
 * Accepts named conditions or bare predicates (normalized via {@link condition}).
 * Every child is evaluated when none pass, so `lastFailure.components`
 * carries the full picture of why the union failed. `any()` with no
 * components always fails, mirroring `Array.every`/`Array.some` semantics.
 */
export function any<Args extends unknown[]>(
    ...conditions: readonly ConditionInput<Args>[]
): NamedCondition<Args> {
    const children = conditions.map((input) => normalize(input));
    const name = compositeName('any', children);
    const composed = (...args: Args): boolean => {
        for (const child of children) {
            if (child.check(...args)) return true;
        }
        return false;
    };
    return defineCondition<Args>(
        {
            name,
            id: nextConditionId(),
            message: undefined,
            predicate: composed,
            operator: 'any',
            components: children,
        },
        (self, args) => {
            const failure = runAny(children, args);
            if (failure !== undefined) {
                // fill in the composite's identity now that it exists
                self.lastFailure = { ...failure, conditionId: self.id, conditionName: self.name };
            } else {
                self.lastFailure = undefined;
            }
            return failure === undefined;
        },
    );
}

/**
 * Logical NOT over a named condition.
 * Accepts a named condition or a bare predicate (normalized via {@link condition}).
 *
 * Note: the child still runs, so a child composite tracks its own
 * `lastFailure` as usual. `not` itself fails (and sets `lastFailure`) only
 * when the child unexpectedly passes — there is no deeper cause in that
 * case, since a passing child has no failure to nest.
 */
export function not<Args extends unknown[]>(input: ConditionInput<Args>): NamedCondition<Args> {
    const child = normalize(input);
    const name = compositeName('not', [child]);
    const children = [child];
    const composed = (...args: Args): boolean => !child.check(...args);
    return defineCondition<Args>(
        {
            name,
            id: nextConditionId(),
            message: undefined,
            predicate: composed,
            operator: 'not',
            components: children,
        },
        (self, args) => {
            const ok = child.check(...args);
            if (!ok) {
                // child failed, so the negation passes
                self.lastFailure = undefined;
                return true;
            }
            // child passed when it was expected to fail — this is the
            // composite's own failure, and there is no deeper cause to report
            self.lastFailure = childFailure('not', 0, child);
            return false;
        },
    );
}

/**
 * Type guard for named conditions.
 *
 * Distinguishes `condition(...)` structures from plain predicate functions,
 * which evaluators also accept. Uses the realm-global brand symbol, so it
 * stays reliable across dual-package installs.
 *
 * `Args` defaults to `unknown[]`; narrow it when you know the tuple:
 * `isNamedCondition<[number]>(value)`.
 */
export function isNamedCondition<Args extends unknown[] = unknown[]>(
    value: unknown,
): value is NamedCondition<Args> {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<PropertyKey, unknown>;
    return (
        candidate[CONDITION_BRAND] === true &&
        typeof candidate['id'] === 'string' &&
        typeof candidate['name'] === 'string' &&
        typeof candidate['check'] === 'function' &&
        typeof candidate['predicate'] === 'function'
    );
}
