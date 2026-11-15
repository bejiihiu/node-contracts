import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '../src/index.js';
import { configure, contractObject, InvariantViolationError, resetConfig } from '../src/index.js';

const catchError = (run: () => unknown): unknown => {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected the function to throw');
};

// hand-rolled gate so a test can hold an async method mid-flight
const makeGate = (): { open: () => void; closed: Promise<void> } => {
    let open!: () => void;
    const closed = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { open, closed };
};

describe('contractObject() method scope', () => {
    beforeEach(() => {
        resetConfig();
    });

    afterEach(() => {
        resetConfig();
        vi.restoreAllMocks();
    });

    it('throws InvariantViolationError on an external write while an async method is pending', async () => {
        const gate = makeGate();
        const account = contractObject(
            {
                balance: 100,
                async deposit(amount: number): Promise<void> {
                    await gate.closed;
                    this.balance += amount;
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'account' },
        );

        const pending = account.deposit(10);

        // outside the method's scope — the violation must surface right here
        const caught = catchError(() => {
            account.balance = -100;
        });
        expect(caught).toBeInstanceOf(InvariantViolationError);
        expect((caught as InvariantViolationError).functionName).toBe('<set>');
        expect((caught as InvariantViolationError).contractName).toBe('account');

        // the set still went through; repair the state so the settle check stays green
        account.balance = 50;

        gate.open();
        await expect(pending).resolves.toBeUndefined();
        expect(account.balance).toBe(60);
    });

    it('does not throw at the assignment site for a write inside an async method after await', async () => {
        const onViolation = vi.fn<(error: Error) => void>();
        configure({ mode: 'warn', onViolation });
        const account = contractObject(
            {
                balance: 100,
                async burn(): Promise<void> {
                    await Promise.resolve();
                    this.balance = -100; // in scope — must not throw here
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'burner' },
        );

        await expect(account.burn()).resolves.toBeUndefined();

        // reported exactly once, from the settle check — not at the assignment site
        expect(onViolation).toHaveBeenCalledTimes(1);
        const reported = onViolation.mock.calls[0]?.[0] as InvariantViolationError;
        expect(reported.functionName).toBe('burn');
    });

    it('settle check rejects the returned promise for an in-method write after await (strict)', async () => {
        const account = contractObject(
            {
                balance: 100,
                async burn(): Promise<void> {
                    await Promise.resolve();
                    this.balance = -100;
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'burner' },
        );

        const caught = await account.burn().catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(InvariantViolationError);
        // from the settle check (method boundary), not from the assignment site
        expect((caught as InvariantViolationError).functionName).toBe('burn');
    });

    it('checks an external write eagerly while two async methods work, settles green', async () => {
        const gateA = makeGate();
        const gateB = makeGate();
        const account = contractObject(
            {
                balance: 100,
                async bumpA(): Promise<void> {
                    await gateA.closed;
                    this.balance += 10;
                },
                async bumpB(): Promise<void> {
                    await gateB.closed;
                    this.balance += 20;
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'account' },
        );

        const pendingA = account.bumpA();
        const pendingB = account.bumpB();

        const caught = catchError(() => {
            account.balance = -1;
        });
        expect(caught).toBeInstanceOf(InvariantViolationError);
        expect((caught as InvariantViolationError).functionName).toBe('<set>');
        account.balance = 100;

        gateA.open();
        gateB.open();
        await expect(Promise.all([pendingA, pendingB])).resolves.toEqual([undefined, undefined]);
        expect(account.balance).toBe(130);
    });

    it('defers writes from nested wrapped-method calls to each settle boundary', async () => {
        const onAudit = vi.fn<(record: AuditRecord) => void>();
        configure({ mode: 'audit', onAudit });
        const probe = contractObject(
            {
                balance: 10,
                async inner(): Promise<void> {
                    await Promise.resolve();
                    this.balance = -5;
                },
                async outer(): Promise<void> {
                    await Promise.resolve();
                    await this.inner();
                    this.balance = -6;
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'nested' },
        );
        onAudit.mockClear(); // belt and braces — creation passes, but keep the signal clean

        await probe.outer();

        const names = onAudit.mock.calls.map(([record]) => record?.functionName);
        expect(names).toEqual(['inner', 'outer']);
    });

    it('does not suppress checks on a different wrapper while an async method is pending', async () => {
        const gate = makeGate();
        const a = contractObject(
            {
                balance: 100,
                async work(): Promise<void> {
                    await gate.closed;
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'a' },
        );
        const b = contractObject(
            { balance: 100 },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'b' },
        );

        const pending = a.work();

        const caught = catchError(() => {
            b.balance = -1;
        });
        expect(caught).toBeInstanceOf(InvariantViolationError);
        expect((caught as InvariantViolationError).contractName).toBe('b');

        gate.open();
        await pending;
    });

    it('a method writing to another contracted wrapper does not defer that wrapper’s set check', async () => {
        const b = contractObject(
            { balance: 100 },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'b' },
        );
        const a = contractObject(
            {
                balance: 1,
                async work(): Promise<void> {
                    await Promise.resolve();
                    b.balance = -1; // b's own methods are the only thing that may defer b's checks
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'a' },
        );

        const caught = await a.work().catch((error: unknown) => error);

        expect(caught).toBeInstanceOf(InvariantViolationError);
        expect((caught as InvariantViolationError).contractName).toBe('b');
        expect((caught as InvariantViolationError).functionName).toBe('<set>');
    });

    it('checks direct writes eagerly again once the async method has settled', async () => {
        const account = contractObject(
            {
                balance: 100,
                async noop(): Promise<void> {
                    await Promise.resolve();
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'account' },
        );

        await account.noop();

        const caught = catchError(() => {
            account.balance = -1;
        });
        expect(caught).toBeInstanceOf(InvariantViolationError);
        expect((caught as InvariantViolationError).functionName).toBe('<set>');
    });

    it('in warn mode an external write during a pending async method reports once and does not throw', async () => {
        const onViolation = vi.fn<(error: Error) => void>();
        configure({ mode: 'warn', onViolation });
        const gate = makeGate();
        const account = contractObject(
            {
                balance: 100,
                async waiting(): Promise<void> {
                    await gate.closed;
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'account' },
        );

        const pending = account.waiting();

        expect(() => {
            account.balance = -1;
        }).not.toThrow();
        expect(onViolation).toHaveBeenCalledTimes(1);
        const reported = onViolation.mock.calls[0]?.[0];
        expect(reported).toBeInstanceOf(InvariantViolationError);
        expect((reported as InvariantViolationError).functionName).toBe('<set>');

        account.balance = 100; // repair so the settle check stays quiet
        gate.open();
        await pending;
    });

    it('sync path is unchanged: a write inside a sync method defers to the settle check', () => {
        const onAudit = vi.fn<(record: AuditRecord) => void>();
        configure({ mode: 'audit', onAudit });
        const account = contractObject(
            {
                balance: 100,
                triple(): void {
                    this.balance = -1;
                    this.balance = -2;
                    this.balance = -3;
                },
            },
            { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'sync' },
        );
        onAudit.mockClear();

        account.triple();

        expect(onAudit).toHaveBeenCalledTimes(1);
        expect(onAudit.mock.calls[0]?.[0]?.functionName).toBe('triple');
    });
});
