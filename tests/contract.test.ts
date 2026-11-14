import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord, ContractContext, OldValues } from '../src/index.js';
import {
    AssertionViolationError,
    all,
    any,
    assert,
    ContractViolationError,
    condition,
    configure,
    contract,
    OnErrorViolationError,
    PostconditionViolationError,
    PreconditionViolationError,
    resetConfig,
    withConfig,
} from '../src/index.js';

// the repo compiles without ambient node types, so reach console structurally
const testConsole = (
    globalThis as unknown as {
        console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
    }
).console;

const catchError = (run: () => unknown): unknown => {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected the function to throw');
};

function divide(a: number, b: number): number {
    return a / b;
}

describe('contract()', () => {
    beforeEach(() => {
        resetConfig();
    });

    afterEach(() => {
        resetConfig();
        vi.restoreAllMocks();
    });

    describe('preconditions', () => {
        it('passes when the precondition holds', () => {
            const safeDivide = contract(divide, { pre: [(_a: number, b: number) => b !== 0] });
            expect(safeDivide(10, 2)).toBe(5);
        });

        it('throws PreconditionViolationError when the precondition fails', () => {
            let calls = 0;
            const countingDivide = (a: number, b: number): number => {
                calls += 1;
                return divide(a, b);
            };
            const safeDivide = contract(countingDivide, {
                pre: [(_a: number, b: number) => b !== 0],
            });

            const caught = catchError(() => safeDivide(10, 0));

            expect(caught).toBeInstanceOf(PreconditionViolationError);
            expect(caught).toBeInstanceOf(ContractViolationError);
            const error = caught as PreconditionViolationError;
            expect(error.kind).toBe('precondition');
            expect(error.conditionIndex).toBe(0);
            expect(error.mode).toBe('strict');
            expect(error.functionName).toBe('countingDivide');
            expect(error.message).toContain('countingDivide');
            expect(calls).toBe(0);
        });

        it('reports the index of the failing precondition in declaration order', () => {
            const wrapped = contract(divide, {
                pre: [() => true, () => false, () => false],
            });

            const caught = catchError(() => wrapped(10, 2));

            expect(caught).toBeInstanceOf(PreconditionViolationError);
            expect((caught as PreconditionViolationError).conditionIndex).toBe(1);
        });

        it('surfaces the named condition in details and in the message', () => {
            const named = condition<[number, number]>((_a, b) => b !== 0, {
                name: 'nonZeroDivisor',
                message: 'divisor must not be zero',
            });
            const safeDivide = contract(divide, { pre: [named] });

            const caught = catchError(() => safeDivide(10, 0));

            expect(caught).toBeInstanceOf(PreconditionViolationError);
            const error = caught as PreconditionViolationError;
            expect(error.conditionName).toBe('nonZeroDivisor');
            expect(error.message).toContain('nonZeroDivisor');
        });

        it('leaves conditionName undefined for bare predicates', () => {
            const safeDivide = contract(divide, { pre: [() => false] });

            const caught = catchError(() => safeDivide(10, 2));

            expect(caught).toBeInstanceOf(PreconditionViolationError);
            expect((caught as PreconditionViolationError).conditionName).toBeUndefined();
        });

        it('evaluates composite all() conditions and reports the failing child', () => {
            const positive = condition<[number]>((n) => n > 0, { name: 'positive' });
            const small = condition<[number]>((n) => n < 100, { name: 'small' });
            const wrapped = contract((n: number) => n * 2, { pre: [all(positive, small)] });

            expect(wrapped(5)).toBe(10);

            const caught = catchError(() => wrapped(-5));
            expect(caught).toBeInstanceOf(PreconditionViolationError);
            const error = caught as PreconditionViolationError;
            expect(error.conditionName).toBe('all(positive, small)');
            expect(error.cause).toMatchObject({
                operator: 'all',
                index: 0,
                conditionName: 'positive',
            });
        });

        it('evaluates composite any() conditions and reports all children on failure', () => {
            const positive = condition<[number]>((n) => n > 0, { name: 'pos' });
            const even = condition<[number]>((n) => n % 2 === 0, { name: 'even' });
            const wrapped = contract((n: number) => n * 2, { pre: [any(positive, even)] });

            expect(wrapped(-4)).toBe(-8);

            const caught = catchError(() => wrapped(-3));
            expect(caught).toBeInstanceOf(PreconditionViolationError);
            const error = caught as PreconditionViolationError;
            expect(error.cause).toMatchObject({ operator: 'any', index: -1 });
        });
    });

    describe('postconditions', () => {
        it('throws PostconditionViolationError when the postcondition fails', () => {
            const wrapped = contract(divide, { post: [(result) => result > 100] });

            const caught = catchError(() => wrapped(10, 2));

            expect(caught).toBeInstanceOf(PostconditionViolationError);
            expect(caught).toBeInstanceOf(ContractViolationError);
            const error = caught as PostconditionViolationError;
            expect(error.kind).toBe('postcondition');
            expect(error.conditionIndex).toBe(0);
            expect(error.message).toContain('divide');
        });

        it('reports the index of the failing postcondition in declaration order', () => {
            const wrapped = contract(divide, {
                post: [() => true, () => false, () => true],
            });

            const caught = catchError(() => wrapped(10, 2));

            expect(caught).toBeInstanceOf(PostconditionViolationError);
            expect((caught as PostconditionViolationError).conditionIndex).toBe(1);
        });

        it('runs the wrapped function even when a postcondition then fails', () => {
            const fnSpy = vi.fn(divide);
            const wrapped = contract(fnSpy, { post: [() => false] });

            catchError(() => wrapped(10, 2));

            expect(fnSpy).toHaveBeenCalledTimes(1);
        });

        it('hands the resolved result and the full context to the predicate', () => {
            let seen: ContractContext<[number, number], number> | undefined;
            const wrapped = contract(divide, {
                post: [
                    (_result, ctx) => {
                        seen = ctx;
                        return true;
                    },
                ],
            });

            expect(wrapped(10, 2)).toBe(5);

            expect(seen).toBeDefined();
            const ctx = seen as ContractContext<[number, number], number>;
            expect(ctx.result).toBe(5);
            expect(ctx.args).toEqual([10, 2]);
            expect(ctx.mode).toBe('strict');
            expect(ctx.contract).toBe('divide');
            expect(ctx.function).toBe('divide');
            expect(ctx.self).toBeUndefined();
            expect(ctx.error).toBeUndefined();
            expect(ctx.old).toBeUndefined();
        });

        it('uses the configured contract name in the context', () => {
            let seen: ContractContext<[number, number], number> | undefined;
            const wrapped = contract(divide, {
                name: 'SafeDivide',
                post: [
                    (_result, ctx) => {
                        seen = ctx;
                        return true;
                    },
                ],
            });

            wrapped(10, 2);

            expect(seen?.contract).toBe('SafeDivide');
            expect(seen?.function).toBe('divide');
        });

        it('does not evaluate postconditions when the function throws', () => {
            const boom = new Error('boom');
            const postSpy = vi.fn(() => true);
            const wrapped = contract(
                () => {
                    throw boom;
                },
                { post: [postSpy] },
            );

            expect(() => wrapped()).toThrow('boom');
            expect(postSpy).not.toHaveBeenCalled();
        });
    });

    describe('old values', () => {
        interface Account {
            balance: number;
        }

        function deposit(account: Account, amount: number): number {
            account.balance += amount;
            return account.balance;
        }

        it('captures arguments by parameter name in the array form', () => {
            let oldSeen: OldValues | undefined;
            const wrapped = contract(deposit, {
                old: ['account'],
                post: [
                    (_result, ctx) => {
                        oldSeen = ctx.old;
                        return true;
                    },
                ],
            });

            const account = { balance: 100 };
            const result = wrapped(account, 50);

            expect(result).toBe(150);
            expect(account.balance).toBe(150);
            expect(oldSeen?.['account']).toEqual({ balance: 100 });
        });

        it('captures via the function form, called with the raw args', () => {
            const captureSpy = vi.fn((args: readonly unknown[]) => ({ amount: args[1] }));
            let oldSeen: OldValues | undefined;
            const wrapped = contract(deposit, {
                old: captureSpy,
                post: [
                    (_result, ctx) => {
                        oldSeen = ctx.old;
                        return true;
                    },
                ],
            });

            wrapped({ balance: 100 }, 50);

            expect(captureSpy).toHaveBeenCalledTimes(1);
            expect(oldSeen).toEqual({ amount: 50 });
        });

        it('captures nothing when the contract has no postconditions', () => {
            const captureSpy = vi.fn((_args: readonly unknown[]): Record<string, unknown> => {
                throw new Error('capture must not run');
            });
            const wrapped = contract(divide, { old: captureSpy });

            expect(() => wrapped(10, 2)).not.toThrow();
            expect(captureSpy).not.toHaveBeenCalled();
        });

        it('snapshots primitive arguments instead of referencing them', () => {
            let oldSeen: OldValues | undefined;
            const bump = (total: number, delta: number): number => total + delta;
            const wrapped = contract(bump, {
                old: ['total'],
                post: [
                    (_result, ctx) => {
                        oldSeen = ctx.old;
                        return true;
                    },
                ],
            });

            const result = wrapped(41, 2);

            expect(result).toBe(43);
            expect(oldSeen?.['total']).toBe(41);
        });

        it('does not attempt any capture when the mode is off', () => {
            configure({ mode: 'off' });
            const captureSpy = vi.fn((_args: readonly unknown[]): Record<string, unknown> => {
                throw new Error('capture must not run');
            });
            const preFail = vi.fn(() => false);
            const postFail = vi.fn(() => false);
            const wrapped = contract(divide, { old: captureSpy, pre: [preFail], post: [postFail] });

            expect(wrapped(10, 2)).toBe(5);
            expect(captureSpy).not.toHaveBeenCalled();
            expect(preFail).not.toHaveBeenCalled();
            expect(postFail).not.toHaveBeenCalled();
        });
    });

    describe('this binding', () => {
        it('honours the call-site this value and exposes it as context.self', () => {
            class Wallet {
                balance = 100;
                deposit(amount: number): number {
                    this.balance += amount;
                    return this.balance;
                }
            }

            const wallet = new Wallet();
            let selfSeen: unknown;
            wallet.deposit = contract(wallet.deposit, {
                post: [
                    (_result, ctx) => {
                        selfSeen = ctx.self;
                        return true;
                    },
                ],
            });

            const result = wallet.deposit(20);

            expect(result).toBe(120);
            expect(wallet.balance).toBe(120);
            expect(selfSeen).toBe(wallet);
        });
    });

    describe('wrapper signature', () => {
        it('preserves fn.length and fn.name', () => {
            const wrapped = contract(function sum(a: number, b: number, c: number): number {
                return a + b + c;
            });

            expect(wrapped.length).toBe(3);
            expect(wrapped.name).toBe('sum');
        });

        it("names anonymous wrappers 'anonymous'", () => {
            const wrapped = contract((a: number) => a * 2);

            expect(wrapped.length).toBe(1);
            expect(wrapped.name).toBe('anonymous');
        });
    });

    describe('off and silent modes', () => {
        it('in off mode predicates are not called and the result is the raw one', () => {
            configure({ mode: 'off' });
            const preFail = vi.fn(() => false);
            const postFail = vi.fn(() => false);
            const wrapped = contract(divide, { pre: [preFail], post: [postFail] });

            expect(wrapped(10, 2)).toBe(5);
            expect(preFail).not.toHaveBeenCalled();
            expect(postFail).not.toHaveBeenCalled();
        });

        it('in off mode a thenable from the wrapped function is returned untouched', () => {
            configure({ mode: 'off' });
            const promise = Promise.resolve(42);
            const fn = () => promise;
            const preFail = vi.fn(() => false);
            const wrapped = contract(fn, { pre: [preFail], post: [() => false] });

            expect(wrapped()).toBe(promise);
            expect(preFail).not.toHaveBeenCalled();
        });

        it('in silent mode predicates are not called and the result is the raw one', () => {
            configure({ mode: 'silent' });
            const preFail = vi.fn(() => false);
            const postFail = vi.fn(() => false);
            const wrapped = contract(divide, { pre: [preFail], post: [postFail] });

            expect(wrapped(10, 2)).toBe(5);
            expect(preFail).not.toHaveBeenCalled();
            expect(postFail).not.toHaveBeenCalled();
        });
    });

    describe('warn mode', () => {
        it('does not throw, calls console.warn and still runs the function', () => {
            configure({ mode: 'warn' });
            const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
            const fnSpy = vi.fn(divide);
            const wrapped = contract(fnSpy, { pre: [() => false] });

            expect(wrapped(10, 2)).toBe(5);
            expect(fnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(String(warnSpy.mock.calls[0]?.[0])).toContain('precondition');
        });

        it('does not throw, reports to the configured onViolation handler', () => {
            const onViolation = vi.fn();
            configure({ mode: 'warn', onViolation });
            const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
            const wrapped = contract(divide, { pre: [() => false] });

            expect(wrapped(10, 2)).toBe(5);
            expect(onViolation).toHaveBeenCalledTimes(1);
            expect(onViolation.mock.calls[0]?.[0]).toBeInstanceOf(PreconditionViolationError);
            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('continues past failing postconditions', () => {
            configure({ mode: 'warn' });
            const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
            const wrapped = contract(divide, { post: [() => false] });

            expect(wrapped(10, 2)).toBe(5);
            expect(warnSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('audit mode', () => {
        it('does not throw and delivers an audit record to onAudit', () => {
            let record: AuditRecord | undefined;
            configure({
                mode: 'audit',
                onAudit: (rec) => {
                    record = rec;
                },
            });
            const wrapped = contract(divide, { name: 'DivideContract', pre: [() => false] });

            expect(wrapped(10, 2)).toBe(5);

            expect(record).toBeDefined();
            const rec = record as AuditRecord;
            expect(rec.kind).toBe('precondition');
            expect(rec.mode).toBe('audit');
            expect(rec.conditionIndex).toBe(0);
            expect(rec.contractName).toBe('DivideContract');
            expect(rec.functionName).toBe('divide');
            expect(typeof rec.message).toBe('string');
            expect(typeof rec.timestamp).toBe('number');
        });

        it('also notifies onViolation with the violation error', () => {
            const onViolation = vi.fn();
            configure({ mode: 'audit', onAudit: () => undefined, onViolation });
            const wrapped = contract(divide, { pre: [() => false] });

            expect(wrapped(10, 2)).toBe(5);
            expect(onViolation).toHaveBeenCalledTimes(1);
            expect(onViolation.mock.calls[0]?.[0]).toBeInstanceOf(PreconditionViolationError);
        });

        it('does not throw when no handlers are configured', () => {
            configure({ mode: 'audit' });
            const wrapped = contract(divide, { pre: [() => false], post: [() => false] });

            expect(wrapped(10, 2)).toBe(5);
        });

        it('reports failing postconditions as postcondition audit records', () => {
            let record: AuditRecord | undefined;
            configure({
                mode: 'audit',
                onAudit: (rec) => {
                    record = rec;
                },
            });
            const wrapped = contract(divide, { post: [() => false] });

            expect(wrapped(10, 2)).toBe(5);
            expect(record?.kind).toBe('postcondition');
        });
    });

    describe('disabled categories', () => {
        it('skips preconditions but still checks postconditions', () => {
            const preFail = vi.fn(() => false);
            configure({ mode: 'strict', disabled: ['precondition'] });

            const preOnly = contract(divide, { pre: [preFail] });
            expect(preOnly(10, 2)).toBe(5);
            expect(preFail).not.toHaveBeenCalled();

            const postFail = vi.fn(() => false);
            const withPost = contract(divide, { pre: [preFail], post: [postFail] });
            const caught = catchError(() => withPost(10, 2));
            expect(caught).toBeInstanceOf(PostconditionViolationError);
        });

        it('skips postconditions but still checks preconditions', () => {
            const postFail = vi.fn(() => false);
            configure({ mode: 'strict', disabled: ['postcondition'] });

            const wrapped = contract(divide, { pre: [() => true], post: [postFail] });

            expect(wrapped(10, 2)).toBe(5);
            expect(postFail).not.toHaveBeenCalled();
        });
    });

    describe('per-contract mode', () => {
        it('contract(.., { mode: "off" }) wins over a global strict mode', () => {
            configure({ mode: 'strict' });
            const preFail = vi.fn(() => false);
            const wrapped = contract(divide, { mode: 'off', pre: [preFail] });

            expect(wrapped(10, 2)).toBe(5);
            expect(preFail).not.toHaveBeenCalled();
        });

        it('contract(.., { mode: "warn" }) wins over a global strict mode', () => {
            configure({ mode: 'strict' });
            const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
            const wrapped = contract(divide, { mode: 'warn', pre: [() => false] });

            expect(wrapped(10, 2)).toBe(5);
            expect(warnSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('withConfig()', () => {
        it('scopes mode over the global configuration and restores it afterwards', () => {
            configure({ mode: 'strict' });
            const preFail = vi.fn(() => false);
            const wrapped = contract(divide, { pre: [preFail] });

            expect(() => wrapped(10, 2)).toThrow(PreconditionViolationError);
            expect(preFail).toHaveBeenCalledTimes(1);

            withConfig({ mode: 'silent' }, () => {
                expect(wrapped(10, 2)).toBe(5);
            });
            expect(preFail).toHaveBeenCalledTimes(1); // predicate not evaluated in the silent scope

            expect(() => wrapped(10, 2)).toThrow(PreconditionViolationError);
            expect(preFail).toHaveBeenCalledTimes(2);
        });

        it('lets the inner scope win over the outer scope', () => {
            const onViolation = vi.fn();
            const wrapped = contract(divide, { pre: [() => false] });

            withConfig({ mode: 'warn', onViolation }, () => {
                withConfig({ mode: 'strict' }, () => {
                    expect(() => wrapped(10, 2)).toThrow(PreconditionViolationError);
                });
                expect(wrapped(10, 2)).toBe(5);
                expect(onViolation).toHaveBeenCalledTimes(1);
            });
        });

        it('lets the inner handler win over the outer handler', () => {
            const outer = vi.fn();
            const inner = vi.fn();
            const wrapped = contract(divide, { pre: [() => false] });

            withConfig({ mode: 'warn', onViolation: outer }, () => {
                withConfig({ onViolation: inner }, () => {
                    wrapped(10, 2);
                });
            });

            expect(inner).toHaveBeenCalledTimes(1);
            expect(outer).not.toHaveBeenCalled();
        });

        it('delivers audit records inside the scope without global handlers', () => {
            const onAudit = vi.fn();
            const wrapped = contract(divide, { pre: [() => false] });

            withConfig({ mode: 'audit', onAudit }, () => {
                expect(wrapped(10, 2)).toBe(5);
            });

            expect(onAudit).toHaveBeenCalledTimes(1);
            expect(onAudit.mock.calls[0]?.[0]).toMatchObject({
                kind: 'precondition',
                mode: 'audit',
            });
        });
    });

    describe('captureStack option', () => {
        it('omits the stack trace when captureStack is false', () => {
            const wrapped = contract(divide, { pre: [() => false], captureStack: false });

            const caught = catchError(() => wrapped(10, 2));

            expect(caught).toBeInstanceOf(PreconditionViolationError);
            expect((caught as Error).stack).toBeUndefined();
        });

        it('captures a stack trace by default', () => {
            const wrapped = contract(divide, { pre: [() => false] });

            const caught = catchError(() => wrapped(10, 2));

            expect(caught).toBeInstanceOf(PreconditionViolationError);
            expect(typeof (caught as Error).stack).toBe('string');
        });
    });

    describe('message precedence', () => {
        it('prefers the named condition message over options.message', () => {
            const named = condition<[number, number]>((_a, b) => b !== 0, {
                name: 'nonZeroDivisor',
                message: 'divisor must not be zero',
            });
            const wrapped = contract(divide, {
                pre: [named],
                message: 'contract-level fallback',
            });

            const caught = catchError(() => wrapped(10, 0));

            expect((caught as Error).message).toContain('divisor must not be zero');
            expect((caught as Error).message).not.toContain('contract-level fallback');
        });

        it('falls back to options.message when the condition carries none', () => {
            const wrapped = contract(divide, {
                pre: [() => false],
                message: 'contract-level fallback',
            });

            const caught = catchError(() => wrapped(10, 2));

            expect((caught as Error).message).toContain('contract-level fallback');
        });

        it('composes a default message from the label, function and condition index', () => {
            const wrapped = contract(divide, { pre: [() => false] });

            const caught = catchError(() => wrapped(10, 2));
            const message = (caught as Error).message;

            expect(message).toContain('Precondition violated');
            expect(message).toContain('divide');
            expect(message).toContain('#0');
        });
    });

    describe('on-error checks', () => {
        const boom = new Error('boom');

        it('lets the original error fly when no on-error conditions are configured', () => {
            const wrapped = contract(() => {
                throw boom;
            });

            const caught = catchError(() => wrapped());

            expect(caught).toBe(boom);
        });

        it('lets the original error fly when the on-error conditions pass', () => {
            const wrapped = contract(
                () => {
                    throw boom;
                },
                { onError: [(error) => error instanceof Error] },
            );

            const caught = catchError(() => wrapped());

            expect(caught).toBe(boom);
        });

        it('throws OnErrorViolationError when an on-error condition fails', () => {
            const wrapped = contract(
                () => {
                    throw boom;
                },
                { onError: [() => false] },
            );

            const caught = catchError(() => wrapped());

            expect(caught).toBeInstanceOf(OnErrorViolationError);
            const error = caught as OnErrorViolationError;
            expect(error.kind).toBe('on-error');
            expect(error.conditionIndex).toBe(0);
            expect(error).not.toBe(boom);
        });
    });

    describe('assert() inside a contract', () => {
        it('throws AssertionViolationError for falsy conditions', () => {
            const wrapped = contract((n: number) => {
                assert(n > 0, 'n must be positive');
                return n;
            });

            const caught = catchError(() => wrapped(-1));

            expect(caught).toBeInstanceOf(AssertionViolationError);
            expect(caught).toBeInstanceOf(ContractViolationError);
            const error = caught as AssertionViolationError;
            expect(error.kind).toBe('assertion');
            expect(error.message).toContain('n must be positive');
            expect(wrapped(3)).toBe(3);
        });
    });

    describe('nested contracts', () => {
        it('lets the inner violation fly with its own condition index', () => {
            const inner = contract(divide, { pre: [() => true, () => false] });
            const outer = contract(inner);

            const caught = catchError(() => outer(10, 2));

            expect(caught).toBeInstanceOf(PreconditionViolationError);
            expect((caught as PreconditionViolationError).conditionIndex).toBe(1);
        });

        it('runs the outer contract around a passing inner call', () => {
            const postSpy = vi.fn(() => true);
            const inner = contract(divide, { pre: [() => true, () => true] });
            const outer = contract(inner, { post: [postSpy] });

            expect(outer(10, 2)).toBe(5);
            expect(postSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('contract without options', () => {
        it('passes calls through untouched', () => {
            const wrapped = contract(divide);

            expect(wrapped(10, 2)).toBe(5);
        });
    });
});
