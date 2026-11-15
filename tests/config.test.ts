import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord, ContractConfig, ViolationCategory } from '../src/index.js';
import {
    AssertionViolationError,
    condition,
    configure,
    contract,
    getConfig,
    InvariantViolationError,
    PostconditionViolationError,
    PreconditionViolationError,
    resetConfig,
    withConfig,
} from '../src/index.js';
import {
    canSkip,
    formatReport,
    getEffectiveConfig,
    reportViolation,
} from '../src/runtime/index.js';

// the repo compiles without ambient node types, so reach globals structurally
const testProcess = (
    globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process;
const testConsole = (
    globalThis as unknown as {
        console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
    }
).console;

const ORIGINAL_ENV = {
    NODE_CONTRACTS_MODE: testProcess.env['NODE_CONTRACTS_MODE'],
    NODE_ENV: testProcess.env['NODE_ENV'],
};

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
});

afterEach(() => {
    resetConfig();
    vi.restoreAllMocks();
    if (ORIGINAL_ENV.NODE_CONTRACTS_MODE === undefined) {
        delete testProcess.env['NODE_CONTRACTS_MODE'];
    } else {
        testProcess.env['NODE_CONTRACTS_MODE'] = ORIGINAL_ENV.NODE_CONTRACTS_MODE;
    }
    if (ORIGINAL_ENV.NODE_ENV === undefined) {
        delete testProcess.env['NODE_ENV'];
    } else {
        testProcess.env['NODE_ENV'] = ORIGINAL_ENV.NODE_ENV;
    }
});

describe('environment resolution', () => {
    it('NODE_CONTRACTS_MODE=warn resolves to warn', () => {
        testProcess.env['NODE_CONTRACTS_MODE'] = 'warn';
        expect(getEffectiveConfig().mode).toBe('warn');
    });

    it('NODE_CONTRACTS_MODE accepts every known mode (case-insensitive, trimmed)', () => {
        for (const raw of ['strict', 'warn', 'silent', 'audit', 'off']) {
            testProcess.env['NODE_CONTRACTS_MODE'] = `  ${raw.toUpperCase()}  `;
            resetConfig();
            expect(getEffectiveConfig().mode).toBe(raw);
        }
    });

    it('NODE_ENV=production without NODE_CONTRACTS_MODE resolves to off', () => {
        testProcess.env['NODE_ENV'] = 'production';
        expect(getEffectiveConfig().mode).toBe('off');
    });

    it('NODE_ENV=development without NODE_CONTRACTS_MODE resolves to strict', () => {
        testProcess.env['NODE_ENV'] = 'development';
        expect(getEffectiveConfig().mode).toBe('strict');
    });

    it('empty NODE_CONTRACTS_MODE falls through to NODE_ENV resolution', () => {
        testProcess.env['NODE_CONTRACTS_MODE'] = '';
        testProcess.env['NODE_ENV'] = 'production';
        expect(getEffectiveConfig().mode).toBe('off');
    });

    it('unknown NODE_CONTRACTS_MODE falls back to strict and warns once per process', () => {
        testProcess.env['NODE_CONTRACTS_MODE'] = 'bogus';
        const warn = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        expect(getEffectiveConfig().mode).toBe('strict');
        expect(getEffectiveConfig().mode).toBe('strict');
        // re-resolution after a configure() must not re-warn either (flag is per process)
        configure({ defaultMessage: 'x' });
        expect(getEffectiveConfig().mode).toBe('strict');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain('bogus');
    });

    it('resetConfig re-arms the one-time unknown-mode warning', () => {
        testProcess.env['NODE_CONTRACTS_MODE'] = 'wat';
        const warn = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        expect(getEffectiveConfig().mode).toBe('strict');
        expect(warn).toHaveBeenCalledTimes(1);
        resetConfig();
        expect(getEffectiveConfig().mode).toBe('strict');
        expect(warn).toHaveBeenCalledTimes(2);
    });
});

describe('configure() validation', () => {
    it('rejects an unknown mode with TypeError', () => {
        expect(() => configure({ mode: 'verbose' as never })).toThrow(TypeError);
    });

    it('rejects a non-array disabled with TypeError', () => {
        expect(() => configure({ disabled: 'precondition' as never })).toThrow(TypeError);
    });

    it('rejects an unknown disabled category with TypeError', () => {
        expect(() => configure({ disabled: ['banana' as never] })).toThrow(TypeError);
    });

    it('rejects a non-function onViolation with TypeError', () => {
        expect(() => configure({ onViolation: 'yes' as never })).toThrow(TypeError);
    });

    it('rejects a non-function onAudit with TypeError', () => {
        expect(() => configure({ onAudit: 42 as never })).toThrow(TypeError);
    });

    it('rejects a non-boolean captureStack with TypeError', () => {
        expect(() => configure({ captureStack: 'yes' as never })).toThrow(TypeError);
    });

    it('rejects a non-string defaultMessage with TypeError', () => {
        expect(() => configure({ defaultMessage: 42 as never })).toThrow(TypeError);
    });

    it('rejects a non-object argument with TypeError', () => {
        expect(() => configure(null as never)).toThrow(TypeError);
        expect(() => configure('warn' as never)).toThrow(TypeError);
    });

    it('failing validation leaves the previous global configuration untouched', () => {
        configure({ mode: 'warn' });
        expect(() => configure({ mode: 'bogus' as never })).toThrow(TypeError);
        expect(getConfig().mode).toBe('warn');
    });
});

describe('configure() merging and return value', () => {
    it('merges over the existing global config', () => {
        configure({ mode: 'warn' });
        configure({ defaultMessage: 'nope' });
        const current = getConfig();
        expect(current.mode).toBe('warn');
        expect(current.defaultMessage).toBe('nope');
    });

    it('handlers from a later configure call override earlier ones', () => {
        const first = (): void => {};
        const second = (): void => {};
        configure({ onViolation: first });
        configure({ onViolation: second });
        expect(getConfig().onViolation).toBe(second);
    });

    it('returns the previous global configuration', () => {
        expect(configure({ mode: 'warn' })).toEqual({});
        expect(configure({ mode: 'audit', defaultMessage: 'fallback' })).toEqual({ mode: 'warn' });
    });

    it('returned previous config is a shallow copy, not live state', () => {
        configure({ disabled: ['precondition'] });
        const previous = configure({ mode: 'warn' });
        expect(previous.disabled).toEqual(['precondition']);
        (previous.disabled as ViolationCategory[]).push('invariant');
        // the copy handed out is detached from the internal union bookkeeping
        expect(getEffectiveConfig().disabled.has('invariant')).toBe(false);
    });

    it('getConfig returns a copy, not live global state', () => {
        configure({ disabled: ['postcondition'] });
        const a = getConfig();
        const b = getConfig();
        expect(a).not.toBe(b);
        expect(a.disabled).not.toBe(b.disabled);
        expect(a.disabled).toEqual(b.disabled);
    });

    it('configure({ mode: undefined }) does not clobber the current mode', () => {
        configure({ mode: 'warn' });
        configure({ mode: undefined } as unknown as ContractConfig);
        expect(getConfig().mode).toBe('warn');
    });

    it('resetConfig returns to the environment-driven empty global', () => {
        configure({ mode: 'silent', disabled: ['assertion'], defaultMessage: 'msg' });
        const previous = resetConfig();
        expect(previous.mode).toBe('silent');
        expect(getConfig()).toEqual({});
        expect(getEffectiveConfig().mode).toBe('strict'); // default env resolution
    });
});

describe('disabled union semantics', () => {
    it('unions disabled across the global and scope layers', () => {
        configure({ disabled: ['precondition'] });
        withConfig({ disabled: ['postcondition'] }, () => {
            const resolved = getEffectiveConfig();
            expect(resolved.disabled.has('precondition')).toBe(true);
            expect(resolved.disabled.has('postcondition')).toBe(true);
            expect(resolved.disabled.has('invariant')).toBe(false);
        });
    });

    it('an inner scope cannot re-enable what an outer layer disabled', () => {
        withConfig({ disabled: ['precondition'] }, () => {
            withConfig({ mode: 'warn' }, () => {
                expect(canSkip('precondition')).toBe(true);
            });
        });
    });

    it('unions disabled across three nesting levels', () => {
        withConfig({ disabled: ['precondition'] }, () => {
            withConfig({ disabled: ['postcondition'] }, () => {
                withConfig({ disabled: ['invariant'] }, () => {
                    const resolved = getEffectiveConfig();
                    expect(resolved.disabled.has('precondition')).toBe(true);
                    expect(resolved.disabled.has('postcondition')).toBe(true);
                    expect(resolved.disabled.has('invariant')).toBe(true);
                });
            });
        });
    });
});

describe('withConfig()', () => {
    it('inner layer wins over outer layer for mode', () => {
        withConfig({ mode: 'warn' }, () => {
            withConfig({ mode: 'audit' }, () => {
                expect(getEffectiveConfig().mode).toBe('audit');
            });
            expect(getEffectiveConfig().mode).toBe('warn');
        });
    });

    it('innermost of three nesting levels wins', () => {
        withConfig({ mode: 'warn' }, () => {
            withConfig({ mode: 'audit' }, () => {
                withConfig({ mode: 'silent' }, () => {
                    expect(getEffectiveConfig().mode).toBe('silent');
                });
            });
        });
    });

    it('scope is visible after await inside the callback', async () => {
        await withConfig({ mode: 'audit' }, async () => {
            await Promise.resolve();
            expect(getEffectiveConfig().mode).toBe('audit');
        });
        expect(getEffectiveConfig().mode).toBe('strict');
    });

    it('scope propagates through a promise-returning fn', async () => {
        const result = await withConfig({ mode: 'warn' }, () =>
            Promise.resolve().then(() => getEffectiveConfig().mode),
        );
        expect(result).toBe('warn');
    });

    it('scope does not leak outside the callback', () => {
        withConfig({ mode: 'off' }, () => {
            expect(getEffectiveConfig().mode).toBe('off');
        });
        expect(getEffectiveConfig().mode).toBe('strict');
    });

    it('returns the callback result untouched', () => {
        expect(withConfig({ mode: 'warn' }, () => 42)).toBe(42);
    });

    it('throws the callback error through untouched', () => {
        const boom = new Error('boom');
        expect(() =>
            withConfig({ mode: 'warn' }, () => {
                throw boom;
            }),
        ).toThrow(boom);
        expect(getEffectiveConfig().mode).toBe('strict');
    });

    it('rejects an invalid scoped config with TypeError', () => {
        expect(() => withConfig({ mode: 'nope' as never }, () => undefined)).toThrow(TypeError);
    });

    it('snapshots the config object on entry (later mutations do not leak in)', () => {
        const cfg: ContractConfig = { mode: 'warn' };
        withConfig(cfg, () => {
            cfg.mode = 'audit';
            expect(getEffectiveConfig().mode).toBe('warn');
        });
    });

    it('withConfig unions disabled with the global layer and unsets nothing', () => {
        configure({ disabled: ['assertion'] });
        withConfig({}, () => {
            expect(getEffectiveConfig().disabled.has('assertion')).toBe(true);
        });
    });
});

describe('canSkip()', () => {
    it('off skips every category', () => {
        configure({ mode: 'off' });
        for (const category of ALL_CATEGORIES) {
            expect(canSkip(category)).toBe(true);
        }
    });

    it('silent skips every category', () => {
        configure({ mode: 'silent' });
        for (const category of ALL_CATEGORIES) {
            expect(canSkip(category)).toBe(true);
        }
    });

    it('strict skips nothing', () => {
        configure({ mode: 'strict' });
        for (const category of ALL_CATEGORIES) {
            expect(canSkip(category)).toBe(false);
        }
    });

    it('warn skips nothing', () => {
        configure({ mode: 'warn' });
        for (const category of ALL_CATEGORIES) {
            expect(canSkip(category)).toBe(false);
        }
    });

    it('audit skips nothing', () => {
        configure({ mode: 'audit' });
        for (const category of ALL_CATEGORIES) {
            expect(canSkip(category)).toBe(false);
        }
    });

    it('disabled[precondition] skips only precondition', () => {
        configure({ mode: 'strict', disabled: ['precondition'] });
        expect(canSkip('precondition')).toBe(true);
        for (const category of ALL_CATEGORIES.filter((c) => c !== 'precondition')) {
            expect(canSkip(category)).toBe(false);
        }
    });

    it('a per-call contractMode of off skips even under a strict global', () => {
        configure({ mode: 'strict' });
        expect(canSkip('precondition', 'off')).toBe(true);
        expect(canSkip('invariant', 'silent')).toBe(true);
        expect(canSkip('assertion', 'warn')).toBe(false);
    });
});

describe('getEffectiveConfig() priority', () => {
    it('per-contract mode beats withConfig scope', () => {
        withConfig({ mode: 'warn' }, () => {
            expect(getEffectiveConfig('audit').mode).toBe('audit');
        });
    });

    it('per-contract mode beats global configure()', () => {
        configure({ mode: 'warn' });
        expect(getEffectiveConfig('audit').mode).toBe('audit');
    });

    it('per-contract mode beats env', () => {
        testProcess.env['NODE_CONTRACTS_MODE'] = 'warn';
        expect(getEffectiveConfig('audit').mode).toBe('audit');
    });

    it('withConfig scope beats global configure()', () => {
        configure({ mode: 'audit' });
        withConfig({ mode: 'warn' }, () => {
            expect(getEffectiveConfig().mode).toBe('warn');
        });
    });

    it('withConfig scope beats env', () => {
        testProcess.env['NODE_CONTRACTS_MODE'] = 'off';
        withConfig({ mode: 'warn' }, () => {
            expect(getEffectiveConfig().mode).toBe('warn');
        });
    });

    it('global configure() beats env', () => {
        testProcess.env['NODE_CONTRACTS_MODE'] = 'off';
        configure({ mode: 'warn' });
        expect(getEffectiveConfig().mode).toBe('warn');
    });

    it('env is used when nothing else is set', () => {
        testProcess.env['NODE_CONTRACTS_MODE'] = 'audit';
        expect(getEffectiveConfig().mode).toBe('audit');
    });
});

describe('resolution cache invalidation', () => {
    it('configure() invalidates the cache immediately (next call sees the new mode)', () => {
        expect(getEffectiveConfig().mode).toBe('strict');
        configure({ mode: 'warn' });
        expect(getEffectiveConfig().mode).toBe('warn');
        configure({ mode: 'audit' });
        expect(getEffectiveConfig().mode).toBe('audit');
    });

    it('configure() invalidates the cache for canSkip() too', () => {
        expect(canSkip('precondition')).toBe(false);
        configure({ mode: 'off' });
        expect(canSkip('precondition')).toBe(true);
    });

    it('resetConfig() invalidates the cache', () => {
        configure({ mode: 'off' });
        expect(getEffectiveConfig().mode).toBe('off');
        resetConfig();
        expect(getEffectiveConfig().mode).toBe('strict');
    });
});

describe('audit records', () => {
    it('audit mode emits a record with the expected shape', () => {
        const records: AuditRecord[] = [];
        configure({
            mode: 'audit',
            onAudit: (record) => {
                records.push(record);
            },
        });
        const error = new AssertionViolationError('bad state', {
            contractName: 'reconcile',
            functionName: 'step',
            conditionIndex: 2,
        });
        reportViolation(
            {
                kind: 'assertion',
                message: 'assertion blew up',
                contractName: 'reconcile',
                functionName: 'step',
                conditionIndex: 2,
                durationMs: 42,
            },
            error,
        );
        expect(records).toHaveLength(1);
        const record = records[0];
        expect(record?.kind).toBe('assertion');
        expect(record?.message).toBe('assertion blew up');
        expect(record?.mode).toBe('audit');
        expect(typeof record?.timestamp).toBe('number');
        expect(record?.timestamp).toBeGreaterThan(0);
        expect(record?.durationMs).toBe(42);
        expect(record?.contractName).toBe('reconcile');
        expect(record?.functionName).toBe('step');
        expect(record?.conditionIndex).toBe(2);
    });

    it('optional audit fields are omitted when the report does not carry them', () => {
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
        const record = records[0];
        expect(record?.kind).toBe('precondition');
        expect('durationMs' in (record as object)).toBe(false);
        expect('contractName' in (record as object)).toBe(false);
        expect('functionName' in (record as object)).toBe(false);
        expect('conditionIndex' in (record as object)).toBe(false);
    });

    it('audit mode also forwards the violation error to onViolation', () => {
        const violations: Error[] = [];
        configure({
            mode: 'audit',
            onAudit: () => {},
            onViolation: (error) => {
                violations.push(error);
            },
        });
        reportViolation(
            { kind: 'postcondition', message: 'm' },
            new PostconditionViolationError('m'),
        );
        expect(violations).toHaveLength(1);
    });

    it('a throwing onAudit handler is swallowed and logged to console.error', () => {
        const errorSpy = vi.spyOn(testConsole, 'error').mockImplementation(() => {});
        configure({
            mode: 'audit',
            onAudit: () => {
                throw new Error('audit handler boom');
            },
        });
        expect(() =>
            reportViolation({ kind: 'invariant', message: 'm' }, new InvariantViolationError('m')),
        ).not.toThrow();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0]?.[0])).toContain('onAudit handler threw');
    });
});

describe('warn fallback and handler failures', () => {
    it('formatReport renders a compact single-line report', () => {
        const line = formatReport({
            kind: 'precondition',
            message: 'divisor must not be zero',
            contractName: 'divideContract',
            functionName: 'divide',
            conditionIndex: 0,
        });
        expect(typeof line).toBe('string');
        expect(line).not.toContain('\n');
        expect(line).toContain('precondition');
        expect(line).toContain('divideContract');
        expect(line).toContain('divide');
        expect(line).toContain('condition #0');
        expect(line).toContain('divisor must not be zero');
    });

    it('warn without onViolation falls back to a single console.warn line', () => {
        const warn = vi.spyOn(testConsole, 'warn').mockImplementation(() => {});
        configure({ mode: 'warn' });
        reportViolation(
            {
                kind: 'precondition',
                message: 'bad things happened',
                contractName: 'c',
                functionName: 'f',
                conditionIndex: 1,
            },
            new InvariantViolationError('bad things happened'),
        );
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0]?.[0]);
        expect(line).not.toContain('\n');
        expect(line).toContain('precondition');
        expect(line).toContain('c / f');
        expect(line).toContain('condition #1');
        expect(line).toContain('bad things happened');
    });

    it('a throwing onViolation handler in warn mode is swallowed, logged and execution continues', () => {
        const errorSpy = vi.spyOn(testConsole, 'error').mockImplementation(() => {});
        const fn = vi.fn((x: number) => x * 2);
        configure({
            mode: 'warn',
            onViolation: () => {
                throw new Error('handler boom');
            },
        });
        const wrapped = contract(fn, {
            pre: [condition((x: number) => x > 10, { name: 'big' })],
        });
        expect(() => wrapped(1)).not.toThrow();
        // warn mode: the wrapped function still ran to completion
        expect(fn).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0]?.[0])).toContain('onViolation handler threw');
    });

    it('a throwing onViolation handler in audit mode is swallowed and logged too', () => {
        const errorSpy = vi.spyOn(testConsole, 'error').mockImplementation(() => {});
        configure({
            mode: 'audit',
            onAudit: () => {},
            onViolation: () => {
                throw new Error('handler boom');
            },
        });
        expect(() =>
            reportViolation({ kind: 'assertion', message: 'm' }, new AssertionViolationError('m')),
        ).not.toThrow();
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0]?.[0])).toContain('onViolation handler threw');
    });

    it('postcondition violation error thrown in warn mode does not break the caller', () => {
        const errors: Error[] = [];
        configure({
            mode: 'warn',
            onViolation: (error) => {
                errors.push(error);
            },
        });
        const wrapped = contract(() => 1, {
            post: [condition((result: number) => result > 5, { name: 'bigEnough' })],
        });
        expect(wrapped()).toBe(1);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(PostconditionViolationError);
    });
});
