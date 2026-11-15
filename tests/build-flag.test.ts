// the repo compiles without ambient node types, so reach console structurally
const testProcess = (
    globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process;

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViolationCategory } from '../src/index.js';
import {
    condition,
    configure,
    contract,
    PreconditionViolationError,
    resetConfig,
} from '../src/index.js';
import { canSkip, getEffectiveConfig } from '../src/runtime/index.js';
import { isContractsCompiledIn } from '../src/utils/build-flag.js';

const FLAG_KEY = '__DESIGN_CONTRACTS_ENABLED__';
const globalWithFlag = globalThis as Record<string, unknown>;

const ALL_CATEGORIES: readonly ViolationCategory[] = [
    'precondition',
    'postcondition',
    'invariant',
    'assertion',
    'on-error',
];

beforeEach(() => {
    delete testProcess.env['NODE_CONTRACTS_MODE'];
    delete testProcess.env['NODE_ENV'];
    resetConfig();
    delete globalWithFlag[FLAG_KEY];
});

afterEach(() => {
    resetConfig();
    vi.restoreAllMocks();
    delete globalWithFlag[FLAG_KEY];
});

describe('build flag — __DESIGN_CONTRACTS_ENABLED__ toggling', () => {
    it('is compiled in by default (constant absent)', () => {
        expect(isContractsCompiledIn()).toBe(true);
    });

    it('flag=false compiles contracts out: predicates are compiled out regardless of mode', () => {
        configure({ mode: 'strict' });
        expect(canSkip('precondition')).toBe(false);

        globalWithFlag[FLAG_KEY] = false;
        expect(isContractsCompiledIn()).toBe(false);
        for (const category of ALL_CATEGORIES) {
            expect(canSkip(category)).toBe(true);
        }
        // resolution is not even reached — the config may stay strict
        expect(getEffectiveConfig().mode).toBe('strict');
    });

    it('flag=true compiles contracts in again within the same process', () => {
        globalWithFlag[FLAG_KEY] = false;
        expect(isContractsCompiledIn()).toBe(false);
        expect(canSkip('precondition')).toBe(true);

        globalWithFlag[FLAG_KEY] = true;
        expect(isContractsCompiledIn()).toBe(true);
        expect(canSkip('precondition')).toBe(false);
    });

    it('deleting the constant restores the default (compiled in) behavior', () => {
        globalWithFlag[FLAG_KEY] = false;
        expect(isContractsCompiledIn()).toBe(false);

        delete globalWithFlag[FLAG_KEY];
        expect(isContractsCompiledIn()).toBe(true);
        expect(canSkip('precondition')).toBe(false);
    });

    it('with the flag false, a failing precondition does not throw even in strict mode', () => {
        configure({ mode: 'strict' });
        const wrapped = contract(() => 42, {
            pre: [condition(() => false, { name: 'neverPasses' })],
        });
        globalWithFlag[FLAG_KEY] = false;
        expect(wrapped()).toBe(42);
    });

    it('with the flag true, the same contract throws in strict mode', () => {
        configure({ mode: 'strict' });
        const wrapped = contract(() => 42, {
            pre: [condition(() => false, { name: 'neverPasses' })],
        });
        globalWithFlag[FLAG_KEY] = true;
        expect(() => wrapped()).toThrow(PreconditionViolationError);
    });
});
