import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord } from '../src/index.js';
import {
    all,
    ContractViolationError,
    condition,
    configure,
    contractObject,
    InvariantViolationError,
    resetConfig,
} from '../src/index.js';

const catchError = (run: () => unknown): unknown => {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected the function to throw');
};

interface AccountState {
    balance: number;
    withdraw(amount: number): void;
}

const makeAccount = (balance: number): AccountState => ({
    balance,
    withdraw(amount: number): void {
        this.balance -= amount;
    },
});

describe('contractObject()', () => {
    beforeEach(() => {
        resetConfig();
    });

    afterEach(() => {
        resetConfig();
        vi.restoreAllMocks();
    });

    describe('creation check (<init>)', () => {
        it('throws InvariantViolationError before the first method when the initial state violates an invariant', () => {
            const caught = catchError(() =>
                contractObject(makeAccount(-50), {
                    invariant: [(self) => self.balance >= 0],
                    name: 'account',
                }),
            );

            expect(caught).toBeInstanceOf(InvariantViolationError);
            expect(caught).toBeInstanceOf(ContractViolationError);
            const error = caught as InvariantViolationError;
            expect(error.kind).toBe('invariant');
            expect(error.functionName).toBe('<init>');
            expect(error.conditionIndex).toBe(0);
            expect(error.contractName).toBe('account');
            expect(error.mode).toBe('strict');
        });

        it('does not throw at creation when the initial state satisfies the invariants', () => {
            expect(() =>
                contractObject(makeAccount(100), { invariant: [(self) => self.balance >= 0] }),
            ).not.toThrow();
        });

        it('reports the index of the failing invariant at creation', () => {
            const caught = catchError(() =>
                contractObject(
                    { a: 1, b: 1 },
                    {
                        invariant: [(self) => self.a >= 0, (self) => self.b >= 10],
                        name: 'pair',
                    },
                ),
            );

            expect(caught).toBeInstanceOf(InvariantViolationError);
            expect((caught as InvariantViolationError).conditionIndex).toBe(1);
        });

        it('skips the creation check entirely in silent mode (canSkip honoured)', () => {
            configure({ mode: 'silent' });
            const predicate = vi.fn((self: { balance: number }) => self.balance >= 0);

            expect(() =>
                contractObject({ balance: -100 }, { invariant: [predicate] }),
            ).not.toThrow();
            expect(predicate).not.toHaveBeenCalled();
        });

        it('skips the creation check entirely in off mode (canSkip honoured)', () => {
            configure({ mode: 'off' });
            const predicate = vi.fn((self: { balance: number }) => self.balance >= 0);

            expect(() =>
                contractObject({ balance: -100 }, { invariant: [predicate] }),
            ).not.toThrow();
            expect(predicate).not.toHaveBeenCalled();
        });

        it('skips the creation check when invariant is in the disabled categories', () => {
            configure({ mode: 'strict', disabled: ['invariant'] });
            const predicate = vi.fn((self: { balance: number }) => self.balance >= 0);

            expect(() =>
                contractObject({ balance: -100 }, { invariant: [predicate] }),
            ).not.toThrow();
            expect(predicate).not.toHaveBeenCalled();
        });

        it('works with no invariant at all and with an empty invariant list', () => {
            const bare = contractObject({ balance: 0, deposit(): void {} });
            expect(() => bare.deposit()).not.toThrow();

            const empty = contractObject({ balance: 0, deposit(): void {} }, { invariant: [] });
            expect(() => empty.deposit()).not.toThrow();
        });
    });

    describe('method boundary', () => {
        it('runs invariants after every wrapped method and passes for a valid withdraw', () => {
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
                name: 'account',
            });

            account.withdraw(30);
            expect(account.balance).toBe(70);
        });

        it('throws InvariantViolationError with kind, functionName, conditionIndex after a violating method', () => {
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
                name: 'account',
            });

            const caught = catchError(() => account.withdraw(150));

            expect(caught).toBeInstanceOf(InvariantViolationError);
            expect(caught).toBeInstanceOf(ContractViolationError);
            const error = caught as InvariantViolationError;
            expect(error.kind).toBe('invariant');
            expect(error.functionName).toBe('withdraw');
            expect(error.conditionIndex).toBe(0);
            expect(error.contractName).toBe('account');
            expect(error.conditionName).toBe('anonymous');
        });

        it('uses the bare predicate’s own name for conditionName when it has one', () => {
            const predicate = (self: { balance: number }): boolean => self.balance >= 0;
            const account = contractObject(makeAccount(100), {
                invariant: [predicate],
                name: 'account',
            });

            const caught = catchError(() => account.withdraw(150));
            expect((caught as InvariantViolationError).conditionName).toBe('predicate');
        });

        it('carries the named condition name in conditionName and its message in the message', () => {
            const nonNegative = condition((self: AccountState) => self.balance >= 0, {
                name: 'nonNegativeBalance',
                message: 'balance may not go negative',
            });
            const account = contractObject(makeAccount(100), {
                invariant: [nonNegative],
                name: 'account',
            });

            const caught = catchError(() => account.withdraw(150));

            const error = caught as InvariantViolationError;
            expect(error.conditionName).toBe('nonNegativeBalance');
            expect(error.message).toContain('nonNegativeBalance');
            expect(error.message).toContain('balance may not go negative');
        });

        it('reports the composite name when an all() composite fails', () => {
            const first = condition((self: { balance: number }) => self.balance >= 0, {
                name: 'nonNegativeBalance',
            });
            const second = condition((self: { balance: number }) => self.balance < 1_000_000, {
                name: 'saneBalance',
            });
            const composite = all(first, second);
            const account = contractObject(makeAccount(10), {
                invariant: [composite],
                name: 'account',
            });

            const caught = catchError(() => account.withdraw(50));

            const error = caught as InvariantViolationError;
            expect(error.conditionName).toBe(composite.name);
            expect(error.conditionName).toContain('all(');
        });

        it('reports the first index when several invariants fail at creation', () => {
            const caught = catchError(() =>
                contractObject(
                    { balance: -10, poke(): void {} },
                    {
                        invariant: [
                            (self) => self.balance >= 0,
                            (self) => self.balance >= 1_000_000,
                        ],
                        name: 'probe',
                    },
                ),
            );
            expect((caught as InvariantViolationError).conditionIndex).toBe(0);
        });

        it('reports only the second invariant when the first one passes', () => {
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0, (self) => self.balance >= 90],
                name: 'account',
            });

            const caught = catchError(() => account.withdraw(40));

            const error = caught as InvariantViolationError;
            expect(error.conditionIndex).toBe(1);
        });

        it('lets a good method through and throws only after the bad method', () => {
            const pair = contractObject(
                {
                    balance: 100,
                    good(): number {
                        this.balance += 10;
                        return this.balance;
                    },
                    bad(): void {
                        this.balance = -1;
                    },
                },
                { invariant: [(self) => self.balance >= 0], name: 'pair' },
            );

            expect(pair.good()).toBe(110);
            expect(() => pair.bad()).toThrow(InvariantViolationError);
        });
    });

    describe('direct writes (<set>)', () => {
        it('checks invariants after a direct property write and reports functionName <set>', () => {
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
                name: 'account',
            });

            const caught = catchError(() => {
                account.balance = -1;
            });

            const error = caught as InvariantViolationError;
            expect(error.kind).toBe('invariant');
            expect(error.functionName).toBe('<set>');
            expect(error.conditionIndex).toBe(0);
        });

        it('does not throw for a direct write that keeps the invariant', () => {
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
            });

            expect(() => {
                account.balance = 40;
            }).not.toThrow();
            expect(account.balance).toBe(40);
        });

        it('reports a direct write through onViolation in warn mode instead of throwing', () => {
            const onViolation = vi.fn<(error: Error) => void>();
            configure({ mode: 'warn', onViolation });
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
                name: 'account',
            });

            expect(() => {
                account.balance = -1;
            }).not.toThrow();
            expect(onViolation).toHaveBeenCalledTimes(1);
            const reported = onViolation.mock.calls[0]?.[0];
            expect(reported).toBeInstanceOf(InvariantViolationError);
            expect((reported as InvariantViolationError).functionName).toBe('<set>');
        });
    });

    describe('method that throws', () => {
        it('still checks invariants; strict mode throws InvariantViolationError with the method error as cause', () => {
            const boom = new Error('database exploded');
            const breaking = contractObject(
                {
                    balance: 50,
                    explode(): never {
                        this.balance = -100;
                        throw boom;
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'account' },
            );

            const caught = catchError(() => breaking.explode());

            expect(caught).toBeInstanceOf(InvariantViolationError);
            expect(caught).not.toBe(boom);
            const error = caught as InvariantViolationError;
            expect(error.functionName).toBe('explode');
            expect(error.cause).toBe(boom);
        });

        it('lets the original error fly when the invariant holds after the throw', () => {
            const boom = new Error('database exploded');
            const breaking = contractObject(
                {
                    balance: 50,
                    explode(): never {
                        this.balance = 40;
                        throw boom;
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'account' },
            );

            const caught = catchError(() => breaking.explode());
            expect(caught).toBe(boom);
        });

        it('in warn mode the original error propagates and onViolation gets the violation', () => {
            const onViolation = vi.fn<(error: Error) => void>();
            configure({ mode: 'warn', onViolation });
            const boom = new Error('database exploded');
            const breaking = contractObject(
                {
                    balance: 50,
                    explode(): never {
                        this.balance = -100;
                        throw boom;
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'account' },
            );

            const caught = catchError(() => breaking.explode());

            expect(caught).toBe(boom);
            expect(onViolation).toHaveBeenCalledTimes(1);
            const reported = onViolation.mock.calls[0]?.[0];
            expect(reported).toBeInstanceOf(InvariantViolationError);
            expect((reported as InvariantViolationError).cause).toBe(boom);
        });
    });

    describe('async methods', () => {
        it('checks invariants after the promise resolves, not at call time', async () => {
            const events: string[] = [];
            const asyncAccount = contractObject(
                {
                    balance: 10,
                    async deposit(amount: number): Promise<number> {
                        events.push('fn');
                        this.balance += amount;
                        return this.balance;
                    },
                },
                {
                    invariant: [
                        (self) => {
                            events.push('check');
                            return self.balance >= 0;
                        },
                    ],
                    name: 'async-account',
                },
            );
            events.length = 0; // creation check is not under test here

            await expect(asyncAccount.deposit(5)).resolves.toBe(15);
            expect(events).toEqual(['fn', 'check']);
        });

        it('rejects the returned promise with InvariantViolationError in strict mode after an async violation', async () => {
            const gambler = contractObject(
                {
                    balance: 10,
                    async sweep(): Promise<void> {
                        this.balance = -50;
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'gambler' },
            );

            const p = gambler.sweep();
            expect(typeof p.then).toBe('function'); // no synchronous throw
            await expect(p).rejects.toBeInstanceOf(InvariantViolationError);
        });

        it('rejects with InvariantViolationError (cause = method error) when an async method rejects after half-mutating', async () => {
            const boom = new Error('async database exploded');
            const breaking = contractObject(
                {
                    balance: 10,
                    async explode(): Promise<never> {
                        this.balance = -50;
                        throw boom;
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'breaking' },
            );

            const caught = await breaking.explode().catch((error: unknown) => error);

            expect(caught).toBeInstanceOf(InvariantViolationError);
            expect((caught as InvariantViolationError).cause).toBe(boom);
        });

        it('rejects with the original error when an async method rejects and the invariant holds', async () => {
            const boom = new Error('async database exploded');
            const breaking = contractObject(
                {
                    balance: 10,
                    async explode(): Promise<never> {
                        this.balance = 5;
                        throw boom;
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'breaking' },
            );

            const caught = await breaking.explode().catch((error: unknown) => error);
            expect(caught).toBe(boom);
        });
    });

    describe('modes', () => {
        it('warn mode reports the violation to onViolation and lets execution continue', () => {
            const onViolation = vi.fn<(error: Error) => void>();
            configure({ mode: 'warn', onViolation });
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
                name: 'account',
            });

            expect(() => account.withdraw(150)).not.toThrow();
            expect(account.balance).toBe(-50);
            expect(onViolation).toHaveBeenCalledTimes(1);
            const reported = onViolation.mock.calls[0]?.[0];
            expect(reported).toBeInstanceOf(InvariantViolationError);
            expect((reported as InvariantViolationError).kind).toBe('invariant');
            expect((reported as InvariantViolationError).functionName).toBe('withdraw');
        });

        it('audit mode emits a kind=invariant record and does not throw', () => {
            const onAudit = vi.fn<(record: AuditRecord) => void>();
            configure({ mode: 'audit', onAudit });
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
                name: 'account',
            });
            onAudit.mockClear(); // reset the (passing) creation check noise, if any

            expect(() => account.withdraw(150)).not.toThrow();
            expect(onAudit).toHaveBeenCalledTimes(1);
            const record = onAudit.mock.calls[0]?.[0];
            expect(record?.kind).toBe('invariant');
            expect(record?.mode).toBe('audit');
            expect(record?.functionName).toBe('withdraw');
            expect(record?.conditionIndex).toBe(0);
            expect(record?.contractName).toBe('account');
            expect(typeof record?.timestamp).toBe('number');
        });

        it('silent mode never evaluates the predicates, even after a violating write and method', () => {
            configure({ mode: 'silent' });
            const predicate = vi.fn((self: { balance: number }) => self.balance >= 0);
            const target = contractObject(
                {
                    balance: 100,
                    burn(): void {
                        this.balance = -100;
                    },
                },
                { invariant: [predicate] },
            );

            target.burn();
            target.balance = -200;

            expect(predicate).not.toHaveBeenCalled();
        });

        it('off mode never evaluates the predicates, even after a violating write and method', () => {
            configure({ mode: 'off' });
            const predicate = vi.fn((self: { balance: number }) => self.balance >= 0);
            const target = contractObject(
                {
                    balance: 100,
                    burn(): void {
                        this.balance = -100;
                    },
                },
                { invariant: [predicate] },
            );

            target.burn();
            target.balance = -200;

            expect(predicate).not.toHaveBeenCalled();
        });

        it('does not evaluate predicates at all when invariant is disabled via config', () => {
            configure({ mode: 'strict', disabled: ['invariant'] });
            const predicate = vi.fn((self: { balance: number }) => self.balance >= 0);
            const target = contractObject(
                {
                    balance: 100,
                    burn(): void {
                        this.balance = -100;
                    },
                },
                { invariant: [predicate] },
            );

            expect(() => target.burn()).not.toThrow();
            expect(() => {
                target.balance = -100;
            }).not.toThrow();
            expect(predicate).not.toHaveBeenCalled();
        });

        it('per-object mode off wins over a strict global config', () => {
            configure({ mode: 'strict' });
            const predicate = vi.fn((self: { balance: number }) => self.balance >= 0);
            const account = contractObject(makeAccount(100), {
                invariant: [predicate],
                mode: 'off',
            });

            expect(() => account.withdraw(150)).not.toThrow();
            expect(account.balance).toBe(-50);
            expect(predicate).not.toHaveBeenCalled();
        });

        it('per-object mode strict wins over a global off config', () => {
            configure({ mode: 'off' });
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
                mode: 'strict',
            });

            expect(() => account.withdraw(150)).toThrow(InvariantViolationError);
        });
    });

    describe('this binding, nested calls', () => {
        it('binds this inside methods to the wrapper, not the target', () => {
            let captured: unknown;
            const target = {
                balance: 10,
                probe(): number {
                    captured = this;
                    return 1;
                },
            };
            const wrapper = contractObject(target, { invariant: [(self) => self.balance >= 0] });

            wrapper.probe();

            expect(captured).toBe(wrapper);
            expect(captured).not.toBe(target);
        });

        it('binds nested this.m() calls to the wrapper and checks once per method boundary', () => {
            const onAudit = vi.fn<(record: AuditRecord) => void>();
            configure({ mode: 'audit', onAudit });
            let innerSelf: unknown;
            let outerSelf: unknown;
            const target = contractObject(
                {
                    balance: 10,
                    inner(): void {
                        innerSelf = this;
                        this.balance = -5;
                    },
                    outer(): void {
                        outerSelf = this;
                        this.inner();
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'probe' },
            );

            target.outer();

            expect(innerSelf).toBe(target);
            expect(outerSelf).toBe(target);
            expect(onAudit).toHaveBeenCalledTimes(2);
            expect(onAudit.mock.calls.map(([record]) => record.functionName)).toEqual([
                'inner',
                'outer',
            ]);
        });

        it('reports exactly once for a method with several violating writes', () => {
            const onAudit = vi.fn<(record: AuditRecord) => void>();
            configure({ mode: 'audit', onAudit });
            const target = contractObject(
                {
                    balance: 100,
                    triple(): void {
                        this.balance = -1;
                        this.balance = -2;
                        this.balance = -3;
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'counter' },
            );
            onAudit.mockClear(); // ignore any init-time noise

            target.triple();

            expect(onAudit).toHaveBeenCalledTimes(1);
            expect(onAudit.mock.calls[0]?.[0]?.functionName).toBe('triple');
        });

        it('does not report an intermediate state that was violated and then recovered inside the method', () => {
            const onAudit = vi.fn<(record: AuditRecord) => void>();
            configure({ mode: 'audit', onAudit });
            const target = contractObject(
                {
                    balance: 100,
                    wiggle(): void {
                        this.balance = -1;
                        this.balance = 50;
                    },
                },
                { invariant: [(self: { balance: number }) => self.balance >= 0], name: 'wiggler' },
            );
            onAudit.mockClear();

            target.wiggle();

            expect(onAudit).not.toHaveBeenCalled();
        });
    });

    describe('extracted methods and identity', () => {
        it('keeps the wrapper binding when the method is extracted and called standalone', () => {
            const target: { balance: number; deposit(amount: number): number } = {
                balance: 0,
                deposit(amount: number): number {
                    this.balance += amount;
                    return this.balance;
                },
            };
            const wrapper = contractObject(target, {
                invariant: [(self) => self.balance >= 0],
                name: 'extracted',
            });

            const extracted = wrapper.deposit;
            expect(extracted(30)).toBe(30);
            expect(wrapper.balance).toBe(30);
        });

        it('enforces invariants on extracted method calls too', () => {
            const wrapper = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
                name: 'extracted',
            });

            const extracted = wrapper.withdraw;
            const caught = catchError(() => extracted(150));

            const error = caught as InvariantViolationError;
            expect(error.kind).toBe('invariant');
            expect(error.functionName).toBe('withdraw');
        });

        it('returns the same bound function object on repeated property access', () => {
            const wrapper = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0],
            });

            expect(wrapper.withdraw).toBe(wrapper.withdraw);
        });
    });

    describe('nested objects (documented limit)', () => {
        it('does not wrap nested objects; the nested write bypasses invariants', () => {
            const wrapper = contractObject(
                {
                    balance: 10,
                    nested: { count: 0 },
                    noop(): number {
                        return 1;
                    },
                },
                { invariant: [(self) => self.nested.count >= 0], name: 'nested-probe' },
            );

            // mutating the nested object directly — no set trap on the wrapper involved
            expect(() => {
                wrapper.nested.count = -1;
            }).not.toThrow();
        });

        it('catches the nested mutation at the next method boundary instead', () => {
            const wrapper = contractObject(
                {
                    balance: 10,
                    nested: { count: 0 },
                    noop(): number {
                        return 1;
                    },
                },
                { invariant: [(self) => self.nested.count >= 0], name: 'nested-probe' },
            );
            wrapper.nested.count = -1;

            const caught = catchError(() => wrapper.noop());
            expect(caught).toBeInstanceOf(InvariantViolationError);
        });
    });

    describe('re-entrancy', () => {
        it('does not recurse when an invariant writes to the wrapper itself', () => {
            const wrapper = contractObject(
                { balance: 100, touches: 0 },
                {
                    invariant: [
                        (self) => {
                            self.touches += 1;
                            return self.balance >= 0;
                        },
                    ],
                    name: 'reentrant',
                },
            );

            // the creation check ran the predicate exactly once and returned
            expect(wrapper.touches).toBe(1);

            wrapper.balance = 50;
            expect(wrapper.touches).toBe(2);
        });

        it('does not stack-overflow when a failing invariant writes to the wrapper', () => {
            expect(() =>
                contractObject(
                    { balance: -1, touches: 0 },
                    {
                        invariant: [
                            (self) => {
                                self.touches += 1;
                                return self.balance >= 0;
                            },
                        ],
                        name: 'reentrant-failing',
                    },
                ),
            ).toThrow(InvariantViolationError);
        });
    });

    describe('contractName resolution', () => {
        it('falls back to "object" for plain objects without an explicit name', () => {
            const caught = catchError(() =>
                contractObject({ balance: -5 }, { invariant: [(self) => self.balance >= 0] }),
            );
            expect((caught as InvariantViolationError).contractName).toBe('object');
        });

        it('uses the constructor name for class instances', () => {
            class BankAccount {
                balance = -5;
                deposit(): void {}
            }

            const caught = catchError(() =>
                contractObject(new BankAccount(), { invariant: [(self) => self.balance >= 0] }),
            );
            expect((caught as InvariantViolationError).contractName).toBe('BankAccount');
        });

        it('prefers the explicit options.name over the constructor name', () => {
            class BankAccount {
                balance = -5;
                deposit(): void {}
            }

            const caught = catchError(() =>
                contractObject(new BankAccount(), {
                    invariant: [(self) => self.balance >= 0],
                    name: 'primary-checking',
                }),
            );
            expect((caught as InvariantViolationError).contractName).toBe('primary-checking');
        });
    });

    describe('misc', () => {
        it('returns a new proxy identity, not the target', () => {
            const target = makeAccount(100);
            const wrapper = contractObject(target, { invariant: [(self) => self.balance >= 0] });
            expect(wrapper).not.toBe(target);
        });

        it('does not trigger invariant checks on reads (get is not a boundary)', () => {
            const predicate = vi.fn((self: AccountState) => self.balance >= 0);
            const wrapper = contractObject(makeAccount(100), { invariant: [predicate] });
            predicate.mockClear();

            void wrapper.balance;

            expect(predicate).not.toHaveBeenCalled();
        });

        it('lets a throwing predicate propagate unchanged instead of wrapping it', () => {
            const boom = new TypeError('predicate exploded');
            const caught = catchError(() =>
                contractObject(makeAccount(100), {
                    invariant: [
                        () => {
                            throw boom;
                        },
                    ],
                }),
            );
            expect(caught).toBe(boom);
        });

        it('keeps the same violation when both failing invariants report at the set boundary', () => {
            const account = contractObject(makeAccount(100), {
                invariant: [(self) => self.balance >= 0, (self) => self.balance >= 10],
                name: 'bothdown',
            });

            const caught = catchError(() => {
                account.balance = -1;
            });
            expect((caught as InvariantViolationError).conditionIndex).toBe(0);
        });
    });
});
