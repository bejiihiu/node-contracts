import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditRecord, ConditionFailure, NamedCondition } from '../src/index.js';
import {
    all,
    any,
    condition,
    contract,
    contractObject,
    isNamedCondition,
    mergeClassContracts,
    mergeContractOptions,
    not,
    OnErrorViolationError,
    PostconditionViolationError,
    PreconditionViolationError,
    resetConfig,
    withConfig,
} from '../src/index.js';

beforeEach(() => {
    resetConfig();
});

afterEach(() => {
    resetConfig();
    vi.restoreAllMocks();
});

describe('conditions — async predicates (checkAsync)', () => {
    it('all() awaits async predicates and passes when every child passes', async () => {
        const check = all(
            async () => true,
            async () => true,
        );
        await expect(check.checkAsync?.()).resolves.toBe(true);
        expect(check.lastFailure).toBeUndefined();
    });

    it('all() reports the first async failure (index 1), mirroring the sync path', async () => {
        const check = all(
            async () => true,
            async () => false,
            async () => false,
        );
        await expect(check.checkAsync?.()).resolves.toBe(false);
        expect(check.lastFailure?.operator).toBe('all');
        expect(check.lastFailure?.index).toBe(1);
    });

    it('all() does not invoke children after the first failure (short-circuit)', async () => {
        const later = vi.fn(async () => true);
        const check = all(async () => false, later);
        await expect(check.checkAsync?.()).resolves.toBe(false);
        expect(later).not.toHaveBeenCalled();
    });

    it('all() keeps sync short-circuit — a failing sync child stops before the async one', async () => {
        const asyncPred = vi.fn(async () => true);
        const check = all(() => false, asyncPred);
        await expect(check.checkAsync?.()).resolves.toBe(false);
        expect(asyncPred).not.toHaveBeenCalled();
    });

    it('any() passes on the second async child when the first fails', async () => {
        const order: string[] = [];
        const check = any(
            async () => {
                order.push('first');
                return false;
            },
            async () => {
                order.push('second');
                return true;
            },
        );
        await expect(check.checkAsync?.()).resolves.toBe(true);
        expect(order).toEqual(['first', 'second']);
    });

    it('any() fails with index -1 and per-child components when nothing passes', async () => {
        const check = any(
            async () => false,
            async () => false,
        );
        await expect(check.checkAsync?.()).resolves.toBe(false);
        expect(check.lastFailure?.operator).toBe('any');
        expect(check.lastFailure?.index).toBe(-1);
        expect(check.lastFailure?.components).toHaveLength(2);
        expect(check.lastFailure?.components?.[0]?.operator).toBe('any');
        expect(check.lastFailure?.components?.[0]?.index).toBe(0);
        expect(check.lastFailure?.components?.[1]?.index).toBe(1);
    });

    it('any() does not invoke children after the first pass (short-circuit)', async () => {
        const later = vi.fn(async () => false);
        const check = any(async () => true, later);
        await expect(check.checkAsync?.()).resolves.toBe(true);
        expect(later).not.toHaveBeenCalled();
    });

    it('not() negates an async predicate', async () => {
        const failing = not(async () => false);
        await expect(failing.checkAsync?.()).resolves.toBe(true);
        expect(failing.lastFailure).toBeUndefined();

        const passing = not(async () => true);
        await expect(passing.checkAsync?.()).resolves.toBe(false);
        expect(passing.lastFailure?.operator).toBe('not');
        expect(passing.lastFailure?.index).toBe(0);
    });

    it('nested composites settle in order: all(any(...), not(...))', async () => {
        const passing = all(
            any(
                async () => false,
                async () => true,
            ),
            not(async () => false),
        );
        await expect(passing.checkAsync?.()).resolves.toBe(true);

        const failing = all(
            any(
                async () => false,
                async () => false,
            ),
            not(async () => true),
        );
        await expect(failing.checkAsync?.()).resolves.toBe(false);
        expect(failing.lastFailure?.operator).toBe('all');
        expect(failing.lastFailure?.index).toBe(0);
        expect(failing.lastFailure?.cause?.operator).toBe('any');
    });

    it('bare async arrow predicates are normalized like named conditions', async () => {
        const check = all(
            async (n: number) => n > 0,
            async (n: number) => n < 100,
        );
        await expect(check.checkAsync?.(5)).resolves.toBe(true);
        await expect(check.checkAsync?.(150)).resolves.toBe(false);
    });

    it('a throwing predicate rejects checkAsync with the original error', async () => {
        const boom = new TypeError('predicate exploded');
        const check = all(async () => {
            throw boom;
        });
        await expect(check.checkAsync?.()).rejects.toBe(boom);
    });

    it('a fully synchronous composite leaves pendingVerdict undefined', () => {
        const check = all(
            () => false,
            () => true,
        );
        expect(check.check()).toBe(false);
        expect(check.pendingVerdict).toBeUndefined();
    });

    it('an async predicate hidden inside a composite sets pendingVerdict on check()', async () => {
        const check = all(async () => false); // async fn keyword — not detectable by ctor
        expect(check.check()).toBe(true); // thenable is truthy — vacuous pass, as documented for the sync path
        expect(check.pendingVerdict).toBeDefined();
        await expect(check.pendingVerdict).resolves.toBe(false);
        // awaiting refreshes lastFailure to the true verdict
        expect(check.lastFailure?.operator).toBe('all');
        expect(check.lastFailure?.index).toBe(0);
    });

    it('check() and checkAsync() both refresh lastFailure on transitions', async () => {
        const check = any(
            async () => false,
            async () => false,
        );
        await expect(check.checkAsync?.()).resolves.toBe(false);
        expect(check.lastFailure?.operator).toBe('any');
        const passing = any(async () => true);
        await expect(passing.checkAsync?.()).resolves.toBe(true);
        expect(passing.lastFailure).toBeUndefined();
    });

    it('a sync-promising winner that settles falsy resumes evaluation past it', async () => {
        const order: string[] = [];
        // x has a thenable, so the sync pass stops at index 0 (never sees y).
        // x settles false, so the async settlement must evaluate y fresh.
        const x = condition(
            async () => {
                order.push('x');
                return false;
            },
            { name: 'x' },
        );
        const y = condition(
            () => {
                order.push('y');
                return true;
            },
            { name: 'y' },
        );
        const disjunction = any(x, y);

        expect(disjunction.check()).toBe(true);
        expect(order).toEqual(['x']); // y has not run yet — sync short-circuit
        expect(disjunction.pendingVerdict).toBeDefined();
        // the resume path evaluates y fresh and settles the verdict
        await expect(disjunction.pendingVerdict).resolves.toBe(true);
        expect(order).toEqual(['x', 'y']);
        expect(disjunction.lastFailure).toBeUndefined();
    });

    it('composite verdicts settle in declaration order even with async children', async () => {
        const order: string[] = [];
        const check = all(
            async () => {
                order.push('first');
                return true;
            },
            async () => {
                order.push('second');
                return false;
            },
            async () => {
                order.push('third');
                return true;
            },
        );
        await expect(check.checkAsync?.()).resolves.toBe(false);
        expect(order).toEqual(['first', 'second']);
    });

    it('foreign NamedCondition without checkAsync is evaluated via its sync check()', async () => {
        const foreign = {
            _tag: 'design-contracts/condition',
            id: 'foreign-1',
            name: 'foreign',
            message: undefined,
            predicate: () => true,
            operator: undefined,
            components: undefined,
            lastFailure: undefined,
            check: () => true,
            [Symbol.for('design-contracts/named-condition')]: true,
        } as unknown as NamedCondition<[]>;
        expect(isNamedCondition(foreign)).toBe(true);

        const check = all(foreign);
        await expect(check.checkAsync?.()).resolves.toBe(true);
    });
});

describe('merged pre — async disjunction (Liskov, mergeContractOptions)', () => {
    const basePre = [condition(async (x: number) => x >= 1, { name: 'basePre' })];
    const derivedPre = [condition(async (x: number) => x <= 1000, { name: 'derivedPre' })];
    const nums = { name: 'numbers' } as const;

    const makeMerged = () => mergeContractOptions({ pre: basePre, ...nums }, { pre: derivedPre });

    it('produces a single composite disjunction condition', () => {
        const merged = makeMerged();
        expect(merged?.pre).toHaveLength(1);
        const disjunction = merged?.pre?.[0];
        if (disjunction === undefined || !isNamedCondition(disjunction)) {
            throw new Error('expected a named condition as the merged pre');
        }
        expect(disjunction.operator).toBe('any');
    });

    it('rescues a call when only the base side fails (derived pre passes)', async () => {
        const calls: number[] = [];
        const impl = async (x: number): Promise<number> => {
            calls.push(x);
            return x * 2;
        };
        const wrapped = contract(impl, makeMerged());
        await expect(wrapped(0)).resolves.toBe(0); // base fails (0 >= 1 is false), derived passes
        expect(calls).toEqual([0]);
    });

    it('rescues a call when only the derived side fails (base pre passes)', async () => {
        const calls: number[] = [];
        const impl = async (x: number): Promise<number> => {
            calls.push(x);
            return x * 2;
        };
        const wrapped = contract(impl, makeMerged());
        await expect(wrapped(5000)).resolves.toBe(10000); // base passes, derived fails
        expect(calls).toEqual([5000]);
    });

    it('rejects when both sides fail (the whole disjunction is falsy)', async () => {
        const same = { name: 'same' } as const;
        const merged = mergeContractOptions(
            { pre: [async (x: number) => x > 5], ...same },
            { pre: [async (x: number) => x > 5] },
        );
        const calls: number[] = [];
        const impl = async (x: number): Promise<number> => {
            calls.push(x);
            return x;
        };
        const wrapped = contract(impl, merged);
        await expect(wrapped(2)).rejects.toBeInstanceOf(PreconditionViolationError);
        expect(calls).toEqual([]);
    });

    it('both-fail violation carries the disjunction cause chain (any → all)', async () => {
        const same = { name: 'same' } as const;
        const merged = mergeContractOptions(
            { pre: [async (x: number) => x > 5], ...same },
            { pre: [async (x: number) => x > 5] },
        );
        const wrapped = contract(async (x: number): Promise<number> => x, merged);
        const caught = await wrapped(2).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(PreconditionViolationError);
        const cause = (caught as PreconditionViolationError).cause as ConditionFailure | undefined;
        expect(cause).toMatchObject({
            operator: 'any',
            index: -1,
        });
        const parts = cause?.components;
        expect(parts).toHaveLength(2);
        // each side of the disjunction failed through its own all() branch
        expect(parts?.[0]?.conditionName).toContain('all(');
        expect(parts?.[1]?.conditionName).toContain('all(');
    });

    it('keeps every predicate exactly once even on the failing path', async () => {
        const basePred = vi.fn(async (x: number) => x > 5);
        const derivedPred = vi.fn(async (x: number) => x > 5);
        const merged = mergeContractOptions(
            { pre: [basePred], name: 'base' },
            { pre: [derivedPred], name: 'derived' },
        );
        const impl = async (x: number): Promise<number> => x;
        const wrapped = contract(impl, merged);
        await expect(wrapped(2)).rejects.toBeInstanceOf(PreconditionViolationError);
        expect(basePred).toHaveBeenCalledTimes(1);
        expect(derivedPred).toHaveBeenCalledTimes(1);
    });

    it('skips the derived side when the base side already rescues the call', async () => {
        const derivedPred = vi.fn(async (x: number) => x <= 1000);
        const merged = mergeContractOptions(
            { pre: [async (x: number) => x >= 1], name: 'base' },
            { pre: [derivedPred], name: 'derived' },
        );
        const impl = async (x: number): Promise<number> => x;
        const wrapped = contract(impl, merged);
        await expect(wrapped(500)).resolves.toBe(500); // base passes — derived pre never runs
        expect(derivedPred).not.toHaveBeenCalled();
    });

    it('handles a mixed sides — async base, sync derived predicate', async () => {
        const derivedPred = vi.fn((x: number) => x <= 1000);
        const merged = mergeContractOptions(
            { pre: [async (x: number) => x >= 1], name: 'base' },
            { pre: [derivedPred], name: 'derived' },
        );
        const impl = async (x: number): Promise<number> => x;
        const wrapped = contract(impl, merged);
        await expect(wrapped(0)).resolves.toBe(0); // base fails, sync derived rescues
        expect(derivedPred).toHaveBeenCalledTimes(1);
    });

    it('reports the violation in audit mode without throwing and with durationMs', async () => {
        const records: AuditRecord[] = [];
        const same = { name: 'same' } as const;
        const merged = mergeContractOptions(
            { pre: [async (x: number) => x > 5], ...same },
            { pre: [async (x: number) => x > 5] },
        );
        const impl = async (x: number): Promise<number> => x;
        const wrapped = contract(impl, merged);
        const result = await withConfig(
            { mode: 'audit', onAudit: (record) => records.push(record) },
            () => wrapped(2),
        );
        expect(result).toBe(2); // audit never blocks the call
        expect(records).toHaveLength(1);
        expect(records[0]?.kind).toBe('precondition');
        expect(typeof records[0]?.durationMs).toBe('number');
        expect(records[0]?.durationMs ?? -1).toBeGreaterThanOrEqual(0);
    });
});

describe('merged pre disjunction — Liskov e2e via mergeClassContracts', () => {
    it('the derived override rescues what the base rejects, and vice versa', async () => {
        class Base {
            async describe(x: number): Promise<number> {
                return x * 2;
            }
        }
        Base.prototype.describe = contract(Base.prototype.describe, {
            pre: [async (x: number) => x >= 1],
        });

        class Derived extends Base {
            override async describe(x: number): Promise<number> {
                return x * 3;
            }
        }
        Derived.prototype.describe = contract(Derived.prototype.describe, {
            pre: [async (x: number) => x <= 1000],
        });

        mergeClassContracts(Derived, Base);

        await expect(new Derived().describe(0)).resolves.toBe(0); // base fails, derived rescues
        await expect(new Derived().describe(5000)).resolves.toBe(15000); // derived fails, base rescues
    });
});

describe('composite conditions inside contract sections', () => {
    it('composite in post passes with async predicates', async () => {
        const wrapped = contract(async () => 'value-ok', {
            post: [
                all(
                    async (r: string) => r.includes('ok'),
                    async (r: string) => r.startsWith('value'),
                ),
            ],
        });
        await expect(wrapped()).resolves.toBe('value-ok');
    });

    it('composite in post fails the call with PostconditionViolationError', async () => {
        const wrapped = contract(async () => 'nope', {
            post: [all(async (r: string) => r.includes('ok'))],
        });
        await expect(wrapped()).rejects.toBeInstanceOf(PostconditionViolationError);
    });

    it('a composite hiding an async predicate in post throws TypeError in a sync path', () => {
        const wrapped = contract(() => 42, { post: [all(async () => true)] });
        expect(() => wrapped()).toThrow(TypeError);
        expect(() => wrapped()).toThrow(/synchronous call path/);
    });

    it('a composite hiding an async predicate in pre throws TypeError in a sync path', () => {
        const impl = vi.fn(() => 'ok');
        const wrapped = contract(impl, { pre: [all(async () => true)] });
        expect(() => wrapped()).toThrow(TypeError);
        expect(() => wrapped()).toThrow(/synchronous call path/);
        expect(impl).not.toHaveBeenCalled();
    });

    it('on-error composite passes: the original error flies', async () => {
        const boom = new Error('boom');
        const wrapped = contract(
            async (): Promise<never> => {
                throw boom;
            },
            { onError: [all(async () => true)] },
        );
        const caught = await wrapped().catch((error: unknown) => error);
        expect(caught).toBe(boom);
    });

    it('on-error composite fails: OnErrorViolationError is reported', async () => {
        const wrapped = contract(
            async (): Promise<never> => {
                throw new Error('boom');
            },
            { onError: [all(async () => false)] },
        );
        await expect(wrapped()).rejects.toBeInstanceOf(OnErrorViolationError);
    });

    it('warn mode with an async composite failing in pre: fn still runs, onViolation called', async () => {
        const onViolation = vi.fn();
        const calls: number[] = [];
        const impl = async (x: number): Promise<number> => {
            calls.push(x);
            return x;
        };
        const wrapped = contract(impl, { pre: [all(async () => false)] });

        const result = await withConfig({ mode: 'warn', onViolation }, () => wrapped(42));

        expect(result).toBe(42);
        expect(calls).toEqual([42]);
        expect(onViolation).toHaveBeenCalledTimes(1);
        expect(onViolation.mock.calls[0]?.[0]).toBeInstanceOf(PreconditionViolationError);
    });

    it('merged disjunction in pre: side predicates run exactly once on the failing path', async () => {
        const hidden = vi.fn(async () => false);
        const calls: number[] = [];
        const impl = async (x: number): Promise<number> => {
            calls.push(x);
            return x;
        };
        const wrapped = contract(impl, { pre: [all(hidden)] });

        await expect(wrapped(1)).rejects.toBeInstanceOf(PreconditionViolationError);

        // the sync check() invocation ran it once; the async verdict reuses that run
        expect(hidden).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([]);
    });

    it('audit mode with a failing hidden async composite in pre still runs fn', async () => {
        const records: AuditRecord[] = [];
        const calls: number[] = [];
        const impl = async (x: number): Promise<number> => {
            calls.push(x);
            return x;
        };
        const wrapped = contract(impl, { pre: [all(async () => false)] });

        const result = await withConfig(
            { mode: 'audit', onAudit: (record) => records.push(record) },
            () => wrapped(7),
        );

        expect(result).toBe(7);
        expect(calls).toEqual([7]);
        expect(records).toHaveLength(1);
        expect(records[0]?.kind).toBe('precondition');
    });
});

describe('audit records carry durationMs', () => {
    it('precondition path (async fn, predicates reject the call)', async () => {
        const records: AuditRecord[] = [];
        const wrapped = contract(async () => 'value', { pre: [async () => false] });
        const result = await withConfig(
            { mode: 'audit', onAudit: (record) => records.push(record) },
            () => wrapped(),
        );
        expect(result).toBe('value'); // audit never throws
        expect(records).toHaveLength(1);
        expect(typeof records[0]?.durationMs).toBe('number');
        expect(records[0]?.durationMs ?? -1).toBeGreaterThanOrEqual(0);
    });

    it('postcondition path', async () => {
        const records: AuditRecord[] = [];
        const wrapped = contract(async () => 'value', { post: [() => false] });
        await withConfig({ mode: 'audit', onAudit: (record) => records.push(record) }, () =>
            wrapped(),
        );
        expect(records).toHaveLength(1);
        expect(records[0]?.kind).toBe('postcondition');
        expect(typeof records[0]?.durationMs).toBe('number');
        expect(records[0]?.durationMs ?? -1).toBeGreaterThanOrEqual(0);
    });

    it('on-error path', async () => {
        const records: AuditRecord[] = [];
        const boom = new Error('boom');
        const wrapped = contract(
            async (): Promise<never> => {
                throw boom;
            },
            { onError: [async () => false] },
        );
        const caught = await withConfig(
            { mode: 'audit', onAudit: (record) => records.push(record) },
            () => wrapped().catch((error: unknown) => error),
        );
        expect(caught).toBe(boom);
        expect(records).toHaveLength(1);
        expect(records[0]?.kind).toBe('on-error');
        expect(typeof records[0]?.durationMs).toBe('number');
        expect(records[0]?.durationMs ?? -1).toBeGreaterThanOrEqual(0);
    });

    it('invariant path (contractObject)', async () => {
        const records: AuditRecord[] = [];
        let ok = true;
        const account = contractObject({ balance: 10 }, { invariant: [() => ok], name: 'account' });
        ok = false;
        await withConfig({ mode: 'audit', onAudit: (record) => records.push(record) }, () => {
            account.balance = 20;
        });
        const setRecord = records.find((record) => record.functionName === '<set>');
        expect(setRecord).toBeDefined();
        expect(setRecord?.kind).toBe('invariant');
        expect(typeof setRecord?.durationMs).toBe('number');
        expect(setRecord?.durationMs ?? -1).toBeGreaterThanOrEqual(0);
    });

    it('strict mode does not crash when durationMs is required — it just throws as usual', async () => {
        const wrapped = contract(async () => 'value', { post: [() => false] });
        await expect(wrapped()).rejects.toBeInstanceOf(PostconditionViolationError);
    });
});
