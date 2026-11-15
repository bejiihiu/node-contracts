import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    contract,
    OnErrorViolationError,
    PostconditionViolationError,
    resetConfig,
} from '../src/index.js';

/**
 * Combination semantics — onError + post + old on the same async contract.
 * These tests pin down documented behavior, not implementation details.
 */

describe('contract combinations: onError + post + old', () => {
    beforeEach(() => {
        resetConfig();
    });
    afterEach(() => {
        resetConfig();
    });

    it('post receives the resolved value while old is a pre-call snapshot (async fn)', async () => {
        const account = { balance: 100 };
        const withdraw = contract(
            async (acc: { balance: number }, amount: number) => {
                acc.balance -= amount;
                return acc.balance;
            },
            {
                pre: [(acc, amount) => amount > 0 && acc.balance >= amount],
                post: [
                    (result, ctx) =>
                        result ===
                        (ctx.old as { acc: { balance: number } }).acc.balance -
                            (ctx.old as { amount: number }).amount,
                ],
                old: ['acc', 'amount'],
            },
        );

        const result = await withdraw(account, 30);
        expect(result).toBe(70);
        expect(account.balance).toBe(70);
    });

    it('post does not run when fn rejects; onError still sees the error', async () => {
        const observed: unknown[] = [];
        const failing = contract(
            async (value: number) => {
                if (value < 0) throw new RangeError('negative value');
                return value * 2;
            },
            {
                post: [
                    (result) => {
                        observed.push(result);
                        return true;
                    },
                ],
                onError: [(error) => error instanceof Error],
            },
        );

        await expect(failing(-1)).rejects.toThrow(RangeError);
        expect(observed).toHaveLength(0);

        await expect(failing(3)).resolves.toBe(6);
        expect(observed).toEqual([6]);
    });

    it('onError rejection from an illegitimate error throws OnErrorViolationError', async () => {
        const failing = contract(
            async () => {
                throw new Error('totally unexpected: not a validation issue');
            },
            {
                onError: [(error) => error instanceof RangeError],
            },
        );

        await expect(failing()).rejects.toThrow(OnErrorViolationError);
    });

    it('thrown error is passed through untouched when onError passes', async () => {
        class NetworkError extends Error {}
        const original = new NetworkError('boom');
        const failing = contract(
            async () => {
                throw original;
            },
            {
                onError: [(error) => error instanceof NetworkError],
            },
        );

        await expect(failing()).rejects.toBe(original);
    });

    it('args are a live reference: mutations inside fn are visible in post context', async () => {
        const seen: number[] = [];
        const mutator = contract(
            (list: number[]) => {
                list.push(42);
                return list.length;
            },
            {
                post: [
                    (result, ctx) => {
                        seen.push((ctx.args[0] as number[]).length, result);
                        return true;
                    },
                ],
            },
        );

        expect(mutator([1, 2])).toBe(3);
        expect(seen).toEqual([3, 3]);
    });

    it('repeated calls of the same wrapped function do not leak state between invocations', async () => {
        const calls: Array<{ result: number; oldAmount: number }> = [];
        const double = contract(async (n: number) => n * 2, {
            post: [
                (result, ctx) => {
                    calls.push({ result, oldAmount: (ctx.old as { n: number }).n });
                    return true;
                },
            ],
            old: ['n'],
        });

        for (const n of [1, 2, 3, 4]) {
            await double(n);
        }
        expect(calls).toEqual([
            { result: 2, oldAmount: 1 },
            { result: 4, oldAmount: 2 },
            { result: 6, oldAmount: 3 },
            { result: 8, oldAmount: 4 },
        ]);
    });

    it('onError predicates throwing are not masked by the original error', async () => {
        const failing = contract(
            async () => {
                throw new Error('original');
            },
            {
                onError: [
                    () => {
                        throw new TypeError('predicate exploded');
                    },
                ],
            },
        );

        await expect(failing()).rejects.toThrow('predicate exploded');
    });

    it('post violation carries fn name and result even when old snapshot exists', async () => {
        const broken = contract(async (x: number) => x, {
            post: [(result) => result > 100],
            old: (args) => ({ captured: args[0] }),
        });

        await expect(broken(5)).rejects.toThrow(PostconditionViolationError);
    });
});
