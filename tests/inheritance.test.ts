import { describe, expect, it, vi } from 'vitest';
import {
    all,
    any,
    condition,
    contract,
    getContractMetadata,
    mergeClassContracts,
    mergeContractOptions,
} from '../src/index.js';
import type { ContractContext, ContractOptions, OldValues } from '../src/index.js';
import {
    OnErrorViolationError,
    PostconditionViolationError,
    PreconditionViolationError,
} from '../src/index.js';

const catchError = (run: () => unknown): unknown => {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected the function to throw');
};

describe('mergeContractOptions()', () => {
    it('returns undefined when both sides are undefined', () => {
        expect(mergeContractOptions()).toBeUndefined();
    });

    it('returns the base object by reference when derived is undefined', () => {
        const base: ContractOptions<[number], number> = { post: [() => true] };
        expect(mergeContractOptions(base)).toBe(base);
    });

    it('returns the derived object by reference when base is undefined', () => {
        const derived: ContractOptions<[number], number> = { pre: [() => true] };
        expect(mergeContractOptions(undefined, derived)).toBe(derived);
    });

    it('always produces a new object when both sides are defined', () => {
        const base: ContractOptions<[number], number> = { pre: [() => true] };
        const derived: ContractOptions<[number], number> = { post: [() => true] };
        const merged = mergeContractOptions(base, derived);
        expect(merged).not.toBe(base);
        expect(merged).not.toBe(derived);
        expect(merged).toBeDefined();
    });
});

describe('mergeContractOptions() pre — Eiffel disjunction', () => {
    const baseOnly = [condition<[number]>((n) => n > 100, { name: 'basePre' })];
    const derivedOnly = [condition<[number]>((n) => n > 0, { name: 'derivedPre' })];

    it('keeps base-only pre verbatim (same array reference)', () => {
        const merged = mergeContractOptions<[number], number>({ pre: baseOnly }, {});
        expect(merged?.pre).toBe(baseOnly);
    });

    it('keeps derived-only pre verbatim (same array reference)', () => {
        const merged = mergeContractOptions<[number], number>({}, { pre: derivedOnly });
        expect(merged?.pre).toBe(derivedOnly);
    });

    it('builds a single any(all(base), all(derived)) disjunction when both sides declare pre', () => {
        const merged = mergeContractOptions<[number], number>({ pre: baseOnly }, { pre: derivedOnly });
        expect(merged?.pre).toHaveLength(1);
        const [disjunction] = merged?.pre ?? [];
        expect(disjunction).toMatchObject({ _tag: 'design-contracts/condition' });
        expect((disjunction as { name?: string })?.name).toBe('any(all(basePre), all(derivedPre))');
    });

    it('passes when the derived side holds even if base fails', () => {
        const merged = mergeContractOptions<[number], number>({ pre: baseOnly }, { pre: derivedOnly });
        const fn = contract((n: number) => n, merged);
        expect(fn(150)).toBe(150); // both hold
        expect(() => fn(50)).not.toThrow(); // derived side holds (50 > 0), base fails
    });

    it('passes when base holds and derived fails', () => {
        const base = [condition<[number]>(() => true, { name: 'basePre' })];
        const derived = [condition<[number]>(() => false, { name: 'derivedPre' })];
        const merged = mergeContractOptions<[number], number>({ pre: base }, { pre: derived });
        expect(() => contract((n: number) => n, merged)(1)).not.toThrow();
    });

    it('passes when derived holds and base fails', () => {
        const base = [condition<[number]>(() => false, { name: 'basePre' })];
        const derived = [condition<[number]>(() => true, { name: 'derivedPre' })];
        const merged = mergeContractOptions<[number], number>({ pre: base }, { pre: derived });
        expect(() => contract((n: number) => n, merged)(1)).not.toThrow();
    });

    it('throws only when both sides fail', () => {
        const base = [condition<[number]>(() => false, { name: 'basePre' })];
        const derived = [condition<[number]>(() => false, { name: 'derivedPre' })];
        const merged = mergeContractOptions<[number], number>({ pre: base }, { pre: derived });
        const caught = catchError(() => contract((n: number) => n, merged)(1));
        expect(caught).toBeInstanceOf(PreconditionViolationError);
        const error = caught as PreconditionViolationError;
        expect(error.conditionIndex).toBe(0);
        expect(error.conditionName).toBe('any(all(basePre), all(derivedPre))');
        expect(error.cause).toMatchObject({ operator: 'any', index: -1 });
    });

    it('requires ALL base predicates for the base side of the disjunction, not just one', () => {
        const base = [
            condition<[number]>(() => true, { name: 'baseA' }),
            condition<[number]>(() => false, { name: 'baseB' }),
        ];
        const derived = [condition<[number]>(() => false, { name: 'derivedPre' })];
        const merged = mergeContractOptions<[number], number>({ pre: base }, { pre: derived });
        // base side is all(baseA, baseB) -> false, derived side is all(derivedPre) -> false
        const caught = catchError(() => contract((n: number) => n, merged)(1));
        expect(caught).toBeInstanceOf(PreconditionViolationError);
    });

    it('is never stronger than base.pre alone (Liskov)', () => {
        // any input accepted by base (base side true) must pass after merge
        const base = [condition<[number]>((n) => n > 100, { name: 'basePre' })];
        const derived = [condition<[number]>((n) => n > 1_000_000, { name: 'derivedPre' })];
        const merged = mergeContractOptions<[number], number>({ pre: base }, { pre: derived });
        const fn = contract((n: number) => n, merged);
        expect(fn(101)).toBe(101); // base side true — derived would never allow this
    });
});

describe('mergeContractOptions() post — union, base first', () => {
    const basePost = condition<[number, ContractContext<[number], number>]>((r) => r > 0, {
        name: 'basePost',
    });
    const derivedPost = condition<[number, ContractContext<[number], number>]>((r) => r < 100, {
        name: 'derivedPost',
    });

    it('produces the union with base entries first (same references)', () => {
        const merged = mergeContractOptions<[number], number>(
            { post: [basePost] },
            { post: [derivedPost] },
        );
        expect(merged?.post).toEqual([basePost, derivedPost]);
        expect(merged?.post?.[0]).toBe(basePost);
        expect(merged?.post?.[1]).toBe(derivedPost);
    });

    it('executes both base and derived post predicates', () => {
        const baseSpy = vi.fn(() => true);
        const derivedSpy = vi.fn(() => true);
        const merged = mergeContractOptions<[number], number>(
            { post: [baseSpy] },
            { post: [derivedSpy] },
        );
        contract((n: number) => n, merged)(5);
        expect(baseSpy).toHaveBeenCalledTimes(1);
        expect(derivedSpy).toHaveBeenCalledTimes(1);
    });

    it('reports the base predicate at index 0 when both fail', () => {
        const baseFail = condition<[number, ContractContext<[number], number>]>(() => false, {
            name: 'basePost',
        });
        const derivedFail = condition<[number, ContractContext<[number], number>]>(() => false, {
            name: 'derivedPost',
        });
        const merged = mergeContractOptions<[number], number>(
            { post: [baseFail] },
            { post: [derivedFail] },
        );
        const caught = catchError(() => contract((n: number) => n, merged)(1));
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        const error = caught as PostconditionViolationError;
        expect(error.conditionIndex).toBe(0);
        expect(error.conditionName).toBe('basePost');
    });

    it('reports the derived predicate at index 1 when only it fails', () => {
        const merged = mergeContractOptions<[number], number>(
            { post: [basePost] },
            { post: [derivedPost] },
        );
        // basePost passes (150 > 0), derivedPost fails (150 >= 100)
        const caught = catchError(() => contract((_n: number) => 150, merged)(0));
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        const error = caught as PostconditionViolationError;
        expect(error.conditionIndex).toBe(1);
        expect(error.conditionName).toBe('derivedPost');
    });

    it('keeps one side verbatim when the other is undefined', () => {
        expect(mergeContractOptions<[number], number>({ post: [basePost] }, undefined)?.post).toEqual([basePost]);
    });
});

describe('mergeContractOptions() onError — union, base first', () => {
    it('executes both base and derived on-error predicates, base first', () => {
        const seen: string[] = [];
        const base = [() => (seen.push('base'), true)];
        const derived = [() => (seen.push('derived'), true)];
        const merged = mergeContractOptions<[number], number>({ onError: base }, { onError: derived });
        const failing = contract<[number], number>((_n: number): number => {
            throw new Error('boom');
        }, merged);
        expect(() => failing(0)).toThrow('boom');
        expect(seen).toEqual(['base', 'derived']);
    });

    it('reports the base predicate at index 0 when both fail', () => {
        const baseFail = condition<[unknown, ContractContext<[number], number>]>(() => false, {
            name: 'baseOnError',
        });
        const derivedFail = condition<[unknown, ContractContext<[number], number>]>(() => false, {
            name: 'derivedOnError',
        });
        const merged = mergeContractOptions<[number], number>(
            { onError: [baseFail] },
            { onError: [derivedFail] },
        );
        const failing = contract<[number], number>((_n: number): number => {
            throw new Error('boom');
        }, merged);
        const caught = catchError(() => failing(0));
        expect(caught).toBeInstanceOf(OnErrorViolationError);
        const error = caught as OnErrorViolationError;
        expect(error.conditionIndex).toBe(0);
        expect(error.conditionName).toBe('baseOnError');
    });

    it('reports the derived predicate at index 1 when base passes and derived fails', () => {
        const basePass = condition<[unknown, ContractContext<[number], number>]>(() => true, {
            name: 'baseOnError',
        });
        const derivedFail = condition<[unknown, ContractContext<[number], number>]>(() => false, {
            name: 'derivedOnError',
        });
        const merged = mergeContractOptions<[number], number>(
            { onError: [basePass] },
            { onError: [derivedFail] },
        );
        const failing = contract<[number], number>((_n: number): number => {
            throw new Error('boom');
        }, merged);
        const caught = catchError(() => failing(0));
        expect(caught).toBeInstanceOf(OnErrorViolationError);
        expect((caught as OnErrorViolationError).conditionIndex).toBe(1);
    });
});

describe('mergeContractOptions() scalar options — derived wins, undefined means unset', () => {
    it('picks old from derived when both are set', () => {
        const merged = mergeContractOptions<[number], number>(
            { old: ['baseName'] },
            { old: ['derivedName'] },
        );
        expect(merged?.old).toEqual(['derivedName']);
    });

    it('falls back to base old when derived old is unset', () => {
        const merged = mergeContractOptions<[number], number>({ old: ['baseName'] }, {});
        expect(merged?.old).toEqual(['baseName']);
    });

    it('picks mode from derived over base', () => {
        expect(mergeContractOptions<[number], number>({ mode: 'strict' }, { mode: 'warn' })?.mode).toBe('warn');
        expect(mergeContractOptions<[number], number>({ mode: 'warn' }, {})?.mode).toBe('warn');
    });

    it('picks name from derived over base', () => {
        expect(mergeContractOptions<[number], number>({ name: 'base' }, { name: 'derived' })?.name).toBe('derived');
        expect(mergeContractOptions<[number], number>({ name: 'base' }, {})?.name).toBe('base');
    });

    it('lets an explicit false captureStack from derived beat a base true', () => {
        expect(
            mergeContractOptions<[number], number>({ captureStack: true }, { captureStack: false })?.captureStack,
        ).toBe(false);
        expect(
            mergeContractOptions<[number], number>({ captureStack: false }, {})?.captureStack,
        ).toBe(false);
    });

    it('lets an explicit false captureStack from base apply when derived is unset', () => {
        expect(mergeContractOptions<[number], number>({ captureStack: false }, {})?.captureStack).toBe(false);
    });

    it('picks message from derived over base', () => {
        expect(mergeContractOptions<[number], number>({ message: 'base' }, { message: 'derived' })?.message).toBe('derived');
        expect(mergeContractOptions<[number], number>({ message: 'base' }, {})?.message).toBe('base');
    });

    it('leaves every scalar option unset when both sides leave them unset', () => {
        const merged = mergeContractOptions<[number], number>({}, {});
        expect(merged?.old).toBeUndefined();
        expect(merged?.mode).toBeUndefined();
        expect(merged?.name).toBeUndefined();
        expect(merged?.captureStack).toBeUndefined();
        expect(merged?.message).toBeUndefined();
        expect(merged?.pre).toBeUndefined();
        expect(merged?.post).toBeUndefined();
        expect(merged?.onError).toBeUndefined();
    });

    it('honors a merged captureStack: false by suppressing the stack trace', () => {
        const merged = mergeContractOptions<[number], number>(
            { captureStack: true },
            { captureStack: false },
        );
        const failing = contract((n: number) => n, { ...merged, pre: [() => false] });
        const caught = catchError(() => failing(1));
        expect(caught).toBeInstanceOf(PreconditionViolationError);
        expect((caught as PreconditionViolationError).stack).toBeUndefined();
    });

    it('honors a merged per-contract mode: off by skipping the predicates entirely', () => {
        const spy = vi.fn(() => false);
        const merged = mergeContractOptions<[number], number>({ mode: 'strict' }, { mode: 'off' });
        const fn = contract((n: number) => n * 2, { ...merged, pre: [spy] });
        expect(fn(21)).toBe(42);
        expect(spy).not.toHaveBeenCalled();
    });

    it('exposes the base old snapshot to a merged postcondition via context.old', () => {
        let captured: OldValues | undefined;
        const merged = mergeContractOptions<[number], number>(
            { old: ['amount'] },
            {
                post: [
                    (_result, context) => {
                        captured = context.old;
                        return true;
                    },
                ],
            },
        );
        contract((amount: number) => amount, merged)(7);
        expect(captured).toMatchObject({ amount: 7 });
    });
});

describe('mergeClassContracts()', () => {
    const namedPost = <A extends unknown[] = [number]>(
        name: string,
        pred: (r: number) => boolean,
    ) => condition<[number, ContractContext<A, number>]>(pred, { name });

    it('replaces the derived prototype method with a fresh wrapper and returns the class', () => {
        class Widget {
            describe(n: number): number {
                return n;
            }
        }
        Widget.prototype.describe = contract(Widget.prototype.describe, {
            post: [namedPost('basePost', () => true)],
        });

        class FancyWidget extends Widget {
            override describe(n: number): number {
                return n + 1;
            }
        }
        const derivedWrapper = contract(FancyWidget.prototype.describe, {
            post: [namedPost('derivedPost', () => true)],
        });
        FancyWidget.prototype.describe = derivedWrapper;
        const baseWrapper = Widget.prototype.describe;

        const returned = mergeClassContracts(FancyWidget, Widget);

        expect(returned).toBe(FancyWidget);
        // prototype entry was swapped for a new wrapper
        expect(FancyWidget.prototype.describe).not.toBe(derivedWrapper);
        // base wrapper untouched
        expect(Widget.prototype.describe).toBe(baseWrapper);
        // old derived wrapper not mutated either — its options stay the pre-merge set
        expect(getContractMetadata(derivedWrapper)?.options.post).toHaveLength(1);
    });

    it('enforces the merged contract on the swapped-in wrapper (base post then derived post)', () => {
        class Widget {
            describe(n: number): number {
                return n;
            }
        }
        Widget.prototype.describe = contract(Widget.prototype.describe, {
            post: [namedPost('basePost', (r) => r >= 0)],
        });

        class FancyWidget extends Widget {
            override describe(n: number): number {
                return n; // returns -5 when asked, breaking basePost
            }
        }
        FancyWidget.prototype.describe = contract(FancyWidget.prototype.describe, {
            post: [namedPost('derivedPost', () => true)],
        });

        mergeClassContracts(FancyWidget, Widget);

        const caught = catchError(() => new FancyWidget().describe(-5));
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        const error = caught as PostconditionViolationError;
        expect(error.conditionIndex).toBe(0);
        expect(error.conditionName).toBe('basePost');
    });

    it('resolves the direct proto-parent as base when none is given', () => {
        class Solo {
            describe(n: number): number {
                return n;
            }
        }
        Solo.prototype.describe = contract(Solo.prototype.describe, {
            post: [namedPost('basePost', (r) => r >= 0)],
        });

        class SoloChild extends Solo {
            override describe(n: number): number {
                return n;
            }
        }
        SoloChild.prototype.describe = contract(SoloChild.prototype.describe, {
            post: [namedPost('derivedPost', () => true)],
        });

        mergeClassContracts(SoloChild);

        const caught = catchError(() => new SoloChild().describe(-1));
        expect(caught).toBeInstanceOf(PostconditionViolationError);
    });

    it('accumulates contracts bottom-up over a Grand/Base/Derived chain', () => {
        class Grand {
            seg(x: number): number {
                return x + 1;
            }
        }
        const grandSpy = vi.fn(() => true);
        const basePost = namedPost('basePost', () => true);
        const grandPost = namedPost('grandPost', grandSpy);
        Grand.prototype.seg = contract(Grand.prototype.seg, { post: [grandPost] });

        class ChainBase extends Grand {
            override seg(x: number): number {
                return x + 2;
            }
        }
        ChainBase.prototype.seg = contract(ChainBase.prototype.seg, { post: [basePost] });

        class DerivedChain extends ChainBase {
            override seg(x: number): number {
                return x + 3;
            }
        }
        const derivedPost = namedPost('derivedPost', () => true);
        DerivedChain.prototype.seg = contract(DerivedChain.prototype.seg, { post: [derivedPost] });

        // bottom-up: the lower level merges first so the upper one accumulates
        mergeClassContracts(ChainBase);
        mergeClassContracts(DerivedChain);

        const instance = new DerivedChain();
        expect(instance.seg(1)).toBe(4);
        expect(grandSpy).toHaveBeenCalled();

        const mergedMeta = getContractMetadata(DerivedChain.prototype.seg);
        expect(mergedMeta?.options.post?.map((entry) => (entry as { name?: string }).name)).toEqual([
            'grandPost',
            'basePost',
            'derivedPost',
        ]);
    });

    it('reports a failing grand-side predicate at index 0 after a deep bottom-up merge', () => {
        class Grand {
            seg(x: number): number {
                return x + 1;
            }
        }
        Grand.prototype.seg = contract(Grand.prototype.seg, {
            post: [namedPost('grandPost', () => false)],
        });

        class DeepBase extends Grand {
            override seg(x: number): number {
                return x + 2;
            }
        }
        DeepBase.prototype.seg = contract(DeepBase.prototype.seg, {
            post: [namedPost('basePost', () => true)],
        });

        class DeepLeaf extends DeepBase {
            override seg(x: number): number {
                return x + 3;
            }
        }
        DeepLeaf.prototype.seg = contract(DeepLeaf.prototype.seg, {
            post: [namedPost('derivedPost', () => true)],
        });

        mergeClassContracts(DeepBase);
        mergeClassContracts(DeepLeaf);

        const caught = catchError(() => new DeepLeaf().seg(1));
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        expect((caught as PostconditionViolationError).conditionName).toBe('grandPost');
        expect((caught as PostconditionViolationError).conditionIndex).toBe(0);
    });

    it('finds the nearest contracted ancestor, walking past an uncontracted override', () => {
        class Low {
            pick(): number {
                return 10;
            }
        }
        Low.prototype.pick = contract(Low.prototype.pick, {
            post: [namedPost<[]>('lowPost', () => false)],
        });

        class PlainMid extends Low {
            override pick(): number {
                return 20; // no contract metadata on this override
            }
        }

        class TopLeaf extends PlainMid {
            override pick(): number {
                return 30;
            }
        }
        TopLeaf.prototype.pick = contract(TopLeaf.prototype.pick, {
            post: [namedPost<[]>('topPost', () => true)],
        });

        mergeClassContracts(TopLeaf);

        const caught = catchError(() => new TopLeaf().pick());
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        expect((caught as PostconditionViolationError).conditionName).toBe('lowPost');
    });

    it('leaves a derived override without metadata untouched', () => {
        class RawBase {
            pick(): number {
                return 1;
            }
        }
        RawBase.prototype.pick = contract(RawBase.prototype.pick, {
            post: [namedPost<[]>('basePost', () => false)],
        });

        class RawDerived extends RawBase {
            override pick(): number {
                return 2; // no contract() call — merge is opt-in on the derived side too
            }
        }

        mergeClassContracts(RawDerived, RawBase);
        expect(new RawDerived().pick()).toBe(2);
    });

    it('skips accessors entirely — no merging, no re-wrapping', () => {
        class AccessorBase {
            get value(): number {
                return 100;
            }
        }
        const baseGetter = Object.getOwnPropertyDescriptor(AccessorBase.prototype, 'value')?.get;
        expect(baseGetter).toBeDefined();
        Object.defineProperty(AccessorBase.prototype, 'value', {
            get: contract(baseGetter as () => number, {
                post: [namedPost<[]>('baseAccessorPost', () => false)],
            }),
            configurable: true,
        });

        class AccessorDerived extends AccessorBase {
            override get value(): number {
                return 42;
            }
        }
        const derivedAccessor = contract(
            Object.getOwnPropertyDescriptor(AccessorDerived.prototype, 'value')?.get as () => number,
            { post: [namedPost<[]>('derivedAccessorPost', () => true)] },
        );
        Object.defineProperty(AccessorDerived.prototype, 'value', {
            get: derivedAccessor,
            configurable: true,
        });

        mergeClassContracts(AccessorDerived, AccessorBase);

        expect(
            Object.getOwnPropertyDescriptor(AccessorDerived.prototype, 'value')?.get,
        ).toBe(derivedAccessor);
        // base post would fail — it must NOT run because accessors are skipped
        expect(new AccessorDerived().value).toBe(42);
    });

    it('does not merge statics unless opted in', () => {
        class StaticBase {
            static work(): number {
                return 50;
            }
        }
        StaticBase.work = contract(StaticBase.work, {
            post: [(r: number) => r > 100],
        });

        class StaticDerived extends StaticBase {
            static override work(): number {
                return 50; // breaks the base post on purpose
            }
        }
        StaticDerived.work = contract(StaticDerived.work, { post: [(r: number) => r > 0] });

        mergeClassContracts(StaticDerived, StaticBase);
        expect(StaticDerived.work()).toBe(50); // statics skipped by default

        mergeClassContracts(StaticDerived, StaticBase, { statics: true });
        const caught = catchError(() => StaticDerived.work());
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        expect((caught as PostconditionViolationError).conditionIndex).toBe(0);
    });

    it('reports the derived static post at index 1 when base passes and derived fails', () => {
        class IndexedBase {
            static work(): number {
                return 50;
            }
        }
        IndexedBase.work = contract(IndexedBase.work, { post: [(r: number) => r > 0] });

        class IndexedDerived extends IndexedBase {
            static override work(): number {
                return 50;
            }
        }
        IndexedDerived.work = contract(IndexedDerived.work, { post: [(r: number) => r > 100] });

        mergeClassContracts(IndexedDerived, IndexedBase, { statics: true });

        const caught = catchError(() => IndexedDerived.work());
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        expect((caught as PostconditionViolationError).conditionIndex).toBe(1);
    });

    it('replaces only own prototype methods — inherited entries are not re-wrapped', () => {
        class OwnBase {
            shared(): number {
                return 1;
            }
        }
        OwnBase.prototype.shared = contract(OwnBase.prototype.shared, {
            post: [namedPost('basePost', () => true)],
        });
        const baseWrapper = OwnBase.prototype.shared;

        class OwnDerived extends OwnBase {}
        mergeClassContracts(OwnDerived, OwnBase);

        expect(Object.getOwnPropertyDescriptor(OwnDerived.prototype, 'shared')).toBeUndefined();
        expect(OwnBase.prototype.shared).toBe(baseWrapper);
    });
});

describe('mergeContractOptions() conditions after merge', () => {
    it('keeps condition indexes of the unioned post stable across merges', () => {
        const basePost = condition<[number, ContractContext<[number], number>]>(() => true, {
            name: 'baseIndexed',
        });
        const derivedPost = condition<[number, ContractContext<[number], number>]>(() => false, {
            name: 'derivedIndexed',
        });
        const merged = mergeContractOptions<[number], number>(
            { post: [basePost] },
            { post: [derivedPost] },
        );
        const caught = catchError(() => contract((n: number) => n, merged)(1));
        expect(caught).toBeInstanceOf(PostconditionViolationError);
        expect((caught as PostconditionViolationError).conditionIndex).toBe(1);
    });

    it('composition of disjunction survives a double merge (base + derived + grandchild)', () => {
        const p = condition<[number]>(() => true, { name: 'p' });
        const q = condition<[number]>(() => true, { name: 'q' });
        const r = condition<[number]>(() => false, { name: 'r' });
        const level1 = mergeContractOptions<[number], number>({ pre: [p] }, undefined);
        const level2 = mergeContractOptions<[number], number>(level1, { pre: [q] });
        const level3 = mergeContractOptions<[number], number>(level2, { pre: [r] });
        // p and q sides both pass, r side fails but disjunction only needs one side
        expect(() => contract((n: number) => n, level3)(1)).not.toThrow();
        expect(level3?.pre).toHaveLength(1);
    });

    it('exposes the composite failure tree via cause on a merged disjunction', () => {
        const baseFail = condition<[number]>(() => false, { name: 'baseLeaf' });
        const derivedFail = condition<[number]>(() => false, { name: 'derivedLeaf' });
        const merged = mergeContractOptions<[number], number>(
            { pre: [baseFail] },
            { pre: [derivedFail] },
        );
        const caught = catchError(() => contract((n: number) => n, merged)(1));
        const error = caught as PreconditionViolationError;
        expect(error.cause).toMatchObject({ operator: 'any', index: -1 });
        const components = (error.cause as { components: { conditionName: string; operator: string }[] })
            .components;
        expect(components.map((c) => c.conditionName)).toEqual(['all(baseLeaf)', 'all(derivedLeaf)']);
    });

    it('unions onError with base first and keeps indexes after a merge with three entries', () => {
        const first = condition<[unknown, ContractContext<[number], number>]>(() => true, {
            name: 'first',
        });
        const second = condition<[unknown, ContractContext<[number], number>]>(() => true, {
            name: 'second',
        });
        const third = condition<[unknown, ContractContext<[number], number>]>(() => false, {
            name: 'third',
        });
        const merged = mergeContractOptions<[number], number>(
            { onError: [first, second] },
            { onError: [third] },
        );
        const failing = contract<[number], number>((_n: number): number => {
            throw new Error('boom');
        }, merged);
        const caught = catchError(() => failing(0));
        expect((caught as OnErrorViolationError).conditionIndex).toBe(2);
        expect((caught as OnErrorViolationError).conditionName).toBe('third');
    });
});

describe('any()/all() building blocks used by merges', () => {
    it('any(all(a), all(b)) passes when exactly one side is fully true', () => {
        const a = condition<[number]>((n) => n > 0, { name: 'a' });
        const b = condition<[number]>((n) => n > 10, { name: 'b' });
        const disjunction = any(all(a), all(b));
        expect(disjunction.check(5)).toBe(true);
        expect(disjunction.check(-5)).toBe(false);
    });
});
