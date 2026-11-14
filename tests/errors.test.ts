import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AssertionViolationError,
    ContractViolationError,
    condition,
    configure,
    contract,
    InvariantViolationError,
    OnErrorViolationError,
    PostconditionViolationError,
    PreconditionViolationError,
    resetConfig,
} from '../src/index.js';

afterEach(() => {
    resetConfig();
    vi.restoreAllMocks();
});

describe('error hierarchy', () => {
    it('PreconditionViolationError extends ContractViolationError and Error', () => {
        const err = new PreconditionViolationError('msg');
        expect(err).toBeInstanceOf(ContractViolationError);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(PreconditionViolationError);
    });

    it('PostconditionViolationError extends ContractViolationError and Error', () => {
        const err = new PostconditionViolationError('msg');
        expect(err).toBeInstanceOf(ContractViolationError);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(PostconditionViolationError);
    });

    it('InvariantViolationError extends ContractViolationError and Error', () => {
        const err = new InvariantViolationError('msg');
        expect(err).toBeInstanceOf(ContractViolationError);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(InvariantViolationError);
    });

    it('AssertionViolationError extends ContractViolationError and Error', () => {
        const err = new AssertionViolationError('msg');
        expect(err).toBeInstanceOf(ContractViolationError);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(AssertionViolationError);
    });

    it('OnErrorViolationError extends ContractViolationError and Error', () => {
        const err = new OnErrorViolationError('msg');
        expect(err).toBeInstanceOf(ContractViolationError);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(OnErrorViolationError);
    });

    it('prototype chain stays intact for catch-narrowing', () => {
        // guards the setPrototypeOf(this, new.target.prototype) trick
        expect(PreconditionViolationError.prototype).toBeInstanceOf(ContractViolationError);
        expect(PostconditionViolationError.prototype).toBeInstanceOf(ContractViolationError);
        expect(InvariantViolationError.prototype).toBeInstanceOf(ContractViolationError);
        expect(AssertionViolationError.prototype).toBeInstanceOf(ContractViolationError);
        expect(OnErrorViolationError.prototype).toBeInstanceOf(ContractViolationError);
        expect(ContractViolationError.prototype).toBeInstanceOf(Error);
    });

    it('name matches the class for every violation class', () => {
        expect(new PreconditionViolationError().name).toBe('PreconditionViolationError');
        expect(new PostconditionViolationError().name).toBe('PostconditionViolationError');
        expect(new InvariantViolationError().name).toBe('InvariantViolationError');
        expect(new AssertionViolationError().name).toBe('AssertionViolationError');
        expect(new OnErrorViolationError().name).toBe('OnErrorViolationError');
        expect(new ContractViolationError('precondition', 'msg').name).toBe(
            'ContractViolationError',
        );
    });

    it('captureStackTrace produces a stack string', () => {
        const err = new PreconditionViolationError('boom');
        expect(typeof err.stack).toBe('string');
        expect(err.stack).toContain('PreconditionViolationError');
    });
});

describe('structured fields', () => {
    it('each class carries the right kind literal', () => {
        expect(new PreconditionViolationError().kind).toBe('precondition');
        expect(new PostconditionViolationError().kind).toBe('postcondition');
        expect(new InvariantViolationError().kind).toBe('invariant');
        expect(new AssertionViolationError().kind).toBe('assertion');
        expect(new OnErrorViolationError().kind).toBe('on-error');
    });

    it('mode defaults to strict when not provided', () => {
        expect(new PreconditionViolationError().mode).toBe('strict');
        expect(new PostconditionViolationError().mode).toBe('strict');
        expect(new InvariantViolationError().mode).toBe('strict');
        expect(new AssertionViolationError().mode).toBe('strict');
        expect(new OnErrorViolationError().mode).toBe('strict');
    });

    it('explicit mode is stored as given', () => {
        expect(new PreconditionViolationError('m', { mode: 'warn' }).mode).toBe('warn');
        expect(new PostconditionViolationError('m', { mode: 'audit' }).mode).toBe('audit');
        expect(new InvariantViolationError('m', { mode: 'silent' }).mode).toBe('silent');
        expect(new AssertionViolationError('m', { mode: 'off' }).mode).toBe('off');
    });

    it('conditionIndex is stored zero-based', () => {
        expect(new PreconditionViolationError('m', { conditionIndex: 0 }).conditionIndex).toBe(0);
        expect(new PostconditionViolationError('m', { conditionIndex: 3 }).conditionIndex).toBe(3);
    });

    it('contractName, functionName, conditionName and context pass through', () => {
        const context = { amount: 42, ok: true };
        const err = new PreconditionViolationError('m', {
            contractName: 'myContract',
            functionName: 'divide',
            conditionIndex: 2,
            conditionName: 'nonzero',
            context,
        });
        expect(err.contractName).toBe('myContract');
        expect(err.functionName).toBe('divide');
        expect(err.conditionIndex).toBe(2);
        expect(err.conditionName).toBe('nonzero');
        expect(err.context).toBe(context);
    });

    it('conditionName is undefined when not provided', () => {
        const err = new PreconditionViolationError('m', { conditionIndex: 0 });
        expect(err.conditionName).toBeUndefined();
        // class field declarations are emitted as own properties with value
        // undefined (useDefineForClassFields) — readers see `undefined`, never garbage
        expect(Object.getOwnPropertyDescriptor(err, 'conditionName')?.value).toBeUndefined();
    });

    it('all optional contract fields stay undefined when not provided', () => {
        const err = new InvariantViolationError();
        expect(err.contractName).toBeUndefined();
        expect(err.functionName).toBeUndefined();
        expect(err.conditionIndex).toBeUndefined();
        expect(err.conditionName).toBeUndefined();
        expect(err.context).toBeUndefined();
    });

    it('cause via details.cause survives subclassing and keeps the instanceof chain', () => {
        const root = new Error('root cause');
        const mid = new TypeError('mid', { cause: root });
        const err = new PostconditionViolationError('m', { cause: mid });
        expect(err.cause).toBe(mid);
        expect((err.cause as TypeError).cause).toBe(root);
        expect(err.cause).toBeInstanceOf(Error);
    });

    it('no cause key is set on the error when details.cause is absent', () => {
        const err = new PreconditionViolationError('m');
        expect('cause' in err).toBe(false);
        expect(err.cause).toBeUndefined();
    });
});

describe('default messages', () => {
    it('precondition message carries label, function, index, condition name and user message', () => {
        const err = new PreconditionViolationError('divisor must not be zero', {
            functionName: 'divide',
            conditionIndex: 0,
            conditionName: 'nonzero',
        });
        expect(err.message).toContain('Precondition violated');
        expect(err.message).toContain('divide');
        expect(err.message).toContain('(condition #0)');
        expect(err.message).toContain('[nonzero]');
        expect(err.message).toContain('divisor must not be zero');
    });

    it('postcondition message carries all parts', () => {
        const err = new PostconditionViolationError('result must be finite', {
            functionName: 'compute',
            conditionIndex: 1,
            conditionName: 'finite',
        });
        expect(err.message).toContain('Postcondition violated');
        expect(err.message).toContain('compute');
        expect(err.message).toContain('(condition #1)');
        expect(err.message).toContain('[finite]');
        expect(err.message).toContain('result must be finite');
    });

    it('invariant message carries all parts', () => {
        const err = new InvariantViolationError('balance went negative', {
            functionName: 'withdraw',
            conditionIndex: 0,
            conditionName: 'nonNegativeBalance',
        });
        expect(err.message).toContain('Invariant violated');
        expect(err.message).toContain('withdraw');
        expect(err.message).toContain('(condition #0)');
        expect(err.message).toContain('[nonNegativeBalance]');
        expect(err.message).toContain('balance went negative');
    });

    it('assertion message carries all parts', () => {
        const err = new AssertionViolationError('unreachable state', {
            functionName: 'reconcile',
            conditionIndex: 4,
            conditionName: 'sane',
        });
        expect(err.message).toContain('Assertion violated');
        expect(err.message).toContain('reconcile');
        expect(err.message).toContain('(condition #4)');
        expect(err.message).toContain('[sane]');
        expect(err.message).toContain('unreachable state');
    });

    it('on-error message uses its own label', () => {
        const err = new OnErrorViolationError('shape mismatch', {
            functionName: 'load',
            conditionIndex: 1,
            conditionName: 'isDatabaseError',
        });
        expect(err.message).toContain('On-error condition violated');
        expect(err.message).toContain('load');
        expect(err.message).toContain('(condition #1)');
        expect(err.message).toContain('[isDatabaseError]');
        expect(err.message).toContain('shape mismatch');
    });

    it('user message lands at the very end', () => {
        const err = new PreconditionViolationError('custom tail', {
            functionName: 'fn',
            conditionIndex: 0,
            conditionName: 'named',
        });
        expect(err.message.endsWith('custom tail')).toBe(true);
    });

    it('no details at all collapse to a bare label with no dangling separators', () => {
        expect(new PreconditionViolationError().message).toBe('Precondition violated');
        expect(new PostconditionViolationError().message).toBe('Postcondition violated');
        expect(new AssertionViolationError().message).toBe('Assertion violated');
        expect(new OnErrorViolationError().message).toBe('On-error condition violated');
    });

    it('conditionIndex without conditionName leaves no brackets behind', () => {
        const err = new PreconditionViolationError('m', { conditionIndex: 3 });
        expect(err.message).toContain('(condition #3)');
        expect(err.message).not.toContain('[');
        expect(err.message).not.toContain(']');
    });

    it('missing functionName leaves no dangling separator', () => {
        const err = new PostconditionViolationError('boom', { conditionIndex: 2 });
        expect(err.message).toContain('Postcondition violated');
        expect(err.message).toContain('(condition #2)');
        expect(err.message).not.toContain('undefined');
        expect(err.message).not.toMatch(/:\s*:/);
    });

    it('empty user message is skipped without a trailing colon', () => {
        const err = new PreconditionViolationError('', { functionName: 'fn', conditionIndex: 0 });
        expect(err.message.endsWith(':')).toBe(false);
        expect(err.message).not.toContain('  ');
    });

    it('empty functionName is treated as missing', () => {
        const err = new PreconditionViolationError('m', {
            functionName: '',
            conditionIndex: 0,
        });
        expect(err.message).not.toContain('  ');
        expect(err.message).toContain('Precondition violated');
        expect(err.message).toContain('(condition #0)');
    });
});

describe('toJSON', () => {
    it('omits the stack trace entirely', () => {
        const json = new PreconditionViolationError('m', {
            functionName: 'fn',
            conditionIndex: 0,
        }).toJSON();
        expect(json).not.toHaveProperty('stack');
    });

    it('carries name, kind, mode, message and conditionIndex', () => {
        const json = new PostconditionViolationError('m', {
            conditionIndex: 2,
            mode: 'warn',
        }).toJSON();
        expect(json.name).toBe('PostconditionViolationError');
        expect(json.kind).toBe('postcondition');
        expect(json.mode).toBe('warn');
        expect(json.message).toContain('Postcondition violated');
        expect(json.conditionIndex).toBe(2);
    });

    it('carries the optional contract fields when present', () => {
        const json = new InvariantViolationError('m', {
            contractName: 'Account',
            functionName: 'deposit',
            conditionIndex: 0,
            conditionName: 'positive',
        }).toJSON();
        expect(json.contractName).toBe('Account');
        expect(json.functionName).toBe('deposit');
        expect(json.conditionName).toBe('positive');
    });

    it('omits optional contract fields when not provided', () => {
        const json = new AssertionViolationError().toJSON();
        expect(json).not.toHaveProperty('contractName');
        expect(json).not.toHaveProperty('functionName');
        expect(json).not.toHaveProperty('conditionIndex');
        expect(json).not.toHaveProperty('conditionName');
        expect(json).not.toHaveProperty('context');
        expect(json).not.toHaveProperty('cause');
    });

    it('context passes through as-is (same reference)', () => {
        const context = { nested: { list: [1, 2, 3] }, ok: true };
        const json = new PreconditionViolationError('m', { context }).toJSON();
        expect(json.context).toBe(context);
    });

    it('Error cause serializes to { name, message }', () => {
        const cause = new RangeError('out of bounds');
        const json = new PreconditionViolationError('m', { cause }).toJSON();
        expect(json.cause).toEqual({ name: 'RangeError', message: 'out of bounds' });
    });

    it('primitive causes (string, number, boolean, bigint, null) pass through', () => {
        expect(new PreconditionViolationError('m', { cause: 'why' }).toJSON().cause).toBe('why');
        expect(new PreconditionViolationError('m', { cause: 42 }).toJSON().cause).toBe(42);
        expect(new PreconditionViolationError('m', { cause: true }).toJSON().cause).toBe(true);
        expect(new PreconditionViolationError('m', { cause: 10n }).toJSON().cause).toBe(10n);
        expect(new PreconditionViolationError('m', { cause: null }).toJSON().cause).toBe(null);
    });

    it('object causes are dropped rather than leaked', () => {
        const json = new PreconditionViolationError('m', {
            cause: { token: 'secret', detail: {} },
        }).toJSON();
        expect(json).not.toHaveProperty('cause');
    });

    it('undefined cause produces no cause key', () => {
        const json = new PreconditionViolationError('m', { cause: undefined }).toJSON();
        expect(json).not.toHaveProperty('cause');
    });

    it('toJSON output survives JSON.stringify', () => {
        const json = new PreconditionViolationError('m', {
            functionName: 'fn',
            conditionIndex: 1,
            context: { a: 'b' },
            cause: new Error('inner'),
        }).toJSON();
        expect(() => JSON.stringify(json)).not.toThrow();
        const roundTripped = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
        expect(roundTripped['kind']).toBe('precondition');
        expect(roundTripped['stack']).toBeUndefined();
    });
});

describe('contract() warn-mode dispatch', () => {
    beforeEach(() => {
        resetConfig();
    });

    it('violations reach onViolation with the same structured fields the error carries', () => {
        const captured: Error[] = [];
        configure({
            mode: 'warn',
            onViolation: (error) => {
                captured.push(error);
            },
        });
        const wrapped = contract((a: number, b: number) => a / b, {
            name: 'divideContract',
            pre: [
                condition((_a: number, b: number) => b !== 0, {
                    name: 'nonzero',
                    message: 'divisor must not be zero',
                }),
            ],
        });
        const result = wrapped(10, 0);
        // warn mode: execution continues, the wrapped function still runs
        expect(result).toBe(Infinity);
        expect(captured).toHaveLength(1);
        const err = captured[0] as PreconditionViolationError;
        expect(err).toBeInstanceOf(PreconditionViolationError);
        expect(err).toBeInstanceOf(ContractViolationError);
        expect(err.kind).toBe('precondition');
        expect(err.mode).toBe('warn');
        expect(err.contractName).toBe('divideContract');
        expect(err.functionName).toBe('anonymous');
        expect(err.conditionIndex).toBe(0);
        expect(err.conditionName).toBe('nonzero');
    });

    it('postcondition violations in warn mode also reach onViolation', () => {
        const captured: Error[] = [];
        configure({
            mode: 'warn',
            onViolation: (error) => {
                captured.push(error);
            },
        });
        const wrapped = contract(() => 21, {
            name: 'oddContract',
            post: [condition((result: number) => result % 2 === 0, { name: 'evenResult' })],
        });
        expect(wrapped()).toBe(21);
        expect(captured).toHaveLength(1);
        const err = captured[0] as PostconditionViolationError;
        expect(err).toBeInstanceOf(PostconditionViolationError);
        expect(err.kind).toBe('postcondition');
        expect(err.mode).toBe('warn');
        expect(err.conditionName).toBe('evenResult');
    });
});
