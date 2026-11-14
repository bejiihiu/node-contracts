import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssertionViolationError, assert, ContractViolationError } from '../src/index.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('assert — falsy condition', () => {
    it('throws AssertionViolationError with kind assertion', () => {
        let thrown: unknown;
        try {
            assert(false, 'boom');
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(AssertionViolationError);
        expect((thrown as AssertionViolationError).kind).toBe('assertion');
    });

    it('thrown error is an instance of Error and ContractViolationError', () => {
        expect(() => assert(false)).toThrow(Error);
        expect(() => assert(false)).toThrow(ContractViolationError);
        expect(() => assert(false)).toThrow(AssertionViolationError);
    });

    it('covers every falsy flavor', () => {
        for (const falsy of [0, '', false, null, undefined, Number.NaN]) {
            expect(() => assert(falsy)).toThrow(AssertionViolationError);
        }
    });

    it('uses the provided message', () => {
        expect(() => assert(false, 'plain message')).toThrow(/plain message/);
    });

    it('falls back to the default message when none is passed', () => {
        try {
            assert(false);
            expect.unreachable('assert(false) must throw');
        } catch (error) {
            expect((error as Error).message.length).toBeGreaterThan(0);
        }
    });
});

describe('assert — truthy condition', () => {
    it('does not throw and returns undefined', () => {
        expect(assert(true)).toBeUndefined();
        expect(() => assert(1, 'ignored')).not.toThrow();
        expect(() => assert('truthy')).not.toThrow();
        expect(() => assert({ ok: true })).not.toThrow();
    });
});

describe('assert — context squashing', () => {
    const catchAssertion = (context: unknown): AssertionViolationError => {
        try {
            assert(false, 'ctx', context);
            throw new Error('expected assert to throw');
        } catch (error) {
            if (error instanceof AssertionViolationError) return error;
            throw error;
        }
    };

    it('record context passes through (sanitized shape kept)', () => {
        const err = catchAssertion({ user: 'ada', retryCount: 2 });
        expect(err.context).toEqual({ user: 'ada', retryCount: 2 });
    });

    it('non-record scalars are wrapped into { value }', () => {
        expect(catchAssertion(42).context).toEqual({ value: 42 });
        expect(catchAssertion('nope').context).toEqual({ value: 'nope' });
        expect(catchAssertion(true).context).toEqual({ value: true });
    });

    it('arrays are wrapped into { value } (records only stay bare)', () => {
        const err = catchAssertion([1, 2, 3]);
        expect(err.context).toEqual({ value: [1, 2, 3] });
    });

    it('bigint scalars squash to their n-suffixed string form', () => {
        expect(catchAssertion(99n).context).toEqual({ value: '99n' });
    });

    it('cyclic context survives sanitizing instead of blowing up', () => {
        const cyclic: Record<string, unknown> = { name: 'loop' };
        cyclic['self'] = cyclic;
        const err = catchAssertion(cyclic);
        expect(err.context).toEqual({ name: 'loop', self: '[Circular]' });
    });

    it('undefined context leaves context unset on the error', () => {
        try {
            assert(false, 'no context');
            expect.unreachable();
        } catch (error) {
            expect((error as AssertionViolationError).context).toBeUndefined();
        }
    });
});

describe('assert.fail', () => {
    it('unconditionally throws AssertionViolationError', () => {
        expect(() => assert.fail()).toThrow(AssertionViolationError);
        expect(() => assert.fail('deliberate')).toThrow(/deliberate/);
    });

    it('thrown value is an Error instance with kind assertion', () => {
        try {
            assert.fail('deliberate');
            expect.unreachable();
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as AssertionViolationError).kind).toBe('assertion');
        }
    });

    it('context goes through the same squash', () => {
        try {
            assert.fail('ctx', 'raw scalar');
            expect.unreachable();
        } catch (error) {
            expect((error as AssertionViolationError).context).toEqual({ value: 'raw scalar' });
        }
    });

    it('is usable as the throw site in a function typed to never return', () => {
        const unreachable = (): never => assert.fail('should not reach');
        expect(unreachable).toThrow(AssertionViolationError);
    });
});
