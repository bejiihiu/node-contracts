import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '../src/index.js';
import {
    ContractViolationError,
    captureValue,
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

// the repo compiles without ambient node types, so reach timers structurally
const scheduleTimeout = (
    globalThis as unknown as {
        setTimeout: (callback: () => void, ms: number) => unknown;
    }
).setTimeout;
const tick = (ms = 1): Promise<void> =>
    new Promise<void>((resolve) => {
        scheduleTimeout(resolve, ms);
    });

// custom thenables on purpose — this file tests non-native-promise objects
const resolvingThenable = (value: number): PromiseLike<number> => {
    const thenable = {
        // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable, not a promise
        then(onfulfilled?: ((value: number) => unknown) | null): void {
            onfulfilled?.(value);
        },
    };
    return thenable as unknown as PromiseLike<number>;
};

const rejectingThenable = (reason: unknown): PromiseLike<number> => {
    const thenable = {
        // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable, not a promise
        then(_onfulfilled: unknown, onrejected?: ((reason: unknown) => unknown) | null): void {
            onrejected?.(reason);
        },
    };
    return thenable as unknown as PromiseLike<number>;
};

describe('contract() — async path', () => {
    beforeEach(() => {
        resetConfig();
    });

    afterEach(() => {
        resetConfig();
        vi.restoreAllMocks();
    });

    describe('preconditions', () => {
        it('resolves with the value when a sync precondition passes', async () => {
            const wrapped = contract(async (a: number, b: number) => a / b, {
                pre: [(_a: number, b: number) => b !== 0],
            });

            await expect(wrapped(10, 2)).resolves.toBe(5);
        });

        it('throws PreconditionViolationError synchronously for a failing sync precondition', () => {
            // sync predicates are evaluated before fn is invoked, no matter how
            // async fn is — the throw is synchronous, not a rejection
            let calls = 0;
            async function impl(): Promise<string> {
                calls += 1;
                return 'ok';
            }
            const wrapped = contract(impl, { pre: [() => false] });

            expect(() => wrapped()).toThrow(PreconditionViolationError);
            expect(calls).toBe(0);
        });

        it('returns a promise that rejects with PreconditionViolationError for a failing async precondition', async () => {
            let calls = 0;
            async function impl(): Promise<string> {
                calls += 1;
                return 'ok';
            }
            const wrapped = contract(impl, { pre: [async () => false] });

            // the call itself must not throw; the derived promise rejects instead
            const pending = wrapped();
            expect(pending).toBeInstanceOf(Promise);
            await expect(pending).rejects.toBeInstanceOf(PreconditionViolationError);
            expect(calls).toBe(0);
        });

        it('awaits async preconditions before invoking fn (order: pre → fn)', async () => {
            const events: string[] = [];
            const wrapped = contract(
                async (value: number) => {
                    events.push('fn');
                    return value * 2;
                },
                {
                    pre: [
                        async () => {
                            await tick(5);
                            events.push('pre');
                            return true;
                        },
                    ],
                },
            );

            await expect(wrapped(21)).resolves.toBe(42);
            expect(events).toEqual(['pre', 'fn']);
        });

        it('lets the async predicate exception fly as-is (not wrapped)', async () => {
            const boom = new Error('pre predicate blew up');
            const wrapped = contract(async () => 'ok', {
                pre: [
                    async () => {
                        throw boom;
                    },
                ],
            });

            await expect(wrapped()).rejects.toBe(boom);
        });

        it('throws TypeError when an async predicate is used in a sync contract — pre', () => {
            function divide(a: number, b: number): number {
                return a / b;
            }
            const wrapped = contract(divide, { pre: [async () => true] });

            expect(() => wrapped(10, 2)).toThrow(TypeError);
            expect(() => wrapped(10, 2)).toThrow(/synchronous call path/);
        });

        it('records a precondition violation in audit mode and still runs fn', async () => {
            const records: AuditRecord[] = [];
            const wrapped = contract(async () => 'ok', { pre: [async () => false] });

            const result = await withConfig(
                { mode: 'audit', onAudit: (record) => records.push(record) },
                () => wrapped(),
            );

            expect(result).toBe('ok');
            expect(records).toHaveLength(1);
            expect(records[0]?.kind).toBe('precondition');
            expect(records[0]?.mode).toBe('audit');
        });
    });

    describe('postconditions', () => {
        it('hands the resolved value (not a promise) to postconditions', async () => {
            let seen: unknown;
            const wrapped = contract(async () => ({ answer: 42 }), {
                post: [
                    (result: { answer: number }) => {
                        seen = result;
                        return true;
                    },
                ],
            });

            await expect(wrapped()).resolves.toEqual({ answer: 42 });
            expect(seen).toEqual({ answer: 42 });
            expect((seen as { then?: unknown }).then).toBeUndefined();
        });

        it('rejects the derived promise with PostconditionViolationError (strict)', async () => {
            let calls = 0;
            async function impl(): Promise<number> {
                calls += 1;
                return 20;
            }
            const wrapped = contract(impl, { post: [(result: number) => result > 100] });

            // the call itself does not throw; rejection happens on the derived promise
            const pending = wrapped();
            expect(pending).toBeInstanceOf(Promise);
            const caught = await pending.then(
                () => {
                    throw new Error('expected a rejection');
                },
                (error: unknown) => error,
            );

            expect(caught).toBeInstanceOf(PostconditionViolationError);
            expect(caught).toBeInstanceOf(ContractViolationError);
            expect((caught as PostconditionViolationError).kind).toBe('postcondition');
            expect((caught as PostconditionViolationError).mode).toBe('strict');
            expect((caught as PostconditionViolationError).conditionIndex).toBe(0);
            expect(calls).toBe(1);
        });

        it('awaits async postconditions before releasing the derived promise', async () => {
            const events: string[] = [];
            const wrapped = contract(async () => 'value', {
                post: [
                    async () => {
                        await tick(5);
                        events.push('post');
                        return true;
                    },
                ],
            });

            const derived = wrapped().then((value) => {
                events.push('derived-resolved');
                return value;
            });

            await expect(derived).resolves.toBe('value');
            expect(events).toEqual(['post', 'derived-resolved']);
        });

        it('lets the caller keep going in warn mode and calls onViolation', async () => {
            const onViolation = vi.fn();
            const wrapped = contract(async () => 'still fine', {
                post: [() => false],
            });

            const result = await withConfig({ mode: 'warn', onViolation }, () => wrapped());

            expect(result).toBe('still fine');
            expect(onViolation).toHaveBeenCalledTimes(1);
            expect(onViolation.mock.calls[0]?.[0]).toBeInstanceOf(PostconditionViolationError);
        });

        it('warn mode without a handler logs a single console.warn line', async () => {
            const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
            const wrapped = contract(async () => 'value', { post: [() => false] });

            await expect(withConfig({ mode: 'warn' }, () => wrapped())).resolves.toBe('value');

            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(String(warnSpy.mock.calls[0]?.[0])).toContain('postcondition');
        });

        it('lets the async post predicate exception fly as-is (not wrapped)', async () => {
            const boom = new Error('post predicate blew up');
            const wrapped = contract(async () => 'value', {
                post: [
                    async () => {
                        throw boom;
                    },
                ],
            });

            await expect(wrapped()).rejects.toBe(boom);
        });

        it('throws TypeError when an async postcondition is used in a sync contract', () => {
            const wrapped = contract(() => 42, { post: [async () => true] });

            expect(() => wrapped()).toThrow(TypeError);
            expect(() => wrapped()).toThrow(/synchronous call path/);
        });

        it('does not run postconditions when fn rejects', async () => {
            const postSpy = vi.fn(() => true);
            const boom = new Error('fn failed');
            const wrapped = contract(
                async () => {
                    throw boom;
                },
                { post: [postSpy] },
            );

            await expect(wrapped()).rejects.toBe(boom);
            expect(postSpy).not.toHaveBeenCalled();
        });
    });

    describe('on-error', () => {
        it('lets the original error fly when the on-error contract passes', async () => {
            const boom = new Error('expected failure');
            const wrapped = contract(
                async () => {
                    throw boom;
                },
                { onError: [(error: unknown) => error === boom] },
            );

            await expect(wrapped()).rejects.toBe(boom);
        });

        it('propagates non-Error rejections untouched when on-error passes', async () => {
            const wrapped = contract(
                async (): Promise<number> => {
                    // rejecting with a non-Error is legal JS; it must travel as-is
                    throw 'a string rejection';
                },
                { onError: [() => true] },
            );

            await expect(wrapped()).rejects.toBe('a string rejection');
        });

        it('rejects with OnErrorViolationError when the on-error contract fails (strict)', async () => {
            const boom = new Error('expected failure');
            const wrapped = contract(
                async () => {
                    throw boom;
                },
                { onError: [() => false] },
            );

            const caught = await wrapped().then(
                () => {
                    throw new Error('expected a rejection');
                },
                (error: unknown) => error,
            );

            expect(caught).toBeInstanceOf(OnErrorViolationError);
            expect(caught).toBeInstanceOf(ContractViolationError);
            expect((caught as OnErrorViolationError).kind).toBe('on-error');
        });

        it('keeps the original error when the on-error contract fails in warn mode', async () => {
            const boom = new Error('expected failure');
            const onViolation = vi.fn();
            const wrapped = contract(
                async () => {
                    throw boom;
                },
                { onError: [() => false] },
            );

            const caught = await withConfig({ mode: 'warn', onViolation }, () =>
                wrapped().then(
                    () => {
                        throw new Error('expected a rejection');
                    },
                    (error: unknown) => error,
                ),
            );

            // warn never replaces the original error — it only reports
            expect(caught).toBe(boom);
            expect(onViolation).toHaveBeenCalledTimes(1);
            expect(onViolation.mock.calls[0]?.[0]).toBeInstanceOf(OnErrorViolationError);
        });

        it('keeps the original error when the on-error contract fails in audit mode and records it', async () => {
            const boom = new Error('expected failure');
            const records: AuditRecord[] = [];
            const wrapped = contract(
                async () => {
                    throw boom;
                },
                { onError: [() => false] },
            );

            const caught = await withConfig(
                { mode: 'audit', onAudit: (record) => records.push(record) },
                () =>
                    wrapped().then(
                        () => {
                            throw new Error('expected a rejection');
                        },
                        (error: unknown) => error,
                    ),
            );

            expect(caught).toBe(boom);
            expect(records).toHaveLength(1);
            expect(records[0]?.kind).toBe('on-error');
        });

        it('runs on-error predicates before the rejection reaches the caller', async () => {
            const events: string[] = [];
            const boom = new Error('expected failure');
            const wrapped = contract(
                async () => {
                    events.push('fn');
                    throw boom;
                },
                {
                    onError: [
                        async () => {
                            await tick(5);
                            events.push('on-error');
                            return true;
                        },
                    ],
                },
            );

            const caught = await wrapped().then(
                () => {
                    events.push('resolved');
                    return null;
                },
                (error: unknown) => {
                    events.push('caught');
                    return error;
                },
            );

            expect(caught).toBe(boom);
            expect(events).toEqual(['fn', 'on-error', 'caught']);
        });

        it('lets the async on-error predicate exception win over the original error', async () => {
            const original = new Error('original fn failure');
            const predicateBoom = new Error('on-error predicate blew up');
            const wrapped = contract(
                async () => {
                    throw original;
                },
                {
                    onError: [
                        async () => {
                            throw predicateBoom;
                        },
                    ],
                },
            );

            // predicate exceptions are never wrapped — the predicate's error propagates
            await expect(wrapped()).rejects.toBe(predicateBoom);
        });

        it('throws TypeError when an async on-error predicate is used in a sync contract', () => {
            const boom = new Error('sync boom');
            const wrapped = contract(
                (): number => {
                    throw boom;
                },
                { onError: [async () => true] },
            );

            expect(() => wrapped()).toThrow(TypeError);
            expect(() => wrapped()).toThrow(/synchronous call path/);
        });
    });

    describe('old values', () => {
        it('snapshots with the array form before fn runs (async fn declaration)', async () => {
            async function transfer(wallet: { balance: number }, amount: number): Promise<number> {
                wallet.balance -= amount;
                return wallet.balance;
            }

            const wrapped = contract(transfer, {
                old: ['wallet'],
                post: [
                    (result: number, ctx) => {
                        const oldValues = ctx.old as { wallet?: { balance: number } } | undefined;
                        const balance = oldValues?.wallet?.balance;
                        return result === 60 && balance === 100;
                    },
                ],
            });

            const wallet = { balance: 100 };
            await expect(wrapped(wallet, 40)).resolves.toBe(60);
        });

        it('snapshots with the function form + captureValue and exposes it on context.old', async () => {
            let oldBalance: number | undefined;
            const wrapped = contract(
                async (account: { balance: number }, delta: number) => {
                    account.balance += delta;
                    return account.balance;
                },
                {
                    old: (args) => ({ account: captureValue(args[0]) }),
                    post: [
                        (_result: number, ctx) => {
                            const oldValues = ctx.old as
                                | { account?: { balance: number } }
                                | undefined;
                            oldBalance = oldValues?.account?.balance;
                            return true;
                        },
                    ],
                },
            );

            const account = { balance: 1000 };
            await expect(wrapped(account, 250)).resolves.toBe(1250);
            expect(oldBalance).toBe(1000);
        });

        it('takes no snapshot when the contract has no postconditions', async () => {
            const capture = vi.fn(() => ({ anything: 'captured' }));
            const wrapped = contract(async () => 'ok', { old: capture });

            await expect(wrapped()).resolves.toBe('ok');
            expect(capture).not.toHaveBeenCalled();
        });
    });

    describe('scoped config & concurrency', () => {
        it('keeps warn and strict scopes separate for concurrent async calls', async () => {
            const wrapped = contract(
                async (label: string) => {
                    await tick(label === 'strict' ? 10 : 2);
                    return label;
                },
                { post: [() => false] },
            );

            const warnViolations: unknown[] = [];
            const strictCall = withConfig({ mode: 'strict' }, () => wrapped('strict'));
            const warnCall = withConfig(
                { mode: 'warn', onViolation: (error) => warnViolations.push(error) },
                () => wrapped('warn'),
            );

            await expect(strictCall).rejects.toBeInstanceOf(PostconditionViolationError);
            await expect(warnCall).resolves.toBe('warn');
            expect(warnViolations).toHaveLength(1);
        });

        it('propagates withConfig across multiple awaits inside the scope', async () => {
            const onViolation = vi.fn();
            const wrapped = contract(
                async () => {
                    await tick(1);
                    await tick(1);
                    return 42;
                },
                { post: [() => false] },
            );

            const result = withConfig({ mode: 'warn', onViolation }, async () => {
                await tick(1);
                return wrapped();
            });

            await expect(result).resolves.toBe(42);
            expect(onViolation).toHaveBeenCalledTimes(1);
        });

        it('applies per-scope disabled categories independently', async () => {
            const postSpy = vi.fn(() => false);
            const wrapped = contract(
                async (label: string) => {
                    await tick(1);
                    return label;
                },
                { post: [postSpy] },
            );

            const disabledCall = withConfig({ disabled: ['postcondition'] }, () =>
                wrapped('disabled'),
            );
            const strictCall = withConfig({ mode: 'strict' }, () => wrapped('strict'));

            await expect(disabledCall).resolves.toBe('disabled');
            await expect(strictCall).rejects.toBeInstanceOf(PostconditionViolationError);
            expect(postSpy).toHaveBeenCalledTimes(1);
        });

        it('inner scope wins over the enclosing scope for the same async call', async () => {
            const wrapped = contract(async () => 'value', { post: [() => false] });

            const outerWarnHandler = vi.fn();
            const result = await withConfig({ mode: 'warn', onViolation: outerWarnHandler }, () =>
                withConfig({ mode: 'strict' }, () =>
                    wrapped().then(
                        () => {
                            throw new Error('expected strict scope to win');
                        },
                        (error: unknown) => error,
                    ),
                ),
            );

            expect(result).toBeInstanceOf(PostconditionViolationError);
            expect(outerWarnHandler).not.toHaveBeenCalled();
        });

        it('skips async predicates when on-error is disabled in the scope', async () => {
            const onErrorSpy = vi.fn(() => false);
            const boom = new Error('fn failed');
            const wrapped = contract(
                async () => {
                    throw boom;
                },
                { onError: [onErrorSpy] },
            );

            await withConfig({ disabled: ['on-error'] }, async () => {
                await expect(wrapped()).rejects.toBe(boom);
            });

            expect(onErrorSpy).not.toHaveBeenCalled();
        });

        it('disabled preconditions are not evaluated on the async path', async () => {
            const preSpy = vi.fn(() => false);
            const wrapped = contract(async () => 'ran', { pre: [preSpy] });

            const result = await withConfig({ disabled: ['precondition'] }, () => wrapped());

            expect(result).toBe('ran');
            expect(preSpy).not.toHaveBeenCalled();
        });
    });

    describe('off & silent modes', () => {
        it('off mode: async predicates are never called, value passes through', async () => {
            const preSpy = vi.fn(async () => true);
            const postSpy = vi.fn(async () => true);
            const wrapped = contract(async () => 'value', {
                mode: 'off',
                pre: [preSpy],
                post: [postSpy],
            });

            await expect(wrapped()).resolves.toBe('value');
            expect(preSpy).not.toHaveBeenCalled();
            expect(postSpy).not.toHaveBeenCalled();
        });

        it('off mode: returns the original thenable object for non-async fn', () => {
            const thenable = resolvingThenable(42);
            const postSpy = vi.fn(() => true);
            const wrapped = contract(() => thenable, { mode: 'off', post: [postSpy] });

            expect(wrapped()).toBe(thenable);
            expect(postSpy).not.toHaveBeenCalled();
        });

        it('silent mode: async predicates are never called, value passes through', async () => {
            const preSpy = vi.fn(async () => true);
            const postSpy = vi.fn(async () => true);
            const wrapped = contract(async () => 'value', {
                mode: 'silent',
                pre: [preSpy],
                post: [postSpy],
            });

            await expect(wrapped()).resolves.toBe('value');
            expect(preSpy).not.toHaveBeenCalled();
            expect(postSpy).not.toHaveBeenCalled();
        });
    });

    describe('thenables', () => {
        it('treats a custom resolving thenable as a promise (post sees the value)', async () => {
            const thenable = resolvingThenable(42);
            const seen: unknown[] = [];
            const wrapped = contract(() => thenable, {
                post: [
                    (result: number) => {
                        seen.push(result);
                        return true;
                    },
                ],
            });

            await expect(wrapped()).resolves.toBe(42);
            expect(seen).toEqual([42]);
        });

        it('treats a custom rejecting thenable as a promise (on-error sees the reason)', async () => {
            const boom = new Error('thenable rejected');
            const thenable = rejectingThenable(boom);
            const wrapped = contract(() => thenable, {
                onError: [(error: unknown) => error === boom],
            });

            await expect(wrapped()).rejects.toBe(boom);
        });

        it('reports a postcondition violation from a custom thenable (strict)', async () => {
            const thenable = resolvingThenable(7);
            const wrapped = contract(() => thenable, { post: [(result: number) => result > 100] });

            await expect(wrapped()).rejects.toBeInstanceOf(PostconditionViolationError);
        });
    });

    describe('audit mode', () => {
        it('records kind "postcondition" without throwing, with durationMs', async () => {
            const records: AuditRecord[] = [];
            const onViolation = vi.fn();
            const wrapped = contract(async () => 'value', { post: [() => false] });

            const result = await withConfig(
                {
                    mode: 'audit',
                    onAudit: (record) => records.push(record),
                    onViolation,
                },
                () => wrapped(),
            );

            // audit never throws — the resolved value flows through
            expect(result).toBe('value');
            expect(records).toHaveLength(1);

            const record = records[0];
            expect(record?.kind).toBe('postcondition');
            expect(record?.mode).toBe('audit');
            expect(record?.conditionIndex).toBe(0);
            expect(typeof record?.contractName).toBe('string');
            expect(typeof record?.functionName).toBe('string');
            expect(typeof record?.timestamp).toBe('number');
            // durationMs = wall time from wrapper entry to the violation point
            expect(typeof record?.durationMs).toBe('number');
            expect(record?.durationMs ?? -1).toBeGreaterThanOrEqual(0);

            expect(onViolation).toHaveBeenCalledTimes(1);
        });

        it('records kind "on-error" and lets the original error fly, no throw', async () => {
            const boom = new Error('fn failed');
            const records: AuditRecord[] = [];
            const wrapped = contract(
                async () => {
                    throw boom;
                },
                { onError: [() => false] },
            );

            const caught = await withConfig(
                { mode: 'audit', onAudit: (record) => records.push(record) },
                () =>
                    wrapped().then(
                        () => {
                            throw new Error('expected a rejection');
                        },
                        (error: unknown) => error,
                    ),
            );

            expect(caught).toBe(boom);
            expect(records.map((record) => record.kind)).toEqual(['on-error']);
        });
    });

    describe('edge cases', () => {
        it('empty option bag works for async fn', async () => {
            const wrapped = contract(async () => 7);
            await expect(wrapped()).resolves.toBe(7);
        });

        it('empty pre/post/onError arrays work for async fn', async () => {
            const wrapped = contract(async () => 7, { pre: [], post: [], onError: [] });
            await expect(wrapped()).resolves.toBe(7);
        });

        it('configure() global audit mode applies to async contracts', async () => {
            const records: AuditRecord[] = [];
            configure({ mode: 'audit', onAudit: (record) => records.push(record) });
            const wrapped = contract(async () => 'value', { post: [() => false] });

            await expect(wrapped()).resolves.toBe('value');
            expect(records.map((record) => record.kind)).toEqual(['postcondition']);
        });
    });
});
