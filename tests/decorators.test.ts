/**
 * Tests for @contractMethod.
 *
 * The repo's vite:oxc transform does not lower native (Stage 3) decorator
 * syntax — decorators are passed through to V8, which cannot parse them —
 * so these tests apply the decorator through its exact public contract:
 * `contractMethod(options)(value, context)`, where `context` carries the
 * fields the decorator reads (kind/name/static/private/access).
 *
 * The decorator resolves the base-class merge at call time (first call,
 * cached on the wrapper) — no construction/definition hooks are involved,
 * so the harness needs no initializer simulation: `dec()` swaps a member
 * for the decorated wrapper and `initInstance()` is an identity kept for
 * readability at call sites.
 *
 * Everything else — merging, lazy resolution through the prototype chain,
 * wrapper identity, metadata — is the real decorator implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractContext, ContractMethodOptions } from '../src/index.js';
import {
    condition,
    configure,
    contract,
    contractMethod,
    getContractMetadata,
    OnErrorViolationError,
    PostconditionViolationError,
    PreconditionViolationError,
    resetConfig,
} from '../src/index.js';

type MemberKind = 'method' | 'getter' | 'setter';
type MemberFlags = { isStatic?: boolean; isPrivate?: boolean };

interface FakeContext {
    kind: MemberKind | 'field';
    name: string;
    static: boolean;
    private: boolean;
    access: { get(): unknown; set(value: unknown): void };
}

const decocer = (options?: unknown): ((value: unknown, context: unknown) => unknown) =>
    contractMethod(options as ContractMethodOptions) as unknown as (
        value: unknown,
        context: unknown,
    ) => unknown;

const makeContext = (
    ctor: Function,
    key: string,
    kind: MemberKind | 'field',
    flags: MemberFlags = {},
): FakeContext => {
    const target: Record<PropertyKey, unknown> = flags.isStatic
        ? (ctor as unknown as Record<PropertyKey, unknown>)
        : (ctor.prototype as unknown as Record<PropertyKey, unknown>);
    return {
        kind,
        name: key,
        static: flags.isStatic ?? false,
        private: flags.isPrivate ?? false,
        access: {
            get: () => target[key],
            set: () => {},
        },
    };
};

/** apply the decorator to an existing member (call after the class is defined) */
const dec = (
    ctor: Function,
    key: string,
    options: unknown,
    kind: MemberKind,
    flags: MemberFlags = {},
) => {
    const target: object = flags.isStatic ? ctor : ctor.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) throw new Error(`member ${String(key)} not found on ${kind}`);
    const value =
        kind === 'method' ? descriptor.value : kind === 'getter' ? descriptor.get : descriptor.set;
    const wrapped = decocer(options)(value, makeContext(ctor, key, kind, flags));
    if (kind === 'method') {
        Object.defineProperty(target, key, {
            ...descriptor,
            value: wrapped as (...args: never[]) => unknown,
        });
    } else if (kind === 'getter') {
        Object.defineProperty(target, key, { ...descriptor, get: wrapped as () => unknown });
    } else {
        Object.defineProperty(target, key, { ...descriptor, set: wrapped as (v: unknown) => void });
    }
    return wrapped;
};

/** identity helper — call-time merge needs no construction hook; kept so call sites read naturally */
const initInstance = <T extends object>(instance: T): T => instance;

/** field replacement initializer, as returned by the decorator for arrow-function fields */
const fieldInitializer = (options: unknown, key = 'field', isStatic = false) => {
    const ctx: FakeContext = {
        kind: 'field',
        name: key,
        static: isStatic,
        private: false,
        access: { get: () => undefined, set: () => {} },
    };
    return decocer(options)(undefined, ctx) as (this: unknown, initialValue: unknown) => unknown;
};

const catchAsyncError = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
        await run();
    } catch (error) {
        return error;
    }
    throw new Error('expected the function to throw');
};

describe('@contractMethod on an instance method', () => {
    class Greeter {
        greet(name: string): string {
            return `hi ${name}`;
        }
    }
    dec(Greeter, 'greet', { pre: [(name: string) => name.length > 0] }, 'method');

    it('runs the method when the precondition holds', () => {
        expect(initInstance(new Greeter()).greet('ada')).toBe('hi ada');
    });

    it('throws PreconditionViolationError when the precondition fails, without calling fn', () => {
        const spy = vi.fn((name: string) => `hi ${name}`);
        class SpyGreeter {
            greet(name: string): string {
                return spy(name);
            }
        }
        dec(SpyGreeter, 'greet', { pre: [() => false] }, 'method');
        expect(() => initInstance(new SpyGreeter()).greet('ada')).toThrow(
            PreconditionViolationError,
        );
        expect(spy).not.toHaveBeenCalled();
    });

    it('applies postconditions to the return value', () => {
        class Positive {
            compute(x: number): number {
                return x;
            }
        }
        dec(Positive, 'compute', { post: [(r: number) => r > 0] }, 'method');
        const instance = initInstance(new Positive());
        expect(instance.compute(4)).toBe(4);
        expect(() => instance.compute(-4)).toThrow(PostconditionViolationError);
    });

    it('keeps fn.name and fn.length on the decorated wrapper', () => {
        class Combiner {
            combine(first: string, second: string, third: string): string {
                return `${first}${second}${third}`;
            }
        }
        dec(Combiner, 'combine', undefined, 'method');
        const descriptor = Object.getOwnPropertyDescriptor(Combiner.prototype, 'combine');
        expect(descriptor?.value.name).toBe('combine');
        expect(descriptor?.value.length).toBe(3);
    });

    it('works with zero-argument @contractMethod()', () => {
        class Plain {
            answer(): number {
                return 42;
            }
        }
        dec(Plain, 'answer', undefined, 'method');
        expect(initInstance(new Plain()).answer()).toBe(42);
    });

    it('exposes the instance as context.self to post predicates', () => {
        let seenSelf: unknown;
        class Owned {
            readonly size = 3;
            measure(): number {
                return this.size;
            }
        }
        dec(
            Owned,
            'measure',
            {
                post: [
                    (_r: number, ctx: ContractContext<[], number>) => {
                        seenSelf = ctx.self;
                        return true;
                    },
                ],
            },
            'method',
        );
        const instance = initInstance(new Owned());
        expect(instance.measure()).toBe(3);
        expect(seenSelf).toBe(instance);
    });
});

describe('@contractMethod — override merges with a decorated base class member', () => {
    const basePre = condition<[number]>((x) => x >= 100, { name: 'basePre' });
    const basePost = condition<[number, ContractContext<[number], number>]>((r) => r > 0, {
        name: 'basePost',
    });
    const derivedPre = condition<[number]>((x) => x >= 0, { name: 'derivedPre' });
    const derivedPost = condition<[number, ContractContext<[number], number>]>(
        (r) => r < 1_000_000,
        { name: 'derivedPost' },
    );

    class BaseWidget {
        measure(x: number): number {
            return x * 2;
        }
    }
    dec(BaseWidget, 'measure', { pre: [basePre], post: [basePost] }, 'method');

    class ScaledWidget extends BaseWidget {
        override measure(x: number): number {
            if (x === 999_999) return -1;
            return x * 2;
        }
    }
    dec(ScaledWidget, 'measure', { pre: [derivedPre], post: [derivedPost] }, 'method');

    it('rescues via the derived precondition when only it holds (Liskov disjunction)', () => {
        expect(initInstance(new ScaledWidget()).measure(50)).toBe(100);
    });

    it('rescues via the base precondition alone', () => {
        expect(initInstance(new ScaledWidget()).measure(150)).toBe(300);
    });

    it('throws PreconditionViolationError only when both sides fail', () => {
        expect(() => initInstance(new ScaledWidget()).measure(-5)).toThrow(
            PreconditionViolationError,
        );
    });

    it('fails the base postcondition first (base union position 0)', () => {
        const caught = (() => {
            try {
                return initInstance(new ScaledWidget()).measure(999_999);
            } catch (error) {
                return error;
            }
        })() as unknown;
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        const error = caught as PostconditionViolationError;
        expect(error.conditionName).toBe('basePost');
        expect(error.conditionIndex).toBe(0);
    });

    it('fails the derived postcondition at index 1 when base passes', () => {
        const caught = (() => {
            try {
                return initInstance(new ScaledWidget()).measure(600_000);
            } catch (error) {
                return error;
            }
        })() as unknown;
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        const error = caught as PostconditionViolationError;
        expect(error.conditionName).toBe('derivedPost');
        expect(error.conditionIndex).toBe(1);
    });

    it('enforces the merged contract through a base-typed reference (Liskov)', () => {
        const asBase: BaseWidget = initInstance(new ScaledWidget());
        expect(asBase.measure(50)).toBe(100);
        expect(() => asBase.measure(-5)).toThrow(PreconditionViolationError);
    });

    it('merges metadata post arrays with base first after the first call', () => {
        class MetaBase {
            value(): number {
                return 1;
            }
        }
        dec(
            MetaBase,
            'value',
            {
                post: [
                    condition<[number, ContractContext<[number], number>]>(() => true, {
                        name: 'metaBasePost',
                    }),
                ],
            },
            'method',
        );
        class MetaDerived extends MetaBase {
            override value(): number {
                return 2;
            }
        }
        dec(
            MetaDerived,
            'value',
            {
                post: [
                    condition<[number, ContractContext<[number], number>]>(() => true, {
                        name: 'metaDerivedPost',
                    }),
                ],
            },
            'method',
        );

        // provisional metadata is own-only before the first call
        const provisional = getContractMetadata(MetaDerived.prototype.value);
        expect(provisional?.options.post).toHaveLength(1);

        new MetaDerived().value(); // first call resolves the merge
        const merged = getContractMetadata(MetaDerived.prototype.value);
        expect(merged?.options.post?.map((entry) => (entry as { name?: string }).name)).toEqual([
            'metaBasePost',
            'metaDerivedPost',
        ]);
    });

    it('accumulates a three-level hierarchy (grandparent + parent + derived)', () => {
        const grandPost = condition<[number, ContractContext<[number], number>]>(() => true, {
            name: 'grandPost',
        });
        const midPost = condition<[number, ContractContext<[number], number>]>(() => true, {
            name: 'midPost',
        });
        const leafPost = condition<[number, ContractContext<[number], number>]>(() => true, {
            name: 'leafPost',
        });

        class Grand {
            earn(): number {
                return 1;
            }
        }
        dec(Grand, 'earn', { post: [grandPost] }, 'method');
        class Mid extends Grand {
            override earn(): number {
                return 2;
            }
        }
        dec(Mid, 'earn', { post: [midPost] }, 'method');
        class Leaf extends Mid {
            override earn(): number {
                return 3;
            }
        }
        dec(Leaf, 'earn', { post: [leafPost] }, 'method');

        expect(initInstance(new Leaf()).earn()).toBe(3);
        expect(
            getContractMetadata(Leaf.prototype.earn)?.options.post?.map(
                (entry) => (entry as { name?: string }).name,
            ),
        ).toEqual(['grandPost', 'midPost', 'leafPost']);
    });

    it('applies the effective pre disjunction through the chain with a this-bound call', () => {
        // grand rejects < 100, mid rejects < 200, leaf declares nothing of its own.
        // calling the leaf override with 150 must be rescued by the grand side —
        // the mid side of the hierarchy must not swallow grand's precondition
        const grandPre = condition<[number]>((x) => x >= 100, { name: 'grandPre' });
        const midPre = condition<[number]>((x) => x >= 200, { name: 'midPre' });

        class PreGrand {
            run(x: number): number {
                return x;
            }
        }
        dec(PreGrand, 'run', { pre: [grandPre] }, 'method');
        class PreMid extends PreGrand {
            override run(x: number): number {
                return super.run(x);
            }
        }
        dec(PreMid, 'run', { pre: [midPre] }, 'method');
        class PreLeaf extends PreMid {
            override run(x: number): number {
                return super.run(x);
            }
        }
        dec(PreLeaf, 'run', {}, 'method');

        const leaf = initInstance(new PreLeaf());
        // 150: grand side passes, mid side fails — the grand disjunct rescues the call
        expect(leaf.run(150)).toBe(150);
        // 250: mid side passes
        expect(leaf.run(250)).toBe(250);
        // 50: both sides fail — must throw
        expect(() => leaf.run(50)).toThrow(PreconditionViolationError);

        // same through a base-typed reference (the whole point of Liskov)
        const asBase: PreGrand = leaf;
        expect(asBase.run(150)).toBe(150);
        expect(() => asBase.run(50)).toThrow(PreconditionViolationError);
    });

    it('merges with a plain contract()-wrapped base (no decorator on the base side)', () => {
        const basePlainPost = condition<[number, ContractContext<[], number>]>((r) => r > 100, {
            name: 'basePlainPost',
        });
        class PlainBase {
            helper(): number {
                return 5;
            }
        }
        PlainBase.prototype.helper = contract(PlainBase.prototype.helper, {
            post: [basePlainPost],
        });
        class PlainDerived extends PlainBase {
            override helper(): number {
                return 5;
            }
        }
        dec(PlainDerived, 'helper', { post: [(r: number) => r > 0] }, 'method');

        const caught = (() => {
            try {
                return initInstance(new PlainDerived()).helper();
            } catch (error) {
                return error;
            }
        })() as unknown;
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        expect((caught as PostconditionViolationError).conditionName).toBe('basePlainPost');
        expect((caught as PostconditionViolationError).conditionIndex).toBe(0);
    });
});

describe('@contractMethod on a getter', () => {
    class Tank {
        fuelLevelSeed = 0;
        get fuel(): number {
            return this.fuelLevelSeed;
        }
        get capacity(): number {
            return 500;
        }
    }
    dec(Tank, 'fuel', { post: [(level: number) => level > 0] }, 'getter');
    dec(
        Tank,
        'capacity',
        { post: [(level: number) => level >= 0, (level: number) => level < 1000] },
        'getter',
    );

    it('runs postconditions against the returned value', () => {
        const tank = initInstance(new Tank());
        tank.fuelLevelSeed = 55;
        expect(tank.fuel).toBe(55);
        tank.fuelLevelSeed = 0;
        expect(() => tank.fuel).toThrow(PostconditionViolationError);
    });

    it('supports multiple post predicates in declaration order', () => {
        expect(initInstance(new Tank()).capacity).toBe(500);
    });

    it('exposes the instance as context.self to getter post predicates', () => {
        let self: unknown;
        class SelfGetter {
            get thing(): number {
                return 1;
            }
        }
        dec(
            SelfGetter,
            'thing',
            {
                post: [
                    (_r: number, ctx: ContractContext<[], number>) => {
                        self = ctx.self;
                        return true;
                    },
                ],
            },
            'getter',
        );
        const instance = initInstance(new SelfGetter());
        expect(instance.thing).toBe(1);
        expect(self).toBe(instance);
    });

    it('throws TypeError at definition when a getter declares pre', () => {
        class BadGetter {
            get value(): number {
                return 1;
            }
        }
        expect(() => dec(BadGetter, 'value', { pre: [() => true] }, 'getter')).toThrow(TypeError);
    });
});

describe('@contractMethod on a setter', () => {
    class Meter {
        #reading = 0;
        set reading(value: number) {
            this.#reading = value;
        }
        get reading(): number {
            return this.#reading;
        }
    }
    dec(Meter, 'reading', { pre: [(value: number) => value >= 0] }, 'setter');

    it('passes the assigned value to pre predicates', () => {
        const meter = initInstance(new Meter());
        meter.reading = 12;
        expect(meter.reading).toBe(12);
    });

    it('rejects an assignment that violates the precondition', () => {
        const meter = initInstance(new Meter());
        expect(() => {
            meter.reading = -1;
        }).toThrow(PreconditionViolationError);
        expect(meter.reading).toBe(0);
    });
});

describe('@contractMethod on static members', () => {
    class MathBox {
        static twice(x: number): number {
            return x * 2;
        }
        static whoAmI(): unknown {
            return this;
        }
    }
    dec(MathBox, 'twice', { pre: [(x: number) => x > 0] }, 'method', { isStatic: true });
    dec(MathBox, 'whoAmI', undefined, 'method', { isStatic: true });

    it('enforces contracts on static methods', () => {
        expect(MathBox.twice(21)).toBe(42);
        expect(() => MathBox.twice(0)).toThrow(PreconditionViolationError);
    });

    it('binds this to the constructor in static methods', () => {
        expect(MathBox.whoAmI()).toBe(MathBox);
    });

    it('merges a static override in the derived class against the static base', () => {
        const baseStaticPost = condition<[number, ContractContext<[], number>]>((r) => r >= 0, {
            name: 'baseStaticPost',
        });
        class StaticBase {
            static work(): number {
                return -1;
            }
        }
        dec(StaticBase, 'work', { post: [baseStaticPost] }, 'method', { isStatic: true });

        class StaticDerived extends StaticBase {
            static override work(): number {
                return -1;
            }
        }
        dec(StaticDerived, 'work', undefined, 'method', { isStatic: true });

        const caught = (() => {
            try {
                return StaticDerived.work();
            } catch (error) {
                return error;
            }
        })() as unknown;
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        expect((caught as PostconditionViolationError).conditionName).toBe('baseStaticPost');
    });

    it('provides disjunction semantics for merged static preconditions', () => {
        class DisjBase {
            static pick(x: number): number {
                return x;
            }
        }
        dec(DisjBase, 'pick', { pre: [(x: number) => x >= 100] }, 'method', { isStatic: true });

        class DisjDerived extends DisjBase {
            static override pick(x: number): number {
                return x;
            }
        }
        dec(DisjDerived, 'pick', { pre: [(x: number) => x >= 0] }, 'method', { isStatic: true });

        expect(DisjDerived.pick(50)).toBe(50); // derived side rescues
        expect(() => DisjDerived.pick(-1)).toThrow(PreconditionViolationError);
    });
});

describe('@contractMethod on arrow-function fields', () => {
    const attach = (instance: object, key: string, initializer: unknown) => {
        const target = instance as Record<PropertyKey, unknown>;
        Object.defineProperty(target, key, {
            value: initializer,
            writable: true,
            enumerable: true,
            configurable: true,
        });
    };

    it('wraps the initializer result and enforces pre/post per instance', () => {
        class Search {
            readonly tag = 'search';
        }
        const make = () => {
            const instance = new Search();
            const init = fieldInitializer({
                pre: [(term: string) => term.length > 0],
                post: [(r: string) => r.startsWith('results:')],
            });
            const wrapped = init.call(
                instance,
                (term: string): string => `results:${term}:${instance.tag}`,
            );
            attach(instance, 'search', wrapped);
            return instance as unknown as { search: (term: string) => string };
        };

        const search = make();
        expect(search.search('abc')).toBe('results:abc:search');
        expect(() => search.search('')).toThrow(PreconditionViolationError);
    });

    it('creates a fresh wrapper per instance', () => {
        class Searchish {}
        const make = () => {
            const instance = new Searchish();
            const init = fieldInitializer(undefined);
            const wrapped = init.call(instance, (x: number): number => x);
            attach(instance, 'handle', wrapped);
            return instance as unknown as { handle: (x: number) => number };
        };
        const first = make();
        const second = make();
        expect(first.handle).not.toBe(second.handle);
        expect(first.handle(1)).toBe(1);
        expect(second.handle(2)).toBe(2);
    });

    it('exposes the instance as context.self to field post predicates', () => {
        class SelfField {
            ping = 'pong';
        }
        const instance = new SelfField();
        let self: unknown;
        const init = fieldInitializer({
            post: [
                (_r: string, ctx: ContractContext<[], string>) => {
                    self = ctx.self;
                    return true;
                },
            ],
        });
        attach(
            instance,
            'emit',
            init.call(instance, (): string => 'ping'),
        );
        expect((instance as unknown as { emit(): string }).emit()).toBe('ping');
        expect(self).toBe(instance);
    });

    it('enforces postconditions on the field wrapper result', () => {
        const instance = {};
        const init = fieldInitializer({ post: [() => false] });
        const wrapped = init.call(instance, (): string => 'ping');
        expect(() => (wrapped as (this: unknown) => unknown).call(instance)).toThrow(
            PostconditionViolationError,
        );
    });

    it('throws TypeError at init when the initializer is not a function', () => {
        const init = fieldInitializer({ post: [() => true] });
        expect(() => init.call({}, 42)).toThrow(TypeError);
    });

    it('merges a static arrow-function field against the static base field', () => {
        const baseFieldPost = condition<[number, ContractContext<[], number>]>((r) => r > 0, {
            name: 'baseFieldPost',
        });
        class StaticFieldBase {}
        const baseInit = fieldInitializer({ post: [baseFieldPost] }, 'handler', true);
        Object.defineProperty(StaticFieldBase, 'handler', {
            value: baseInit.call(StaticFieldBase, (_x: number): number => -1),
            writable: true,
            configurable: true,
        });

        class StaticFieldDerived extends StaticFieldBase {}
        const derivedInit = fieldInitializer(undefined, 'handler', true);
        Object.defineProperty(StaticFieldDerived, 'handler', {
            value: derivedInit.call(StaticFieldDerived, (_x: number): number => -1),
            writable: true,
            configurable: true,
        });

        const caught = (() => {
            try {
                return (
                    StaticFieldDerived as unknown as { handler: (x: number) => number }
                ).handler(10);
            } catch (error) {
                return error;
            }
        })() as unknown;
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        expect((caught as PostconditionViolationError).conditionName).toBe('baseFieldPost');
    });
});

describe('@contractMethod — runtime mode handling', () => {
    beforeEach(() => {
        resetConfig();
    });

    afterEach(() => {
        resetConfig();
        vi.restoreAllMocks();
    });

    it('honors a global warn mode: onViolation called, execution continues', () => {
        const onViolation = vi.fn();
        configure({ mode: 'warn', onViolation });

        class Warny {
            act(): string {
                return 'done';
            }
        }
        dec(Warny, 'act', { pre: [() => false] }, 'method');

        expect(initInstance(new Warny()).act()).toBe('done');
        expect(onViolation).toHaveBeenCalledTimes(1);
        expect(onViolation.mock.calls[0]?.[0]).toBeInstanceOf(PreconditionViolationError);
    });

    it('lets a per-decorator strict mode override a global warn', () => {
        configure({ mode: 'warn' });

        class Stricty {
            act(): string {
                return 'done';
            }
        }
        dec(Stricty, 'act', { pre: [() => false], mode: 'strict' }, 'method');

        expect(() => initInstance(new Stricty()).act()).toThrow(PreconditionViolationError);
    });

    it('lets a per-decorator warn mode downgrade a global strict', () => {
        const onViolation = vi.fn();
        configure({ onViolation }); // strict by default

        class Lenient {
            act(): string {
                return 'done';
            }
        }
        dec(Lenient, 'act', { pre: [() => false], mode: 'warn' }, 'method');

        expect(initInstance(new Lenient()).act()).toBe('done');
        expect(onViolation).toHaveBeenCalledTimes(1);
    });

    it('never executes predicates in a global off mode', () => {
        const spy = vi.fn(() => false);
        configure({ mode: 'off' });

        class Offy {
            act(): string {
                return 'done';
            }
        }
        dec(Offy, 'act', { pre: [spy] }, 'method');

        expect(initInstance(new Offy()).act()).toBe('done');
        expect(spy).not.toHaveBeenCalled();
    });
});

describe('@contractMethod — private members', () => {
    // The runtime flags JS-private (#) members with context.private = true; the
    // decorator only reads that flag, so plain members with the flag set exercise
    // the same code path. Private names are never merged across the chain.
    it('works on a private member (own contract, no merge)', () => {
        class Vault {
            open(_k: number): string {
                return 'open';
            }
            tryOpen(k: number): string {
                return this.open(k);
            }
        }
        dec(Vault, 'open', { pre: [(k: number) => k > 0] }, 'method', { isPrivate: true });

        expect(initInstance(new Vault()).tryOpen(1)).toBe('open');
        expect(() => initInstance(new Vault()).tryOpen(-1)).toThrow(PreconditionViolationError);
    });

    it('never merges a base private contract into the derived private member', () => {
        class BaseVault {
            open(): string {
                return 'base-lock';
            }
            enter(): string {
                return this.open();
            }
        }
        dec(BaseVault, 'open', { pre: [() => false] }, 'method', { isPrivate: true });

        class DerivedVault extends BaseVault {
            override open(): string {
                return 'derived-lock';
            }
            override enter(): string {
                return this.open();
            }
        }
        dec(DerivedVault, 'open', { pre: [() => true] }, 'method', { isPrivate: true });

        // the base private contract would fail every call — it must not leak through
        expect(initInstance(new DerivedVault()).enter()).toBe('derived-lock');
    });
});

describe('@contractMethod on async members', () => {
    class AsyncBox {
        async compute(x: number): Promise<number> {
            return x * 2;
        }
        async small(): Promise<number> {
            return 1;
        }
        async failing(): Promise<number> {
            throw new Error('boom');
        }
    }
    dec(
        AsyncBox,
        'compute',
        {
            pre: [async (x: number) => x > 0],
            post: [async (r: number) => r > 0],
        },
        'method',
    );
    dec(AsyncBox, 'small', { post: [async (r: number) => r > 100] }, 'method');
    dec(AsyncBox, 'failing', { onError: [() => false] }, 'method');

    it('awaits async pre and post predicates on the happy path', async () => {
        await expect(initInstance(new AsyncBox()).compute(2)).resolves.toBe(4);
    });

    it('rejects with PreconditionViolationError when the async pre fails', async () => {
        await expect(initInstance(new AsyncBox()).compute(-1)).rejects.toThrow(
            PreconditionViolationError,
        );
    });

    it('rejects with PostconditionViolationError when the async post fails', async () => {
        await expect(initInstance(new AsyncBox()).small()).rejects.toThrow(
            PostconditionViolationError,
        );
    });

    it('reports the base async pre violation for a decorated override', async () => {
        // NOTE: async predicates can only sit at the top level of a contract's pre
        // list — composites evaluate children synchronously, so a merged disjunction
        // of async predicates cannot be awaited. Pre merge is exercised with sync
        // predicates here; async post awaits work through the unioned post list.
        class AsyncBase {
            async compute(x: number): Promise<number> {
                return x;
            }
        }
        dec(
            AsyncBase,
            'compute',
            {
                pre: [(x: number) => x > 100],
                post: [async (r: number) => r > 0],
            },
            'method',
        );

        class AsyncDerived extends AsyncBase {
            override async compute(x: number): Promise<number> {
                return x;
            }
        }
        dec(
            AsyncDerived,
            'compute',
            {
                pre: [(x: number) => x > 0],
                post: [async (r: number) => r > 0],
            },
            'method',
        );

        await expect(initInstance(new AsyncDerived()).compute(5)).resolves.toBe(5); // derived side rescues
        // sync failing predicates throw synchronously (the violation happens before fn runs)
        expect(() => initInstance(new AsyncDerived()).compute(-1)).toThrow(
            PreconditionViolationError,
        );
    });

    it('routes fn rejections through unioned on-error predicates', async () => {
        const error = await catchAsyncError(() => initInstance(new AsyncBox()).failing());
        expect(error).toBeInstanceOf(OnErrorViolationError);
    });
});
