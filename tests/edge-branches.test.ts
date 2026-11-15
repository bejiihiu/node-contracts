import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// structural handle to node:diagnostics_channel — the repo compiles without
// ambient node types, so reach it the same way at runtime
interface DiagnosticsChannelSubset {
    channel(name: string | symbol): {
        subscribe(listener: (message: unknown) => void): void;
        unsubscribe(listener: (message: unknown) => void): void;
    };
}
const loadDiagnosticsChannelSubset = (): DiagnosticsChannelSubset => {
    const proc = (globalThis as { process?: unknown }).process as
        | { getBuiltinModule?: (id: string) => unknown }
        | undefined;
    const mod = proc?.getBuiltinModule?.('diagnostics_channel');
    if (
        mod !== null &&
        typeof mod === 'object' &&
        typeof (mod as { channel?: unknown }).channel === 'function'
    ) {
        return mod as DiagnosticsChannelSubset;
    }
    throw new Error('diagnostics_channel is not available on this runtime');
};
const dc = loadDiagnosticsChannelSubset();

// the repo compiles without ambient node types, so reach globals structurally
const testProcess = (
    globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process;
const testConsole = (
    globalThis as unknown as {
        console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
    }
).console;

import {
    auditLogObject,
    CONTRACTS_AUDIT_CHANNEL,
    CONTRACTS_VIOLATION_CHANNEL,
    diagnosticsChannelAdapter,
    diagnosticsChannelAuditAdapter,
    formatAudit,
    getAuditChannel,
    getViolationChannel,
    openTelemetryAdapter,
    openTelemetryAuditAdapter,
    pinoAdapter,
    winstonAdapter,
} from '../src/adapters/index.js';
import type { AuditRecord, NamedCondition } from '../src/index.js';
import {
    AssertionViolationError,
    all,
    any,
    captureValue,
    condition,
    configure,
    contract,
    InvariantViolationError,
    isNamedCondition,
    isReferenceCapture,
    not,
    PreconditionViolationError,
    resetConfig,
    sanitize,
    snapshotArgs,
    withConfig,
} from '../src/index.js';

import {
    canSkip,
    formatReport,
    getEffectiveConfig,
    reportViolation,
} from '../src/runtime/index.js';

beforeEach(() => {
    delete testProcess.env['NODE_CONTRACTS_MODE'];
    delete testProcess.env['NODE_ENV'];
    resetConfig();
});

afterEach(() => {
    resetConfig();
    vi.restoreAllMocks();
});

const catchError = (run: () => unknown): unknown => {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected the function to throw');
};

const warnOf = (spy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): string[] =>
    spy.mock.calls.map((call) => String(call[0]));

// the engine stores eval'd source text verbatim, so comments, escapes and
// template strings inside the parameter list survive toString() — plain
// function definitions can't offer that (the transformer strips comments)
const evalFn = <F extends (...args: never[]) => unknown>(source: string): F => {
    // biome-ignore lint/security/noGlobalEval: tests need the engine to keep the exact parameter-list source for the parameter-name scanner
    return eval(source) as F;
};

// hand-rolled structural condition without checkAsync() — the shape the
// evaluators fall back to when a foreign condition has no async path
const foreignCondition = (check: () => unknown, name = 'foreignEdge'): NamedCondition<[]> =>
    ({
        _tag: 'design-contracts/condition',
        id: `foreign-${name}`,
        name,
        message: undefined,
        predicate: () => true,
        operator: undefined,
        components: undefined,
        lastFailure: undefined,
        check,
        [Symbol.for('design-contracts/named-condition')]: true,
    }) as unknown as NamedCondition<[]>;

describe('formatReport — optional field arms', () => {
    it('renders the one-line report without contractName/functionName/conditionIndex', () => {
        expect(formatReport({ kind: 'invariant', message: 'bad things' })).toBe(
            '[design-contracts] invariant violation: bad things',
        );
    });

    it('renders the report with only one of contractName/functionName', () => {
        expect(formatReport({ kind: 'postcondition', message: 'm', contractName: 'billing' })).toBe(
            '[design-contracts] postcondition violation in billing: m',
        );
        expect(formatReport({ kind: 'postcondition', message: 'm', functionName: 'divide' })).toBe(
            '[design-contracts] postcondition violation in divide: m',
        );
    });
});

describe('warn fallback — handler failures and report kinds', () => {
    it('a non-Error thrown from onViolation is formatted via String() in the host error log', () => {
        const errorSpy = vi.spyOn(testConsole, 'error').mockImplementation(() => {});
        configure({
            mode: 'warn',
            onViolation: () => {
                // eslint-disable-next-line no-throw-literal
                throw 'plain-string-handler-boom';
            },
        });
        expect(() =>
            reportViolation({ kind: 'invariant', message: 'm' }, new InvariantViolationError('m')),
        ).not.toThrow();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0]?.[0])).toContain('plain-string-handler-boom');
    });

    it('warn mode without onViolation for an invariant violation writes the formatReport line', () => {
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        configure({ mode: 'warn' });
        reportViolation(
            { kind: 'invariant', message: 'invariant blew up' },
            new InvariantViolationError('invariant blew up'),
        );
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const line = String(warnSpy.mock.calls[0]?.[0]);
        expect(line).toContain('invariant violation');
        expect(line).toContain('invariant blew up');
        expect(line).not.toContain('(condition #');
    });
});

describe('silent/off modes — reportViolation is a no-op', () => {
    it('silent mode calls neither onViolation nor console.warn', () => {
        const onViolation = vi.fn();
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        configure({ mode: 'silent', onViolation });
        reportViolation({ kind: 'assertion', message: 'm' }, new AssertionViolationError('m'));
        expect(onViolation).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('off mode calls neither onViolation nor console.warn', () => {
        const onViolation = vi.fn();
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        configure({ mode: 'off', onViolation });
        reportViolation({ kind: 'assertion', message: 'm' }, new AssertionViolationError('m'));
        expect(onViolation).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

describe('strict mode with captureStack: false', () => {
    it('violation errors are thrown without a stack trace', () => {
        configure({ mode: 'strict', captureStack: false });
        const wrapped = contract(() => 1, {
            pre: [condition(() => false, { name: 'neverPasses' })],
        });
        const caught = catchError(() => wrapped());
        expect(caught).toBeInstanceOf(PreconditionViolationError);
        expect((caught as Error).stack).toBeUndefined();
    });

    it('the default keeps the stack trace', () => {
        configure({ mode: 'strict' });
        const wrapped = contract(() => 1, {
            pre: [condition(() => false, { name: 'neverPasses' })],
        });
        const caught = catchError(() => wrapped());
        expect(typeof (caught as Error).stack).toBe('string');
    });
});

describe('getEffectiveConfig — per-contract mode and cache identity', () => {
    it('returns the base resolution unchanged when the per-contract mode equals the resolved mode', () => {
        expect(getEffectiveConfig('strict')).toBe(getEffectiveConfig());
    });

    it('returns a cached per-mode override object on repeated calls', () => {
        const first = getEffectiveConfig('warn');
        const second = getEffectiveConfig('warn');
        expect(first).toBe(second);
        expect(first.mode).toBe('warn');
        expect(getEffectiveConfig('strict')).not.toBe(first);
    });

    it('per-contract mode overrides mode but keeps handlers', () => {
        const onViolation = vi.fn();
        configure({ mode: 'warn', onViolation });
        const overridden = getEffectiveConfig('off');
        expect(overridden.mode).toBe('off');
        expect(overridden.onViolation).toBe(onViolation);
    });

    it('inside a scope, an equal per-contract mode returns the scoped resolution', () => {
        withConfig({ mode: 'warn' }, () => {
            expect(getEffectiveConfig('warn')).toBe(getEffectiveConfig());
        });
    });
});

describe('disabled union — configure and nested withConfig layers', () => {
    it('configure({ disabled }) with two kinds disables exactly those', () => {
        configure({ disabled: ['precondition', 'assertion'] });
        expect(canSkip('precondition')).toBe(true);
        expect(canSkip('assertion')).toBe(true);
        expect(canSkip('postcondition')).toBe(false);
        expect(canSkip('invariant')).toBe(false);
    });

    it('nested withConfig layers union the disabled sets; the union does not escape the scope', () => {
        configure({ disabled: ['precondition'] });
        withConfig({ disabled: ['postcondition'] }, () => {
            expect(canSkip('precondition')).toBe(true);
            expect(canSkip('postcondition')).toBe(true);
            expect(canSkip('invariant')).toBe(false);
            expect([...getEffectiveConfig().disabled].sort()).toEqual([
                'postcondition',
                'precondition',
            ]);
        });
        expect(canSkip('precondition')).toBe(true);
        expect(canSkip('postcondition')).toBe(false);
    });

    it('an inner scope cannot re-enable a category disabled by an outer layer', () => {
        configure({ disabled: ['precondition'] });
        withConfig({ mode: 'strict' }, () => {
            expect(canSkip('precondition')).toBe(true);
        });
    });
});

describe('reportViolation — precondition audit records', () => {
    it('includes contractName/functionName/conditionIndex when present', () => {
        const records: AuditRecord[] = [];
        configure({
            mode: 'audit',
            onAudit: (record) => {
                records.push(record);
            },
        });
        reportViolation(
            {
                kind: 'precondition',
                message: 'divisor must not be zero',
                contractName: 'billing',
                functionName: 'divide',
                conditionIndex: 0,
            },
            new PreconditionViolationError('divisor must not be zero', {
                contractName: 'billing',
                functionName: 'divide',
                conditionIndex: 0,
            }),
        );
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            kind: 'precondition',
            contractName: 'billing',
            functionName: 'divide',
            conditionIndex: 0,
        });
    });

    it('omits contractName/functionName/conditionIndex when absent', () => {
        const records: AuditRecord[] = [];
        configure({
            mode: 'audit',
            onAudit: (record) => {
                records.push(record);
            },
        });
        reportViolation(
            { kind: 'precondition', message: 'nope' },
            new PreconditionViolationError('nope'),
        );
        expect(records).toHaveLength(1);
        const record = records[0] as AuditRecord;
        expect(record.kind).toBe('precondition');
        expect('contractName' in record).toBe(false);
        expect('functionName' in record).toBe(false);
        expect('conditionIndex' in record).toBe(false);
    });
});

describe('diagnostics_channel adapters — helpers and event shape', () => {
    it('getViolationChannel and getAuditChannel return the same channel on repeated calls', () => {
        expect(getViolationChannel()).toBe(getViolationChannel());
        expect(getAuditChannel()).toBe(getAuditChannel());
    });

    it('the violation adapter publishes the error object by reference', () => {
        const received: unknown[] = [];
        const nodeChannel = dc.channel(CONTRACTS_VIOLATION_CHANNEL);
        const listener = (message: unknown): void => {
            received.push(message);
        };
        nodeChannel.subscribe(listener);
        const violation = new PreconditionViolationError('divisor must not be zero');
        try {
            diagnosticsChannelAdapter()(violation);
        } finally {
            nodeChannel.unsubscribe(listener);
        }
        expect(received).toHaveLength(1);
        const event = received[0] as { violation: unknown };
        expect(Object.keys(event as object)).toEqual(['violation']);
        expect(event.violation).toBe(violation);
    });

    it('the audit adapter publishes the record object by reference with the expected shape', () => {
        const received: unknown[] = [];
        const nodeChannel = dc.channel(CONTRACTS_AUDIT_CHANNEL);
        const listener = (message: unknown): void => {
            received.push(message);
        };
        nodeChannel.subscribe(listener);
        const record: AuditRecord = {
            kind: 'postcondition',
            message: 'result was too small',
            timestamp: 1718000000000,
            mode: 'audit',
            durationMs: 12,
            contractName: 'billing',
            functionName: 'divide',
            conditionIndex: 1,
        };
        try {
            diagnosticsChannelAuditAdapter()(record);
        } finally {
            nodeChannel.unsubscribe(listener);
        }
        expect(received).toHaveLength(1);
        const event = received[0] as { record: AuditRecord };
        expect(Object.keys(event as object)).toEqual(['record']);
        expect(event.record).toBe(record);
        expect(event.record.durationMs).toBe(12);
        expect(event.record.conditionIndex).toBe(1);
    });

    it('creation fails fast when the channel factory returns an unusable channel', () => {
        // probe layer returns a module whose channel() yields a publish-less object
        const fakeModule = { channel: () => ({}) };
        vi.spyOn(
            testProcess as unknown as {
                getBuiltinModule(id: string): unknown;
            },
            'getBuiltinModule',
        ).mockReturnValue(fakeModule);
        expect(() => diagnosticsChannelAdapter()).toThrow(/unusable channel/);
    });
});

describe('old values — captureValue fallback matrix', () => {
    it('functions are captured by reference and reported as reference captures', () => {
        const fn = (): number => 1;
        expect(captureValue(fn)).toBe(fn);
        expect(isReferenceCapture(fn)).toBe(true);
    });

    it('a class instance holding an uncloneable member falls back to a reference capture', () => {
        class Hostile {
            readonly callback = (): number => 1;
        }
        const instance = new Hostile();
        const captured = captureValue(instance);
        expect(captured).toBe(instance);
        expect(isReferenceCapture(captured)).toBe(true);
    });

    it('an array with an uncloneable member is shallow-copied, not captured by reference', () => {
        const callback = (): number => 1;
        const original = [callback, (): void => {}];
        const captured = captureValue(original) as unknown[];
        expect(captured).not.toBe(original);
        expect(captured).toEqual(original);
        expect(captured[0]).toBe(callback);
        expect(isReferenceCapture(captured)).toBe(false);
    });

    it('a Map with an uncloneable member is copy-constructed, values shared', () => {
        const callback = (): number => 1;
        const original = new Map([['key', callback]]);
        const captured = captureValue(original) as Map<string, unknown>;
        expect(captured).not.toBe(original);
        expect(captured.get('key')).toBe(callback);
        expect(isReferenceCapture(captured)).toBe(false);
    });

    it('a Set with an uncloneable member is copy-constructed, values shared', () => {
        const callback = (): number => 1;
        const original = new Set([callback]);
        const captured = captureValue(original) as Set<unknown>;
        expect(captured).not.toBe(original);
        expect(captured.has(callback)).toBe(true);
        expect(isReferenceCapture(captured)).toBe(false);
    });

    it('cloned snapshots of Maps/Sets/arrays are independent of later mutation', () => {
        const map = new Map([['k', 'v']]);
        const clonedMap = captureValue(map) as Map<string, string>;
        map.set('k', 'mutated');
        expect(clonedMap.get('k')).toBe('v');

        const set = new Set([1, 2]);
        const clonedSet = captureValue(set) as Set<number>;
        set.add(3);
        expect(clonedSet.has(3)).toBe(false);

        const array = [1, 2];
        const clonedArray = captureValue(array) as number[];
        array.push(3);
        expect(clonedArray).toHaveLength(2);
    });

    it('bigint values pass through capture untouched', () => {
        expect(captureValue(42n)).toBe(42n);
        expect(typeof captureValue(42n)).toBe('bigint');
    });

    it('isReferenceCapture is false for primitives, null and plain clones', () => {
        expect(isReferenceCapture(null)).toBe(false);
        expect(isReferenceCapture(undefined)).toBe(false);
        expect(isReferenceCapture(42)).toBe(false);
        expect(isReferenceCapture('string')).toBe(false);
        expect(isReferenceCapture(true)).toBe(false);
        expect(isReferenceCapture(captureValue({ a: 1 }))).toBe(false);
    });
});

describe('old values — snapshotArgs array form', () => {
    it('an unknown parameter name is skipped with a one-time console.warn', () => {
        function needsOld(known: number, unknownArg: number): number {
            return known + unknownArg;
        }
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        const first = snapshotArgs(needsOld as never, [1, 2], ['known', 'zzzUnknown']);
        expect(first).toEqual({ known: 1 });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnOf(warnSpy)[0]).toContain('zzzUnknown');
        // second call with the same name does not warn again (warnedOnce)
        const second = snapshotArgs(needsOld as never, [3, 4], ['known', 'zzzUnknown']);
        expect(second).toEqual({ known: 3 });
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('a destructured object parameter carries no usable name and is skipped', () => {
        function destructured(
            { alpha, beta }: { alpha: number; beta: number },
            other: number,
        ): number {
            return alpha + beta + other;
        }
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        const snap = snapshotArgs(
            destructured as never,
            [{ alpha: 1, beta: 2 }, 3],
            ['alpha', 'other'],
        );
        expect(snap).toEqual({ other: 3 });
        expect(warnOf(warnSpy).some((line) => line.includes('alpha'))).toBe(true);
    });

    it('an array-destructured parameter carries no usable name and is skipped', () => {
        function arrayDestructured([first, ...rest]: number[], other: number): number {
            return (first ?? 0) + rest.length + other;
        }
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        const snap = snapshotArgs(arrayDestructured as never, [[1, 2, 3], 4], ['first', 'other']);
        expect(snap).toEqual({ other: 4 });
        expect(warnOf(warnSpy).some((line) => line.includes('first'))).toBe(true);
    });

    it('a rest parameter captures the whole tail of the arguments array', () => {
        function withRest(head: string, ...tail: number[]): number {
            return head.length + tail.length;
        }
        const snap = snapshotArgs(withRest as never, ['h', 1, 2, 3], ['head', 'tail']);
        expect(snap['head']).toBe('h');
        expect(snap['tail']).toEqual([1, 2, 3]);
        expect(isReferenceCapture(snap['tail'])).toBe(false);
    });

    it('bigint arguments snapshot as bigints', () => {
        function withBigint(value: bigint, ...rest: bigint[]): bigint {
            return rest.reduce((acc, item) => acc + item, value);
        }
        const snap = snapshotArgs(withBigint as never, [10n, 20n, 30n], ['value', 'rest']);
        expect(typeof snap['value']).toBe('bigint');
        expect(snap['value']).toBe(10n);
        expect(snap['rest']).toEqual([20n, 30n]);
    });

    it('an empty parameter list produces no slots and warns for every requested name', () => {
        const noParams = evalFn('(function noParams() { return 1; })') as (
            ...args: never[]
        ) => unknown;
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        const snap = snapshotArgs(noParams, [], ['anything']);
        expect(snap).toEqual({});
        expect(warnOf(warnSpy).some((line) => line.includes('noParams'))).toBe(true);
    });

    it('parameter segments that are only comments carry no usable name', () => {
        const commentOnly = evalFn('(function (/* nothing */ pos) { return pos; })') as (
            ...args: never[]
        ) => unknown;
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        const snap = snapshotArgs(commentOnly, ['p'], ['pos']);
        expect(snap).toEqual({});
        expect(warnOf(warnSpy).some((line) => line.includes('pos'))).toBe(true);
    });

    it('the warn label falls back to "anonymous function" for nameless functions', () => {
        const anonymous = evalFn('(function (first) { return first; })') as (
            ...args: never[]
        ) => unknown;
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        snapshotArgs(anonymous, ['a'], ['noSuchKey']);
        expect(warnOf(warnSpy).some((line) => line.includes('anonymous function'))).toBe(true);
    });
});

describe('old values — snapshotArgs with comments and strings inside the parameter list', () => {
    it('line comments and strings with escapes still yield parsable leading identifiers', () => {
        const weird = evalFn(
            '(function weird(first, // trailing note\n second) { return second; })',
        ) as (...args: unknown[]) => unknown;
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        const snap = snapshotArgs(weird as never, ['a', 'b'], ['first', 'second']);
        expect(snap).toEqual({ first: 'a' });
        // the parameter after a line comment is unparseable and is skipped with a warn
        expect(warnOf(warnSpy).some((line) => line.includes('second'))).toBe(true);
    });

    it('block comments and escaped quotes inside default values are skipped sanely', () => {
        const blocky = evalFn(
            '(function weirdBlock(value /* inline */, quoted = "x\\"y") { return quoted; })',
        ) as (...args: unknown[]) => unknown;
        const snap = snapshotArgs(blocky as never, ['a', 'b'], ['value', 'quoted']);
        expect(snap).toEqual({ value: 'a', quoted: 'b' });
    });

    it('single-quoted, double-quoted and backtick strings all survive the scanner', () => {
        const strings = evalFn(
            '(function weirdStrings(x = "a\\"b", y = \'it\\\'s\', z = `tpl {nested}`) { return z; })',
        ) as (...args: unknown[]) => unknown;
        const snap = snapshotArgs(strings as never, ['A', 'B', 'C'], ['x', 'y', 'z']);
        expect(snap).toEqual({ x: 'A', y: 'B', z: 'C' });
    });
});

describe('conditions — foreign structural conditions (no checkAsync)', () => {
    it('all() falls back to the foreign sync check() verdict via checkAsync', async () => {
        const foreignFalse = foreignCondition(() => false, 'foreignAll');
        expect(isNamedCondition(foreignFalse)).toBe(true);
        const composite = all(foreignFalse);
        await expect(composite.checkAsync?.()).resolves.toBe(false);
        expect(composite.lastFailure?.operator).toBe('all');
        // sync check agrees
        expect(composite.check()).toBe(false);
    });

    it('all() with a passing foreign condition resolves true', async () => {
        const foreignTrue = foreignCondition(() => true, 'foreignAllTrue');
        const composite = all(foreignTrue);
        await expect(composite.checkAsync?.()).resolves.toBe(true);
        expect(composite.lastFailure).toBeUndefined();
    });

    it('not() over a failing foreign condition resolves true', async () => {
        const composite = not(foreignCondition(() => false, 'foreignNotFalse'));
        await expect(composite.checkAsync?.()).resolves.toBe(true);
        expect(composite.lastFailure).toBeUndefined();
    });

    it('not() over a passing foreign condition resolves false with a not-failure', async () => {
        const composite = not(foreignCondition(() => true, 'foreignNotTrue'));
        await expect(composite.checkAsync?.()).resolves.toBe(false);
        expect(composite.lastFailure?.operator).toBe('not');
    });

    it('sync not() over a foreign condition uses the sync verdict', () => {
        const composite = not(foreignCondition(() => true, 'foreignSyncNot'));
        expect(composite.check()).toBe(false);
        expect(composite.lastFailure?.operator).toBe('not');
    });
});

describe('conditions — async predicates inside composites (pendingVerdict hand-off)', () => {
    it('all() records a pendingVerdict that settles to the final verdict', async () => {
        const composite = all(condition(async () => true, { name: 'asyncTrue' }));
        expect(composite.check()).toBe(true);
        expect(composite.pendingVerdict).toBeDefined();
        await expect(composite.pendingVerdict).resolves.toBe(true);
        expect(composite.lastFailure).toBeUndefined();
    });

    it('all() settles false when the async child settles false', async () => {
        const composite = all(condition(async () => false, { name: 'asyncFalse' }));
        // thenable counts as truthy synchronously; the settlement is recorded
        expect(composite.check()).toBe(true);
        await expect(composite.pendingVerdict).resolves.toBe(false);
        expect(composite.lastFailure?.operator).toBe('all');
    });

    it('all() mixes a pending async child with a sync child without re-running predicates', async () => {
        const syncPredicate = vi.fn(() => true);
        const composite = all(
            condition(async () => true, { name: 'asyncSide' }),
            condition(syncPredicate, { name: 'syncSide' }),
        );
        expect(composite.check()).toBe(true);
        await expect(composite.pendingVerdict).resolves.toBe(true);
        expect(syncPredicate).toHaveBeenCalledTimes(1);
    });

    it('not() hands off to the child pendingVerdict: settles true after the sync truthy pass', async () => {
        const composite = not(condition(async () => false, { name: 'asyncFalse' }));
        // sync verdict: thenable child counts as truthy, so the negation fails synchronously
        expect(composite.check()).toBe(false);
        expect(composite.lastFailure?.operator).toBe('not');
        expect(composite.pendingVerdict).toBeDefined();
        await expect(composite.pendingVerdict).resolves.toBe(true);
        expect(composite.lastFailure).toBeUndefined();
    });

    it('not() hands off to the child pendingVerdict: settles false when the child settles true', async () => {
        const composite = not(condition(async () => true, { name: 'asyncTrue' }));
        expect(composite.check()).toBe(false);
        await expect(composite.pendingVerdict).resolves.toBe(false);
        expect(composite.lastFailure?.operator).toBe('not');
    });

    it('any() re-evaluates children that were unseen because of the sync short-circuit', async () => {
        // the async child settles false; the sync short-circuit cut evaluation
        // before the second (failing) child ever ran — the settlement forces a fresh evaluation
        const unseen = condition(() => false, { name: 'unseenFalse' });
        const composite = any(
            condition(async () => false, { name: 'asyncFalse' }),
            unseen,
        );
        expect(composite.check()).toBe(true); // thenable is sync-truthy -> short-circuit pass
        await expect(composite.pendingVerdict).resolves.toBe(false);
        expect(composite.lastFailure?.operator).toBe('any');
        expect(composite.lastFailure?.components?.map((part) => part.conditionName)).toEqual([
            'asyncFalse',
            'unseenFalse',
        ]);
    });

    it('any() re-evaluation rescues the verdict when an unseen child passes', async () => {
        const composite = any(
            condition(async () => false, { name: 'asyncFalse' }),
            condition(() => true, { name: 'unseenTrue' }),
        );
        expect(composite.check()).toBe(true);
        await expect(composite.pendingVerdict).resolves.toBe(true);
        expect(composite.lastFailure).toBeUndefined();
    });

    it('any() skips the unseen-children sweep when the sync pass already ended in failure', async () => {
        const composite = any(
            all(
                condition(async () => false, { name: 'asyncFalse' }),
                condition(() => false, { name: 'syncFalse' }),
            ),
            condition(() => false, { name: 'syncFalseTwo' }),
        );
        expect(composite.check()).toBe(false);
        await expect(composite.pendingVerdict).resolves.toBe(false);
        expect(composite.lastFailure?.operator).toBe('any');
        expect(composite.lastFailure?.components).toHaveLength(2);
    });
});

describe('conditions — leaf async path and normalization', () => {
    it('checkAsync on a leaf condition settles and refreshes lastFailure', async () => {
        const failing = condition(async () => false, { name: 'asyncLeaf' });
        await expect(failing.checkAsync?.()).resolves.toBe(false);
        expect(failing.lastFailure?.operator).toBe('condition');
        expect(failing.lastFailure?.conditionName).toBe('asyncLeaf');

        const passing = condition(async () => true, { name: 'asyncLeafTrue' });
        await expect(passing.checkAsync?.()).resolves.toBe(true);
        expect(passing.lastFailure).toBeUndefined();
    });

    it('a bare predicate inside a composite is normalized into a named condition', () => {
        const composite = all(
            () => true,
            condition(() => true, { name: 'named' }),
        );
        expect(composite.components).toHaveLength(2);
        expect(composite.components?.[0]).toBeDefined();
        expect(isNamedCondition(composite.components?.[0])).toBe(true);
    });

    it('the composite .predicate function composes the sync verdict directly', () => {
        const andComposite = all(
            condition((n: number) => n > 0),
            condition((n: number) => n < 10),
        );
        expect(andComposite.predicate(5)).toBe(true);
        expect(andComposite.predicate(-1)).toBe(false);

        const orComposite = any(
            condition((n: number) => n > 0),
            condition((n: number) => n < -5),
        );
        expect(orComposite.predicate(-10)).toBe(true);
        expect(orComposite.predicate(-3)).toBe(false);

        const notComposite = not(condition((n: number) => n > 0));
        expect(notComposite.predicate(-1)).toBe(true);
        expect(notComposite.predicate(1)).toBe(false);
    });

    it('isNamedCondition rejects an object that carries _tag but no brand symbol', () => {
        const tagOnly = {
            _tag: 'design-contracts/condition',
            id: 'tag-only',
            name: 'tagOnly',
            check: () => true,
            predicate: () => true,
        };
        expect(isNamedCondition(tagOnly)).toBe(false);
    });
});

describe('sanitize — collections and nesting arms', () => {
    it('a Set is rendered as { type: "Set", size, values }', () => {
        expect(sanitize(new Set([1, 'two', 3n]))).toEqual({
            type: 'Set',
            size: 3,
            values: [1, 'two', '3n'],
        });
    });

    it('a Map is rendered as { type: "Map", size, entries }', () => {
        expect(
            sanitize(
                new Map<unknown, unknown>([
                    ['k', 'v'],
                    [2, true],
                ]),
            ),
        ).toEqual({
            type: 'Map',
            size: 2,
            entries: [
                ['k', 'v'],
                [2, true],
            ],
        });
    });

    it("a class instance additionally carries a '[type]' key with the constructor name", () => {
        class Invoice {
            readonly total = 100;
        }
        const out = sanitize(new Invoice()) as Record<string, unknown>;
        expect(out['[type]']).toBe('Invoice');
        expect(out['total']).toBe(100);
    });

    it('a class instance with an uncloneable member still sanitizes', () => {
        class WithCallback {
            readonly cb = (): number => 1;
        }
        const out = sanitize(new WithCallback()) as Record<string, unknown>;
        expect(out['[type]']).toBe('WithCallback');
        expect(out['cb']).toBe('[Function: cb]');
    });

    it('a Map beyond maxItems gets an overflow marker', () => {
        const out = sanitize(
            new Map([
                ['a', 1],
                ['b', 2],
            ]),
            { maxItems: 1 },
        ) as Record<string, unknown>;
        expect(out['overflow']).toBe(1);
        expect(out['entries']).toHaveLength(1);
    });

    it('a Set beyond maxItems gets an overflow marker', () => {
        const out = sanitize(new Set([1, 2]), { maxItems: 1 }) as Record<string, unknown>;
        expect(out['overflow']).toBe(1);
        expect(out['values']).toHaveLength(1);
    });

    it('bigint values inside objects serialize with an n suffix', () => {
        expect(sanitize({ total: 42n })).toEqual({ total: '42n' });
    });

    it('non-finite numbers inside objects become strings', () => {
        expect(sanitize({ inf: Infinity, nan: NaN, negInf: -Infinity })).toEqual({
            inf: 'Infinity',
            nan: 'NaN',
            negInf: '-Infinity',
        });
    });

    it("undefined values inside objects become '[undefined]' (keys are kept)", () => {
        expect(sanitize({ missing: undefined })).toEqual({ missing: '[undefined]' });
    });

    it("nesting past the default maxDepth (4) collapses into '[MaxDepth]'", () => {
        const out = sanitize({ a: { b: { c: { d: { e: 'leaf' } } } } }) as Record<string, unknown>;
        expect(out).toEqual({ a: { b: { c: { d: '[MaxDepth]' } } } });
    });

    it('symbols serialize with and without a description', () => {
        expect(sanitize(Symbol('named'))).toBe('[Symbol: named]');
        expect(sanitize(Symbol())).toBe('[Symbol]');
    });

    it("an anonymous function serializes as '[Function]'", () => {
        expect(sanitize(() => 1)).toBe('[Function]');
        expect(sanitize(function namedFn() {})).toBe('[Function: namedFn]');
    });

    it('null is passed through', () => {
        expect(sanitize(null)).toBeNull();
    });

    it('an ArrayBuffer is rendered with its byte length', () => {
        expect(sanitize(new ArrayBuffer(8))).toBe('[ArrayBuffer(8 bytes)]');
    });

    it("a view whose prototype was detached reports '[ArrayBuffer]' without byte length", () => {
        const view = new Uint8Array(4);
        Object.setPrototypeOf(view, null);
        expect(sanitize(view)).toBe('[ArrayBuffer]');
    });

    it("an object whose prototype has a non-function constructor keeps its keys but no '[type]'", () => {
        const proto = { constructor: 'not-a-function' };
        const input = Object.create(proto) as Record<string, unknown>;
        input['keep'] = 'me';
        const out = sanitize(input) as Record<string, unknown>;
        expect(out['keep']).toBe('me');
        expect('[type]' in out).toBe(false);
    });

    it("a constructor whose name was blanked out yields no '[type]' key", () => {
        const emptyNamed = (): void => {};
        Object.defineProperty(emptyNamed, 'name', { value: '' });
        const proto = { constructor: emptyNamed };
        const input = Object.create(proto) as Record<string, unknown>;
        input['keep'] = 'me';
        const out = sanitize(input) as Record<string, unknown>;
        expect(out['keep']).toBe('me');
        expect('[type]' in out).toBe(false);
    });

    it('a hostile constructor getter does not take the serializer down', () => {
        const proto = {};
        Object.defineProperty(proto, 'constructor', {
            get(): never {
                throw new Error('constructor getter boom');
            },
        });
        const input = Object.create(proto) as Record<string, unknown>;
        input['keep'] = 'me';
        const out = sanitize(input) as Record<string, unknown>;
        expect(out['keep']).toBe('me');
        expect(out['[type]']).toBe('Unknown');
    });
});

describe('formatAudit / auditLogObject — partial and full records', () => {
    const minimalRecord: AuditRecord = {
        kind: 'assertion',
        message: 'm',
        timestamp: 1718000000000,
        mode: 'audit',
    };
    const fullRecord: AuditRecord = {
        kind: 'postcondition',
        message: 'result was too small',
        timestamp: 1718000000000,
        mode: 'audit',
        durationMs: 5,
        contractName: 'billing',
        functionName: 'divide',
        conditionIndex: 2,
    };

    it('formatAudit renders a minimal record without any dangling parts', () => {
        const line = formatAudit(minimalRecord);
        expect(line).toBe('assertion audit: m');
        expect(line).not.toContain(' in ');
        expect(line).not.toContain('condition #');
    });

    it('formatAudit renders a full record with location and condition index', () => {
        const line = formatAudit(fullRecord);
        expect(line).toContain('postcondition audit');
        expect(line).toContain('billing / divide');
        expect(line).toContain('condition #2');
        expect(line).toContain('result was too small');
    });

    it('auditLogObject omits absent optional fields entirely', () => {
        const out = auditLogObject(minimalRecord);
        expect(out).toMatchObject({ kind: 'assertion', mode: 'audit', timestamp: 1718000000000 });
        expect('contractName' in out).toBe(false);
        expect('functionName' in out).toBe(false);
        expect('conditionIndex' in out).toBe(false);
        expect('durationMs' in out).toBe(false);
    });

    it('auditLogObject carries every present optional field', () => {
        const out = auditLogObject(fullRecord);
        expect(out).toEqual({
            kind: 'postcondition',
            mode: 'audit',
            timestamp: 1718000000000,
            contractName: 'billing',
            functionName: 'divide',
            conditionIndex: 2,
            durationMs: 5,
        });
    });
});

describe('openTelemetryAdapter — span resolution', () => {
    const makeSpan = (): {
        span: {
            addEvent(name: string, attributes?: Record<string, string | number | boolean>): unknown;
        };
        addEvent: ReturnType<typeof vi.fn>;
    } => {
        const addEvent = vi.fn();
        return { span: { addEvent }, addEvent };
    };

    it('getActiveSpan takes precedence over an explicitly passed span', () => {
        const explicit = makeSpan();
        const active = makeSpan();
        const adapter = openTelemetryAdapter(explicit.span, {
            getActiveSpan: () => active.span,
        });
        adapter(new PreconditionViolationError('m'));
        expect(active.addEvent).toHaveBeenCalledTimes(1);
        expect(explicit.addEvent).not.toHaveBeenCalled();
    });

    it('getActiveSpan returning undefined falls back to the explicitly passed span', () => {
        const explicit = makeSpan();
        const adapter = openTelemetryAdapter(explicit.span, {
            getActiveSpan: () => undefined,
        });
        adapter(new PreconditionViolationError('m'));
        expect(explicit.addEvent).toHaveBeenCalledTimes(1);
    });

    it('getActiveSpan returning undefined with no fallback drops the event silently', () => {
        const adapter = openTelemetryAdapter({ getActiveSpan: () => undefined });
        expect(() => adapter(new PreconditionViolationError('m'))).not.toThrow();
    });

    it('openTelemetryAdapter() with no arguments drops the event silently', () => {
        expect(() => openTelemetryAdapter()(new PreconditionViolationError('m'))).not.toThrow();
    });

    it('a null options argument throws a TypeError', () => {
        expect(() => openTelemetryAdapter(null as never)).toThrow(TypeError);
    });

    it('a non-function getActiveSpan throws a TypeError', () => {
        expect(() => openTelemetryAdapter({ getActiveSpan: 'nope' } as never)).toThrow(TypeError);
    });

    it('an options.span without addEvent throws a TypeError', () => {
        expect(() => openTelemetryAdapter({ span: {} as never })).toThrow(TypeError);
    });

    it('the audit adapter omits absent optional attributes entirely', () => {
        const { span, addEvent } = makeSpan();
        openTelemetryAuditAdapter(span)({
            kind: 'assertion',
            message: 'm',
            timestamp: 1718000000000,
            mode: 'audit',
        });
        expect(addEvent).toHaveBeenCalledTimes(1);
        const [name, attributes] = addEvent.mock.calls[0] as [
            string,
            Record<string, string | number | boolean>,
        ];
        expect(name).toBe('design-contracts.audit');
        expect(attributes).toEqual({
            kind: 'assertion',
            mode: 'audit',
            timestamp: 1718000000000,
        });
    });
});

describe('winstonAdapter / pinoAdapter — argument validation', () => {
    it('winstonAdapter(null) throws a TypeError at creation', () => {
        expect(() => winstonAdapter(null as never)).toThrow(TypeError);
    });

    it('winstonAdapter dispatches through a child bound via childBindings', () => {
        const childError = vi.fn();
        const child = { error: childError };
        const parentError = vi.fn();
        const fake = { error: parentError, child: vi.fn(() => child) };
        const adapter = winstonAdapter(fake as never, {
            childBindings: { service: 'worker' },
        });
        adapter(new PreconditionViolationError('m'));
        expect(fake.child).toHaveBeenCalledWith({ service: 'worker' });
        expect(childError).toHaveBeenCalledTimes(1);
        expect(parentError).not.toHaveBeenCalled();
    });

    it('pinoAdapter(null) throws a TypeError at creation', () => {
        expect(() => pinoAdapter(null as never)).toThrow(TypeError);
    });

    it('pinoAdapter with a non-function .child and childBindings throws a TypeError', () => {
        const fake = { child: 123, error: vi.fn() };
        expect(() => pinoAdapter(fake as never, { childBindings: { a: 1 } })).toThrow(TypeError);
    });
});
