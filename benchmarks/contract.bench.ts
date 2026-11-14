/**
 * Benchmarks — contract call overhead.
 *
 * Methodology
 * -----------
 * Runner: vitest bench (tinybench under the hood), vitest 5.1.0.
 * vitest 5 rewrote the benchmarking API: `bench` is a test-context fixture
 * (not a top-level import), benchmarks live inside `test()` in `.bench.ts`
 * files, and each awaited `.run()` prints its own ops/sec row. Relative
 * overhead is read off the reported hz values — nothing is post-processed.
 *
 * Measured on (2026-11-15):
 *   - Node.js v24.2.0 (via `npx vitest bench`)
 *   - Bun 1.4.2       (via `bunx vitest bench`)
 * Note: in non-TTY output the default reporter prints no bench rows — the
 * `bench` script pins `--reporter=verbose` so ops/sec tables are always shown.
 *
 * The library itself supports node >= 18; vitest 5 requires node ^22.12 || ^24,
 * so benches cannot run on older node versions without an older vitest.
 *
 * Wrapped functions are intentionally trivial (a number add, an array sum) so
 * the measured delta reflects the contract machinery, not the payload.
 * Predicate workload is deliberately light — one truthy check per condition.
 *
 * Default enforcement mode in the test environment is `strict` (NODE_ENV is
 * not `production`); per-contract `mode` overrides are used for the mode
 * comparisons so no global configuration is mutated between benches.
 *
 * Reproduce:
 *   bunx vitest bench
 *   npx vitest bench     (node)
 *
 * Notes:
 * - `warn`/`silent`/`off` benches use predicates that PASS — no logging or
 *   violation handling is exercised, only the mode-resolution fast paths.
 * - The `old` bench uses the array form (`old: ['items']`); one
 *   `structuredClone` of a small array per call, which is the documented cost.
 * - The on-error benches throw inside a try/catch so a thrown error is a
 *   normal, counted call rather than a failed iteration.
 */

import { describe, test } from 'vitest';
import { contract, contractObject } from '../src/index.js';

// --- sync scenarios ---------------------------------------------------------

const add = (a: number, b: number): number => a + b;

const addWith1Pre = contract(add, {
    pre: [(_a: number, b: number) => b !== 0],
});

const addWith3Pre = contract(add, {
    pre: [
        (_a: number, b: number) => b !== 0,
        (a: number) => Number.isFinite(a),
        (a: number, b: number) => a + b < Number.MAX_SAFE_INTEGER,
    ],
});

const addTypical = contract(add, {
    pre: [(_a: number, b: number) => b !== 0],
    post: [(result: number) => Number.isFinite(result)],
});

const sumItems = (items: number[]): number => items.reduce((acc, n) => acc + n, 0);

const sumWithOld = contract(sumItems, {
    pre: [(items: number[]) => items.length > 0],
    post: [(result: number, ctx) => result >= 0 && ctx.old !== undefined],
    old: ['items'],
});

const addOff = contract(add, {
    mode: 'off',
    pre: [(_a: number, b: number) => b !== 0],
    post: [(result: number) => Number.isFinite(result)],
});

const addWarn = contract(add, {
    mode: 'warn',
    pre: [(_a: number, b: number) => b !== 0],
    post: [(result: number) => Number.isFinite(result)],
});

const addSilent = contract(add, {
    mode: 'silent',
    pre: [(_a: number, b: number) => b !== 0],
    post: [(result: number) => Number.isFinite(result)],
});

const sampleItems = [1, 2, 3, 4, 5];

describe('sync call — contract overhead', () => {
    test('benchmarks', { timeout: 120_000 }, async ({ bench }) => {
        await bench('plain call (baseline)', () => {
            add(1, 2);
        }).run();

        await bench('contract, 1 pre', () => {
            addWith1Pre(1, 2);
        }).run();

        await bench('contract, 3 pre', () => {
            addWith3Pre(1, 2);
        }).run();

        await bench('contract, pre + post (typical)', () => {
            addTypical(1, 2);
        }).run();

        await bench('contract, pre + post + old', () => {
            sumWithOld(sampleItems);
        }).run();

        await bench('contract, off mode', () => {
            addOff(1, 2);
        }).run();

        await bench('contract, warn mode', () => {
            addWarn(1, 2);
        }).run();

        await bench('contract, silent mode', () => {
            addSilent(1, 2);
        }).run();
    });
});

// --- async scenarios --------------------------------------------------------

const asyncAdd = async (a: number, b: number): Promise<number> => a + b;

const asyncAddTypical = contract(asyncAdd, {
    pre: [(_a: number, b: number) => b !== 0],
    post: [(result: number) => Number.isFinite(result)],
});

describe('async call — contract overhead', () => {
    test('benchmarks', { timeout: 120_000 }, async ({ bench }) => {
        await bench('async plain call (baseline)', async () => {
            await asyncAdd(1, 2);
        }).run();

        await bench('async contract, pre + post', async () => {
            await asyncAddTypical(1, 2);
        }).run();
    });
});

// --- contractObject scenarios -----------------------------------------------

const makeCounter = () => ({
    balance: 100,
    deposit(amount: number): number {
        this.balance += amount;
        return this.balance;
    },
});

const makeContractedCounter = () =>
    contractObject(makeCounter(), {
        name: 'counter',
        invariant: [(self) => self.balance >= 0],
    });

const plainCounter = makeCounter();
const contractedCounter = makeContractedCounter();

describe('contractObject — invariant overhead', () => {
    test('benchmarks', { timeout: 120_000 }, async ({ bench }) => {
        await bench('plain object method (baseline)', () => {
            plainCounter.deposit(1);
        }).run();

        await bench('contractObject with invariant', () => {
            contractedCounter.deposit(1);
        }).run();
    });
});

// --- onError scenarios ------------------------------------------------------

const failing = (): number => {
    throw new Error('boom');
};

const failingWithOnError = contract(failing, {
    onError: [(error: unknown) => error instanceof Error],
});

const failingWithoutOnError = contract(failing, {});

const plainFailing = (): number => {
    throw new Error('boom');
};

const okWithOnError = contract(add, {
    onError: [(error: unknown) => error instanceof Error],
});

const okWithoutOnError = contract(add, {});

describe('onError — error path overhead', () => {
    test('benchmarks', { timeout: 120_000 }, async ({ bench }) => {
        await bench('plain throwing call (baseline)', () => {
            try {
                plainFailing();
            } catch {
                // expected
            }
        }).run();

        await bench('contract without onError (throwing fn)', () => {
            try {
                failingWithoutOnError();
            } catch {
                // expected
            }
        }).run();

        await bench('contract with onError (throwing fn)', () => {
            try {
                failingWithOnError();
            } catch {
                // expected
            }
        }).run();

        await bench('contract without onError (non-throwing fn)', () => {
            okWithoutOnError(1, 2);
        }).run();

        await bench('contract with onError (non-throwing fn)', () => {
            okWithOnError(1, 2);
        }).run();
    });
});
