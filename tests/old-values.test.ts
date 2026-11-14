import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    captureValue,
    contract,
    isReferenceCapture,
    snapshotArgs,
} from '../src/index.js';
import type { ContractContext, OldValues } from '../src/index.js';

// the repo compiles without ambient node types, so reach console structurally
const testConsole = (globalThis as unknown as {
    console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
}).console;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('captureValue — primitives pass through by identity', () => {
    it('numbers, strings, booleans, null, undefined, symbols are returned as-is', () => {
        expect(captureValue(42)).toBe(42);
        expect(captureValue('text')).toBe('text');
        expect(captureValue(true)).toBe(true);
        expect(captureValue(null)).toBeNull();
        expect(captureValue(undefined)).toBeUndefined();
        const sym = Symbol('marker');
        expect(captureValue(sym)).toBe(sym);
    });

    it('NaN and bigint pass through untouched', () => {
        expect(captureValue(Number.NaN)).toBe(captureValue(Number.NaN));
        expect(Number.isNaN(captureValue(Number.NaN) as number)).toBe(true);
        expect(captureValue(10n)).toBe(10n);
    });
});

describe('captureValue — structuredClone deep copy', () => {
    it('plain objects are deep-copied; source mutation is invisible to the snapshot', () => {
        const src = { nested: { count: 1 } };
        const cap = captureValue(src) as typeof src;
        src.nested.count = 999;
        expect(cap.nested.count).toBe(1);
        expect(cap).not.toBe(src);
        expect(cap.nested).not.toBe(src.nested);
    });

    it('Arrays are cloned, not aliased', () => {
        const src = [1, 2, { tag: 'a' }];
        const cap = captureValue(src) as unknown[];
        expect(cap).not.toBe(src);
        expect(cap[2]).not.toBe(src[2]);
        expect(cap).toEqual(src);
    });

    it('Maps are copied (new instance, snapshot of entries)', () => {
        const src = new Map<string, number>([['a', 1]]);
        const cap = captureValue(src) as Map<string, number>;
        src.set('a', 999);
        src.set('b', 2);
        expect(cap).not.toBe(src);
        expect(cap.get('a')).toBe(1);
        expect(cap.has('b')).toBe(false);
    });

    it('Sets are copied (new instance, snapshot of members)', () => {
        const src = new Set([1, 2, 3]);
        const cap = captureValue(src) as Set<number>;
        src.add(4);
        expect(cap).not.toBe(src);
        expect([...cap]).toEqual([1, 2, 3]);
    });

    it('Date instances are cloned with the same instant', () => {
        const src = new Date('2021-05-01T00:00:00.000Z');
        const cap = captureValue(src) as Date;
        expect(cap).toBeInstanceOf(Date);
        expect(cap).not.toBe(src);
        expect(cap.getTime()).toBe(src.getTime());
        expect(isReferenceCapture(cap)).toBe(false);
    });

    it('circular structures capture without throwing (structuredClone handles cycles)', () => {
        const obj: Record<string, unknown> = { name: 'root' };
        obj['self'] = obj;
        expect(() => captureValue(obj)).not.toThrow();
        const cap = captureValue(obj) as Record<string, unknown>;
        expect(cap).not.toBe(obj);
        expect(cap['self']).toBe(cap);
        expect(isReferenceCapture(cap)).toBe(false);
    });
});

describe('captureValue — uncloneable graphs degrade gracefully', () => {
    it('functions are kept by reference and flagged as reference captures', () => {
        const fn = (): number => 1;
        const cap = captureValue(fn);
        expect(cap).toBe(fn);
        expect(isReferenceCapture(cap)).toBe(true);
    });

    it('class instances carrying an uncloneable member fall back to a live reference, flagged', () => {
        class Account {
            public balance: number = 100;
            // a function member makes structuredClone bail on every runtime,
            // forcing the shallow/reference fallback path
            public describe: () => string = () => `balance=${this.balance}`;
        }
        const acc = new Account();
        const cap = captureValue(acc) as Account;
        expect(cap).toBe(acc);
        expect(isReferenceCapture(cap)).toBe(true);
    });

    it('plain objects with an uncloneable member degrade to a shallow copy, not a live reference', () => {
        const src = { balance: 100, describe: () => 'x' };
        const cap = captureValue(src) as typeof src;
        expect(cap).not.toBe(src);
        expect(cap.balance).toBe(100);
        expect(isReferenceCapture(cap)).toBe(false);
    });

    it('isReferenceCapture discriminates clones from live references', () => {
        expect(isReferenceCapture(captureValue({}))).toBe(false);
        expect(isReferenceCapture(captureValue([]))).toBe(false);
        expect(isReferenceCapture(captureValue(() => 1))).toBe(true);
        expect(isReferenceCapture(42)).toBe(false);
        expect(isReferenceCapture(null)).toBe(false);
        expect(isReferenceCapture('plain')).toBe(false);
        expect(isReferenceCapture({ plain: true })).toBe(false); // never captured
    });
});

describe('snapshotArgs — array form, name introspection', () => {
    const deposit = (account: { balance: number }, amount: number): number => {
        account.balance += amount;
        return account.balance;
    };

    it('captures arguments by parameter name', () => {
        const account = { balance: 100 };
        const snap = snapshotArgs(deposit, [account, 50], ['account', 'amount']);
        expect(snap).toEqual({ account: { balance: 100 }, amount: 50 });
        expect(snap['account']).not.toBe(account);
    });

    it('single-param arrow without parens resolves via its bare identifier', () => {
        // vitest/esbuild normalize printed sources, so build a genuine bare-arrow via Function
        const make = new Function('return x => x * 2') as () => (x: number) => number;
        const double = make();
        expect(Function.prototype.toString.call(double)).toBe('x => x * 2');
        const snap = snapshotArgs(double, [21], ['x']);
        expect(snap).toEqual({ x: 21 });
    });

    it('single-param arrow with parens also resolves', () => {
        const double = (x: number): number => x * 2;
        const snap = snapshotArgs(double, [13], ['x']);
        expect(snap).toEqual({ x: 13 });
    });

    it('rest parameter captures the whole tail as an array', () => {
        const sum = (first: number, ...rest: number[]): number =>
            rest.reduce((acc, n) => acc + n, first);
        const snap = snapshotArgs(sum, [1, 2, 3, 4], ['first', 'rest']);
        expect(snap['first']).toBe(1);
        expect(snap['rest']).toEqual([2, 3, 4]);
    });

    it('rest parameter with an empty tail captures an empty array', () => {
        const sum = (first: number, ...rest: number[]): number => first + rest.length;
        const snap = snapshotArgs(sum, [7], ['rest']);
        expect(snap['rest']).toEqual([]);
    });

    it('multi-line signatures resolve names correctly', () => {
        const combine = (
            alpha: string,
            beta: number,
        ): string => `${alpha}-${beta}`;
        const snap = snapshotArgs(combine, ['x', 9], ['alpha', 'beta']);
        expect(snap).toEqual({ alpha: 'x', beta: 9 });
    });

    it('unknown parameter name is skipped with a console.warn', () => {
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
        function uniqueWarnTarget(payloadA: number, payloadB: number): number {
            return payloadA + payloadB;
        }
        const snap = snapshotArgs(uniqueWarnTarget, [1, 2], ['nope']);
        expect('nope' in snap).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(String(warnSpy.mock.calls[0]?.[0])).toContain('nope');
    });

    it('destructured parameter slots carry no usable name and are skipped', () => {
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
        const destructured = ({ alpha }: { alpha: number }, beta: number): number => alpha + beta;
        const snap = snapshotArgs(destructured, [{ alpha: 1 }, 2], ['alpha', 'beta']);
        expect('alpha' in snap).toBe(false);
        expect(snap['beta']).toBe(2);
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('argument not passed for an existing parameter is skipped with a warn', () => {
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
        const optionalSecond = (first: number, second?: number): number => first + (second ?? 0);
        const snap = snapshotArgs(optionalSecond, [10], ['first', 'second']);
        expect(snap['first']).toBe(10);
        expect('second' in snap).toBe(false);
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('returned snapshot is a fresh record per call', () => {
        const one = snapshotArgs(deposit, [{ balance: 1 }, 1], ['amount']);
        const two = snapshotArgs(deposit, [{ balance: 1 }, 1], ['amount']);
        expect(one).not.toBe(two);
        expect(one).toEqual(two);
    });
});

describe('snapshotArgs — function form', () => {
    const deposit = (account: { balance: number }, amount: number): number => {
        account.balance += amount;
        return account.balance;
    };

    it('capture callback receives the raw args array', () => {
        const spec = vi.fn((args: readonly unknown[]) => ({ seen: args.length }));
        const account = { balance: 100 };
        const snap = snapshotArgs(deposit, [account, 25], spec);
        expect(spec).toHaveBeenCalledTimes(1);
        expect(spec).toHaveBeenCalledWith([account, 25]);
        expect(snap).toEqual({ seen: 2 });
    });

    it('values are used exactly as returned — no implicit cloning', () => {
        const account = { balance: 100 };
        const snap = snapshotArgs(deposit, [account], (args) => ({ account: args[0] }));
        expect(snap['account']).toBe(account);
    });

    it('the returned record is shallow-copied, not aliased', () => {
        const produced = { keep: 'me' };
        const snap = snapshotArgs(deposit, [{ balance: 0 }], () => produced);
        expect(snap).toEqual(produced);
        expect(snap).not.toBe(produced);
    });

    it('returning a non-plain object (or non-record) throws a TypeError', () => {
        expect(() => snapshotArgs(deposit, [], (() => null) as never)).toThrow(TypeError);
        expect(() => snapshotArgs(deposit, [], (() => []) as never)).toThrow(TypeError);
        expect(() => snapshotArgs(deposit, [], (() => 42) as never)).toThrow(TypeError);
        expect(() => snapshotArgs(deposit, [], (() => 'nope') as never)).toThrow(TypeError);
        expect(() => snapshotArgs(deposit, [], (() => undefined) as never)).toThrow(TypeError);
    });

    it('an exception thrown by the capture callback propagates untouched', () => {
        const boom = new Error('capture blew up');
        expect(() =>
            snapshotArgs(deposit, [], () => {
                throw boom;
            }),
        ).toThrow(boom);
    });
});

describe('old values — e2e through contract()', () => {
    interface Account {
        balance: number;
    }

    it('snapshot is visible in post and reflects pre-call state', () => {
        let oldSeen: OldValues | undefined;
        const target = (account: Account, amount: number): number => {
            account.balance += amount;
            return account.balance;
        };
        const wrapped = contract(target, {
            name: 'accountFlow',
            old: ['account'],
            post: [
                (_result: number, ctx: ContractContext<[Account, number], number>): boolean => {
                    oldSeen = ctx.old;
                    return true;
                },
            ],
        });

        const account: Account = { balance: 100 };
        expect(wrapped(account, 50)).toBe(150);

        expect(account.balance).toBe(150);
        expect(oldSeen?.['account']).toEqual({ balance: 100 });
        // deep clone, not a live handle
        expect(oldSeen?.['account']).not.toBe(account);
    });
});
