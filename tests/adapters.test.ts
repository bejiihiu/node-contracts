import { afterEach, describe, expect, it, vi } from 'vitest';

// structural handle to node:diagnostics_channel: the repo compiles without
// ambient node types, so resolve it the same way at runtime, typed structurally
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
const channel = (name: string): ReturnType<DiagnosticsChannelSubset['channel']> => dc.channel(name);

import type { PinoLikeLogger, SpanEventLike, WinstonLikeLogger } from '../src/adapters/index.js';
import {
    CONTRACTS_AUDIT_CHANNEL,
    CONTRACTS_VIOLATION_CHANNEL,
    consoleAdapter,
    diagnosticsChannelAdapter,
    diagnosticsChannelAuditAdapter,
    formatViolation,
    openTelemetryAdapter,
    openTelemetryAuditAdapter,
    pinoAdapter,
    pinoAuditAdapter,
    winstonAdapter,
    winstonAuditAdapter,
} from '../src/adapters/index.js';
import type { AuditRecord } from '../src/index.js';
import { configure, contract, PreconditionViolationError, resetConfig } from '../src/index.js';

// the repo compiles without ambient node types, so reach console structurally
const testConsole = (
    globalThis as unknown as {
        console: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
    }
).console;

const divide = (a: number, b: number): number => a / b;

const makeViolation = (): PreconditionViolationError =>
    new PreconditionViolationError('amount must be positive', {
        contractName: 'billing',
        functionName: 'divide',
        conditionIndex: 0,
        conditionName: 'positive',
    });

const makeAuditRecord = (): AuditRecord => ({
    kind: 'precondition',
    message: 'precondition violated: divide (condition #0)',
    timestamp: 1718000000000,
    mode: 'audit',
    contractName: 'billing',
    functionName: 'divide',
    conditionIndex: 0,
    durationMs: 5,
});

const makeFakePino = (): {
    error: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    child?: ReturnType<typeof vi.fn>;
} => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
});

afterEach(() => {
    resetConfig();
    vi.restoreAllMocks();
});

describe('formatViolation', () => {
    it('renders a single line carrying kind, function and condition index', () => {
        const line = formatViolation(makeViolation());
        expect(line).not.toMatch(/\n/);
        expect(line).toContain('precondition');
        expect(line).toContain('divide');
        expect(line).toContain('condition #0');
    });

    it('includes contract, function, index and condition name when present', () => {
        const line = formatViolation(makeViolation());
        expect(line).toContain('billing');
        expect(line).toContain('divide');
        expect(line).toContain('condition #0');
        expect(line).toContain('[positive]');
        expect(line).toContain('amount must be positive');
    });

    it('omits absent parts without leaving dangling separators', () => {
        const bare = new PreconditionViolationError('plain failure');
        const line = formatViolation(bare);
        expect(line).toContain('precondition violation');
        expect(line).toContain('plain failure');
        expect(line).not.toMatch(/\s{2,}/);
        expect(line).not.toContain('condition #');
    });
});

describe('pinoAdapter', () => {
    it('writes through logger[level](meta, message) with err and structured fields', () => {
        const fake = makeFakePino();
        const violation = makeViolation();
        pinoAdapter(fake as unknown as PinoLikeLogger)(violation);
        expect(fake.error).toHaveBeenCalledTimes(1);
        const [meta, message] = fake.error.mock.calls[0] as [Record<string, unknown>, string];
        expect(meta['err']).toBe(violation);
        expect(meta['kind']).toBe('precondition');
        expect(meta['mode']).toBe('strict');
        expect(meta['functionName']).toBe('divide');
        expect(meta['conditionIndex']).toBe(0);
        expect(meta['conditionName']).toBe('positive');
        expect(String(message)).toContain('precondition violation');
    });

    it('does not include context by default', () => {
        const fake = makeFakePino();
        const withCtx = new PreconditionViolationError('m', { context: { user: 'ada' } });
        pinoAdapter(fake as unknown as PinoLikeLogger)(withCtx);
        const [meta] = fake.error.mock.calls[0] as [Record<string, unknown>];
        expect('context' in meta).toBe(false);
    });

    it('includeContext: true writes a sanitized (cycle-safe) context', () => {
        const fake = makeFakePino();
        const cyclic: Record<string, unknown> = { name: 'loop' };
        cyclic['self'] = cyclic;
        const withCtx = new PreconditionViolationError('m', { context: cyclic });
        pinoAdapter(fake as unknown as PinoLikeLogger, { includeContext: true })(withCtx);
        const [meta] = fake.error.mock.calls[0] as [Record<string, unknown>];
        const ctx = meta['context'] as Record<string, unknown>;
        expect(ctx['name']).toBe('loop');
        expect(ctx['self']).toBe('[Circular]');
    });

    it('honors a custom level option', () => {
        const fake = makeFakePino();
        const warnBound = fake.warn as unknown as ReturnType<typeof vi.fn>;
        pinoAdapter(fake as unknown as PinoLikeLogger, { level: 'warn' })(makeViolation());
        expect(warnBound).toHaveBeenCalledTimes(1);
        expect(fake.error).not.toHaveBeenCalled();
    });

    it('invalid level fails fast with TypeError at creation', () => {
        const fake = makeFakePino();
        expect(() => pinoAdapter(fake as unknown as PinoLikeLogger, { level: 'nope' })).toThrow(
            TypeError,
        );
    });

    it('childBindings binds a child once and logs through it', () => {
        const child = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
        const childFn = vi.fn(() => child);
        const fake = { ...makeFakePino(), child: childFn };
        pinoAdapter(fake as unknown as PinoLikeLogger, {
            childBindings: { service: 'worker' },
        })(makeViolation());
        expect(childFn).toHaveBeenCalledWith({ service: 'worker' });
        expect(child.error).toHaveBeenCalledTimes(1);
        expect(fake.error).not.toHaveBeenCalled();
    });

    it('childBindings without .child() is a TypeError at creation', () => {
        const fake = makeFakePino();
        expect(() =>
            pinoAdapter(fake as unknown as PinoLikeLogger, { childBindings: { a: 1 } }),
        ).toThrow(TypeError);
    });

    it('pinoAuditAdapter defaults to warn level and carries the audit record fields', () => {
        const fake = makeFakePino();
        pinoAuditAdapter(fake as unknown as PinoLikeLogger)(makeAuditRecord());
        expect(fake.warn).toHaveBeenCalledTimes(1);
        const [meta, message] = fake.warn.mock.calls[0] as [Record<string, unknown>, string];
        expect(meta['kind']).toBe('precondition');
        expect(meta['mode']).toBe('audit');
        expect(meta['timestamp']).toBe(1718000000000);
        expect(meta['durationMs']).toBe(5);
        expect(String(message)).toContain('audit');
    });
});

describe('winstonAdapter', () => {
    it('prefers the .log(level, message, meta) dispatch', () => {
        const fake = { log: vi.fn() };
        const violation = makeViolation();
        winstonAdapter(fake as unknown as WinstonLikeLogger)(violation);
        expect(fake.log).toHaveBeenCalledTimes(1);
        const [level, message, meta] = fake.log.mock.calls[0] as [
            string,
            string,
            Record<string, unknown>,
        ];
        expect(level).toBe('error');
        expect(String(message)).toContain('precondition violation');
        expect(meta['err']).toBe(violation);
        expect(meta['kind']).toBe('precondition');
    });

    it('falls back to logger[level](message, meta) when .log is absent', () => {
        const fake = { error: vi.fn() };
        const violation = makeViolation();
        winstonAdapter(fake as unknown as WinstonLikeLogger)(violation);
        expect(fake.error).toHaveBeenCalledTimes(1);
        const [message, meta] = fake.error.mock.calls[0] as [string, Record<string, unknown>];
        expect(String(message)).toContain('precondition violation');
        expect(meta['err']).toBe(violation);
    });

    it('without .log and without a matching level method it throws TypeError at creation', () => {
        expect(() => winstonAdapter({} as WinstonLikeLogger)).toThrow(TypeError);
    });

    it('childBindings without .child() is a TypeError at creation', () => {
        expect(() =>
            winstonAdapter({ error: vi.fn() } as unknown as WinstonLikeLogger, {
                childBindings: { a: 1 },
            }),
        ).toThrow(TypeError);
    });

    it('winstonAuditAdapter defaults to warn level and writes the audit meta', () => {
        const fake = { log: vi.fn() };
        winstonAuditAdapter(fake as unknown as WinstonLikeLogger)(makeAuditRecord());
        expect(fake.log).toHaveBeenCalledTimes(1);
        const [level, message, meta] = fake.log.mock.calls[0] as [
            string,
            string,
            Record<string, unknown>,
        ];
        expect(level).toBe('warn');
        expect(String(message)).toContain('audit');
        expect(meta['durationMs']).toBe(5);
        expect(meta['timestamp']).toBe(1718000000000);
        expect(meta['contractName']).toBe('billing');
    });

    it('winstonAuditAdapter hits the level-method branch too', () => {
        const fake = { warn: vi.fn() };
        winstonAuditAdapter(fake as unknown as WinstonLikeLogger)(makeAuditRecord());
        expect(fake.warn).toHaveBeenCalledTimes(1);
        const [message, meta] = fake.warn.mock.calls[0] as [string, Record<string, unknown>];
        expect(String(message)).toContain('audit');
        expect(meta['durationMs']).toBe(5);
    });
});

describe('openTelemetryAdapter', () => {
    const makeSpan = (): { span: SpanEventLike; addEvent: ReturnType<typeof vi.fn> } => {
        const addEvent = vi.fn();
        const span = { addEvent } as unknown as SpanEventLike;
        return { span, addEvent };
    };

    it('records span event design-contracts.violation with snake_case attributes', () => {
        const { span, addEvent } = makeSpan();
        openTelemetryAdapter(span)(makeViolation());
        expect(addEvent).toHaveBeenCalledTimes(1);
        const [name, attrs] = addEvent.mock.calls[0] as [
            string,
            Record<string, string | number | boolean>,
        ];
        expect(name).toBe('design-contracts.violation');
        expect(attrs).toEqual({
            kind: 'precondition',
            mode: 'strict',
            contract: 'billing',
            function: 'divide',
            condition_index: 0,
            condition_name: 'positive',
        });
    });

    it('resolves the span through getActiveSpan when provided', () => {
        const { span, addEvent } = makeSpan();
        openTelemetryAdapter({ getActiveSpan: () => span })(makeViolation());
        expect(addEvent).toHaveBeenCalledTimes(1);
    });

    it('getActiveSpan returning undefined with no fallback span drops silently', () => {
        const adapter = openTelemetryAdapter({ getActiveSpan: () => undefined });
        expect(() => adapter(makeViolation())).not.toThrow();
    });

    it('no span wired at all drops the event silently (no throw)', () => {
        expect(() => openTelemetryAdapter()(makeViolation())).not.toThrow();
    });

    it('getActiveSpan that throws falls back to the explicit span', () => {
        const { span, addEvent } = makeSpan();
        const adapter = openTelemetryAdapter(span, {
            getActiveSpan: () => {
                throw new Error('resolver boom');
            },
        });
        expect(() => adapter(makeViolation())).not.toThrow();
        expect(addEvent).toHaveBeenCalledTimes(1);
    });

    it('passing a tracer (startSpan without addEvent) is a TypeError at creation', () => {
        const tracer = { startSpan: vi.fn(() => ({})) };
        expect(() =>
            openTelemetryAdapter(tracer as unknown as Parameters<typeof openTelemetryAdapter>[0]),
        ).toThrow(TypeError);
    });

    it('two arguments with a non-span first argument is a TypeError', () => {
        expect(() => openTelemetryAdapter({} as never, {})).toThrow(TypeError);
    });

    it('includeContext: true serializes a cyclic context to a JSON string attribute', () => {
        const { span, addEvent } = makeSpan();
        const cyclic: Record<string, unknown> = { name: 'loop' };
        cyclic['self'] = cyclic;
        const withCtx = new PreconditionViolationError('m', { context: cyclic });
        openTelemetryAdapter(span, { includeContext: true })(withCtx);
        const [, attrs] = addEvent.mock.calls[0] as [string, Record<string, unknown>];
        const serialized = attrs['context'];
        expect(typeof serialized).toBe('string');
        expect(String(serialized)).toContain('[Circular]');
    });

    it('openTelemetryAuditAdapter emits design-contracts.audit with duration_ms and timestamp', () => {
        const { span, addEvent } = makeSpan();
        openTelemetryAuditAdapter(span)(makeAuditRecord());
        expect(addEvent).toHaveBeenCalledTimes(1);
        const [name, attrs] = addEvent.mock.calls[0] as [
            string,
            Record<string, string | number | boolean>,
        ];
        expect(name).toBe('design-contracts.audit');
        expect(attrs).toMatchObject({
            kind: 'precondition',
            mode: 'audit',
            contract: 'billing',
            function: 'divide',
            condition_index: 0,
            duration_ms: 5,
            timestamp: 1718000000000,
        });
    });
});

describe('diagnosticsChannelAdapter', () => {
    const subscribe = (name: string, collect: (message: unknown) => void): (() => void) => {
        const ch = channel(name);
        ch.subscribe(collect);
        return () => ch.unsubscribe(collect);
    };

    it('publishes { violation } on the default violation channel', () => {
        const received: unknown[] = [];
        const off = subscribe(CONTRACTS_VIOLATION_CHANNEL, (m) => received.push(m));
        try {
            diagnosticsChannelAdapter()(makeViolation());
        } finally {
            off();
        }
        expect(received).toHaveLength(1);
        const event = received[0] as { violation: unknown };
        expect(event.violation).toBeInstanceOf(PreconditionViolationError);
    });

    it('publishes { record } on the audit channel', () => {
        const received: unknown[] = [];
        const off = subscribe(CONTRACTS_AUDIT_CHANNEL, (m) => received.push(m));
        try {
            diagnosticsChannelAuditAdapter()(makeAuditRecord());
        } finally {
            off();
        }
        expect(received).toHaveLength(1);
        const event = received[0] as { record: AuditRecord };
        expect(event.record.durationMs).toBe(5);
        expect(event.record.timestamp).toBe(1718000000000);
    });

    it('custom channel names are honored', () => {
        const violationChannel = 'design-contracts:test-custom-violation';
        const auditChannel = 'design-contracts:test-custom-audit';
        const receivedViolation: unknown[] = [];
        const receivedAudit: unknown[] = [];
        const offViolation = subscribe(violationChannel, (m) => receivedViolation.push(m));
        const offAudit = subscribe(auditChannel, (m) => receivedAudit.push(m));
        try {
            diagnosticsChannelAdapter(violationChannel)(makeViolation());
            diagnosticsChannelAuditAdapter(auditChannel)(makeAuditRecord());
        } finally {
            offViolation();
            offAudit();
        }
        expect(receivedViolation).toHaveLength(1);
        expect(receivedAudit).toHaveLength(1);
    });

    it('blank channel names are rejected with TypeError', () => {
        expect(() => diagnosticsChannelAdapter('')).toThrow(TypeError);
        expect(() => diagnosticsChannelAdapter('   ')).toThrow(TypeError);
        expect(() => diagnosticsChannelAuditAdapter('')).toThrow(TypeError);
    });

    it('subscribers on different channels do not see each other’s events', () => {
        const received: unknown[] = [];
        const off = subscribe('design-contracts:test-isolated', (m) => received.push(m));
        try {
            diagnosticsChannelAdapter()(makeViolation());
        } finally {
            off();
        }
        expect(received).toHaveLength(0);
    });
});

describe('consoleAdapter', () => {
    it('prints a single prefixed line to console.error by default', () => {
        const errorSpy = vi.spyOn(testConsole, 'error').mockImplementation(() => undefined);
        consoleAdapter()(makeViolation());
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const line = String(errorSpy.mock.calls[0]?.[0]);
        expect(line.startsWith('[design-contracts] ')).toBe(true);
        expect(line).toContain('precondition violation');
        expect(line).toContain('condition #0');
        expect(line).not.toMatch(/\n/);
    });

    it('level: warn routes to console.warn', () => {
        const warnSpy = vi.spyOn(testConsole, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(testConsole, 'error').mockImplementation(() => undefined);
        consoleAdapter({ level: 'warn' })(makeViolation());
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('custom prefix is used verbatim', () => {
        const errorSpy = vi.spyOn(testConsole, 'error').mockImplementation(() => undefined);
        consoleAdapter({ prefix: 'contracts!' })(makeViolation());
        expect(String(errorSpy.mock.calls[0]?.[0]).startsWith('contracts! ')).toBe(true);
    });

    it('empty prefix prints the bare formatted line', () => {
        const errorSpy = vi.spyOn(testConsole, 'error').mockImplementation(() => undefined);
        consoleAdapter({ prefix: '' })(makeViolation());
        expect(String(errorSpy.mock.calls[0]?.[0]).startsWith('precondition violation')).toBe(true);
    });

    it('level other than warn/error is a TypeError at creation', () => {
        expect(() => consoleAdapter({ level: 'info' as never })).toThrow(TypeError);
    });
});

describe('adapter factories — return callable handlers', () => {
    it('every factory returns a function', () => {
        const fakePino = makeFakePino() as unknown as PinoLikeLogger;
        const fakeWinston = { log: vi.fn() } as unknown as WinstonLikeLogger;
        const factories: Array<() => unknown> = [
            () => pinoAdapter(fakePino),
            () => pinoAuditAdapter(fakePino),
            () => winstonAdapter(fakeWinston),
            () => winstonAuditAdapter(fakeWinston),
            () => openTelemetryAdapter(),
            () => openTelemetryAuditAdapter(),
            () => diagnosticsChannelAdapter(),
            () => diagnosticsChannelAuditAdapter(),
            () => consoleAdapter(),
        ];
        for (const factory of factories) {
            expect(typeof factory()).toBe('function');
        }
    });
});

describe('e2e — configure() wires adapters into the violation pipeline', () => {
    it('a contract violation in warn mode reaches the diagnostics channel subscriber', () => {
        const channelName = 'design-contracts:test-e2e-violation';
        const received: unknown[] = [];
        const listener = (message: unknown): void => {
            received.push(message);
        };
        // the runtime types onViolation as (error: Error) => void while the
        // adapters emit (violation: ContractViolationError) => void — not
        // assignable under strictFunctionTypes; cast to wire it (noted in notes.md)
        configure({
            mode: 'warn',
            onViolation: diagnosticsChannelAdapter(channelName) as unknown as (
                error: Error,
            ) => void,
        });
        const ch = channel(channelName);
        ch.subscribe(listener);
        try {
            const wrapped = contract(divide, { pre: [() => false] });
            expect(wrapped(10, 2)).toBe(5);
        } finally {
            ch.unsubscribe(listener);
            resetConfig();
        }
        expect(received).toHaveLength(1);
        const event = received[0] as { violation: unknown };
        expect(event.violation).toBeInstanceOf(PreconditionViolationError);
    });
});
