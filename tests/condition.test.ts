import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConditionFailure, NamedCondition } from '../src/index.js';
import {
    all,
    any,
    condition,
    isNamedCondition,
    not,
    safeSerialize,
    sanitize,
} from '../src/index.js';

afterEach(() => {
    vi.restoreAllMocks();
});

const failureOf = (c: NamedCondition<unknown[]>): ConditionFailure | undefined => c.lastFailure;

describe('condition() — creation and name/id resolution', () => {
    it('explicit options.name wins over predicate.name', () => {
        function namedPred(): boolean {
            return true;
        }
        expect(condition(namedPred, { name: 'explicit' }).name).toBe('explicit');
        expect(condition(namedPred).name).toBe('namedPred');
    });

    it('falls back to predicate.name and then to anonymous', () => {
        expect(
            condition(function helperPredicate(): boolean {
                return true;
            }).name,
        ).toBe('helperPredicate');
        expect(condition((): boolean => true).name).toBe('anonymous');
    });

    it('explicit name with surrounding whitespace is trimmed; blank falls back', () => {
        const cond = condition(() => true, { name: '   ' });
        expect(cond.name).toBe('anonymous');
        expect(condition(() => true, { name: '  padded  ' }).name).toBe('padded');
    });

    it('auto id matches condition-N format and increases monotonically', () => {
        const first = condition(() => true);
        const second = condition(() => true);
        expect(first.id).toMatch(/^condition-\d+$/);
        expect(second.id).toMatch(/^condition-\d+$/);
        const n = (id: string): number => Number(id.slice('condition-'.length));
        expect(n(second.id)).toBeGreaterThan(n(first.id));
    });

    it('explicit id is used as-is', () => {
        expect(condition(() => true, { id: 'precondition:email' }).id).toBe('precondition:email');
    });

    it('message comes from options; undefined otherwise', () => {
        expect(condition(() => true, { message: 'nope lol' }).message).toBe('nope lol');
        expect(condition(() => true).message).toBeUndefined();
    });

    it('carries _tag and the realm-global brand; components/operator undefined for plain', () => {
        const cond = condition(() => true);
        expect(cond._tag).toBe('design-contracts/condition');
        const brand = Symbol.for('design-contracts/named-condition');
        const raw = cond as unknown as Record<PropertyKey, unknown>;
        expect(raw[brand]).toBe(true);
        expect(Object.getOwnPropertyDescriptor(cond, brand)?.enumerable).toBe(false);
        expect(cond.operator).toBeUndefined();
        expect(cond.components).toBeUndefined();
    });

    it('stores the predicate verbatim', () => {
        const pred = (): boolean => true;
        expect(condition<[]>(pred).predicate).toBe(pred);
    });
});

describe('condition() — check() semantics', () => {
    it('returns true and leaves lastFailure undefined on success', () => {
        const cond = condition(() => true);
        expect(cond.check()).toBe(true);
        expect(cond.lastFailure).toBeUndefined();
    });

    it('returns false and leaves lastFailure undefined on failure (plain condition)', () => {
        const cond = condition(() => false);
        expect(cond.check()).toBe(false);
        // plain conditions carry no sub-structure — nothing to report
        expect(cond.lastFailure).toBeUndefined();
    });

    it('truthy non-boolean predicates pass; falsy ones do not', () => {
        const truthy = condition(() => 1 as unknown as boolean);
        const falsy = condition(() => 0 as unknown as boolean);
        expect(truthy.check()).toBeTruthy();
        expect(falsy.check()).toBeFalsy();
    });

    it('predicate exceptions propagate unwrapped', () => {
        const boom = new Error('predicate exploded');
        const cond = condition(() => {
            throw boom;
        });
        expect(() => cond.check()).toThrow(boom);
    });
});

describe('all()', () => {
    it('passes when every child passes', () => {
        const cond = all(
            condition(() => true, { name: 'a' }),
            () => true,
        );
        expect(cond.check()).toBe(true);
        expect(cond.lastFailure).toBeUndefined();
    });

    it('short-circuits: predicates after a failing child never run', () => {
        const first = vi.fn(() => false);
        const second = vi.fn(() => true);
        const third = vi.fn(() => true);
        const cond = all(
            condition(first, { name: 'first' }),
            condition(second, { name: 'second' }),
            condition(third, { name: 'third' }),
        );
        expect(cond.check()).toBe(false);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
        expect(third).not.toHaveBeenCalled();
    });

    it('reports the index of the failing child', () => {
        const cond = all(
            condition(() => true, { name: 'ok' }),
            condition(() => false, { name: 'bad' }),
            condition(() => true, { name: 'never' }),
        );
        expect(cond.check()).toBe(false);
        expect(failureOf(cond as NamedCondition<unknown[]>)?.index).toBe(1);
        expect(failureOf(cond as NamedCondition<unknown[]>)?.operator).toBe('all');
        expect(failureOf(cond as NamedCondition<unknown[]>)?.conditionName).toBe('bad');
    });

    it('cause chains through nested composites, child failure travels up', () => {
        const inner = all(
            condition(() => false, { name: 'innerFail' }),
            condition(() => true, { name: 'innerPass' }),
        );
        const outer = all(
            inner,
            condition(() => true, { name: 'outerPass' }),
        );
        expect(outer.check()).toBe(false);
        const outerFailure = failureOf(outer as NamedCondition<unknown[]>);
        expect(outerFailure?.operator).toBe('all');
        expect(outerFailure?.cause?.operator).toBe('all');
        expect(outerFailure?.cause?.conditionName).toBe('innerFail');
        expect(outerFailure?.cause?.index).toBe(0);
    });

    it('empty all() passes (Array.every semantics)', () => {
        expect(all().check()).toBe(true);
    });
});

describe('any()', () => {
    it('passes on the first truthy child and stops evaluating later children', () => {
        const first = vi.fn(() => true);
        const second = vi.fn(() => true);
        const cond = any(
            condition(first, { name: 'first' }),
            condition(second, { name: 'second' }),
        );
        expect(cond.check()).toBe(true);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
    });

    it('evaluates every child when none pass', () => {
        const first = vi.fn(() => false);
        const second = vi.fn(() => false);
        const third = vi.fn(() => false);
        const cond = any(
            condition(first, { name: 'a' }),
            condition(second, { name: 'b' }),
            condition(third, { name: 'c' }),
        );
        expect(cond.check()).toBe(false);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        expect(third).toHaveBeenCalledTimes(1);
    });

    it('lastFailure on full failure: index -1, composite itself is the culprit, full components', () => {
        const cond = any(
            condition(() => false, { name: 'a' }),
            condition(() => false, { name: 'b' }),
        );
        expect(cond.check()).toBe(false);
        const failure = failureOf(cond as NamedCondition<unknown[]>);
        expect(failure?.operator).toBe('any');
        expect(failure?.index).toBe(-1);
        expect(failure?.conditionId).toBe(cond.id);
        expect(failure?.conditionName).toBe(cond.name);
        expect(failure?.components).toHaveLength(2);
        expect(failure?.components?.map((f) => f.conditionName)).toEqual(['a', 'b']);
        expect(failure?.components?.map((f) => f.operator)).toEqual(['any', 'any']);
    });

    it('empty any() fails (Array.some semantics)', () => {
        expect(any().check()).toBe(false);
    });
});

describe('not()', () => {
    it('passes when the child fails', () => {
        expect(not(condition(() => false, { name: 'child' })).check()).toBe(true);
    });

    it('fails when the child unexpectedly passes, index 0, no deeper cause', () => {
        const cond = not(condition(() => true, { name: 'child' }));
        expect(cond.check()).toBe(false);
        const failure = failureOf(cond as NamedCondition<unknown[]>);
        expect(failure?.operator).toBe('not');
        expect(failure?.index).toBe(0);
        expect(failure?.conditionName).toBe('child');
        expect(failure?.cause).toBeUndefined();
    });

    it('lastFailure clears once the child starts failing again', () => {
        let ok = true;
        const cond = not(condition(() => ok, { name: 'flip' }));
        expect(cond.check()).toBe(false);
        expect(cond.lastFailure).toBeDefined();
        ok = false;
        expect(cond.check()).toBe(true);
        expect(cond.lastFailure).toBeUndefined();
    });
});

describe('composites — names and nesting', () => {
    it('composite name lists child names: all(a, b) and any(a)', () => {
        expect(
            all(
                condition(() => true, { name: 'a' }),
                condition(() => true, { name: 'b' }),
            ).name,
        ).toBe('all(a, b)');
        expect(any(condition(() => true, { name: 'solo' })).name).toBe('any(solo)');
        expect(not(condition(() => true, { name: 'x' })).name).toBe('not(x)');
    });

    it('nested composite names nest readably', () => {
        const inner = any(
            condition(() => true, { name: 'x' }),
            condition(() => true, { name: 'y' }),
        );
        const outer = all(inner, not(condition(() => true, { name: 'z' })));
        expect(inner.name).toBe('any(x, y)');
        expect(outer.name).toBe('all(any(x, y), not(z))');
    });

    it('finds the failing leaf through nested composite structure', () => {
        const leaf = condition(() => false, { name: 'leafFail' });
        const inner = any(
            leaf,
            condition(() => false, { name: 'innerFail2' }),
        );
        const outer = all(
            condition(() => true, { name: 'outerOk' }),
            inner,
        );
        expect(outer.check()).toBe(false);
        const outerFailure = failureOf(outer as NamedCondition<unknown[]>);
        expect(outerFailure?.index).toBe(1);
        expect(outerFailure?.cause?.operator).toBe('any');
        expect(outerFailure?.cause?.index).toBe(-1);
        expect(outerFailure?.cause?.components?.[0]?.conditionName).toBe('leafFail');
        expect(outerFailure?.cause?.components?.[1]?.conditionName).toBe('innerFail2');
    });

    it('composites are not callable', () => {
        const cond = all(condition(() => true));
        expect(typeof cond).toBe('object');
        expect(() => (cond as unknown as () => boolean)()).toThrow(TypeError);
    });
});

describe('isNamedCondition — brands and guards', () => {
    it('is true for condition() and for composites', () => {
        expect(isNamedCondition(condition(() => true))).toBe(true);
        expect(isNamedCondition(all(condition(() => true)))).toBe(true);
        expect(isNamedCondition(any(condition(() => true)))).toBe(true);
        expect(isNamedCondition(not(condition(() => true)))).toBe(true);
    });

    it('is false for bare predicates and foreign objects', () => {
        expect(isNamedCondition(() => true)).toBe(false);
        expect(isNamedCondition({ id: 'x', name: 'x', check: () => true })).toBe(false);
        expect(isNamedCondition(null)).toBe(false);
        expect(isNamedCondition(undefined)).toBe(false);
        expect(isNamedCondition(42)).toBe(false);
        expect(isNamedCondition('condition')).toBe(false);
    });

    it('honors the Symbol.for realm brand (dual ESM/CJS parity)', () => {
        const brand = Symbol.for('design-contracts/named-condition');
        const compatible = {
            id: 'x',
            name: 'x',
            check: () => true,
            predicate: () => true,
            [brand]: true,
        };
        expect(isNamedCondition(compatible)).toBe(true);
        expect(isNamedCondition({ ...compatible, [brand]: undefined })).toBe(false);
        expect(isNamedCondition({ ...compatible, check: undefined })).toBe(false);
    });
});

describe('ConditionInput — bare predicates normalize', () => {
    it('all() normalizes bare predicates into named conditions', () => {
        function bareOk(): boolean {
            return true;
        }
        const cond = all(
            bareOk,
            condition(() => true, { name: 'named' }),
        );
        expect(cond.components).toHaveLength(2);
        expect(isNamedCondition(cond.components?.[0])).toBe(true);
        expect(cond.components?.[0]?.name).toBe('bareOk');
        expect(cond.components?.[1]?.name).toBe('named');
    });

    it('any() and not() accept bare predicates', () => {
        expect(any(() => true).check()).toBe(true);
        expect(not(() => true).check()).toBe(false);
        expect(isNamedCondition(any(() => true).components?.[0])).toBe(true);
    });
});

describe('sanitize / safeSerialize', () => {
    it('cycles on the same path become [Circular]', () => {
        const obj: Record<string, unknown> = { name: 'x' };
        obj['self'] = obj;
        expect(sanitize(obj)).toEqual({ name: 'x', self: '[Circular]' });
    });

    it('the same reference in sibling branches is not flagged as circular', () => {
        const shared = { v: 1 };
        const out = sanitize({ a: shared, b: shared }) as Record<string, unknown>;
        expect(out['a']).toEqual({ v: 1 });
        expect(out['b']).toEqual({ v: 1 });
    });

    it('values past maxDepth collapse to [MaxDepth]', () => {
        expect(sanitize({ a: { b: { c: 'leaf' } } }, { maxDepth: 1 })).toEqual({ a: '[MaxDepth]' });
        expect(sanitize({ a: { b: { c: 'leaf' } } }, { maxDepth: 2 })).toEqual({
            a: { b: '[MaxDepth]' },
        });
    });

    it('arrays overflow into a trailing marker string', () => {
        expect(sanitize([1, 2, 3, 4], { maxItems: 2 })).toEqual([1, 2, '[... 2 more items]']);
    });

    it('objects overflow into a marker key set to true', () => {
        const out = sanitize({ a: 1, b: 2, c: 3 }, { maxItems: 2 }) as Record<string, unknown>;
        expect(out['a']).toBe(1);
        expect(out['b']).toBe(2);
        expect(out['[... 1 more keys]']).toBe(true);
        expect('c' in out).toBe(false);
    });

    it('Maps past maxItems report an overflow count', () => {
        const out = sanitize(
            new Map([
                [1, 'a'],
                [2, 'b'],
                [3, 'c'],
            ]),
            {
                maxItems: 2,
            },
        ) as Record<string, unknown>;
        expect(out['type']).toBe('Map');
        expect(out['size']).toBe(3);
        expect(out['overflow']).toBe(1);
        expect(out['entries']).toHaveLength(2);
    });

    it('Sets past maxItems report an overflow count', () => {
        const out = sanitize(new Set([1, 2, 3]), { maxItems: 2 }) as Record<string, unknown>;
        expect(out['type']).toBe('Set');
        expect(out['size']).toBe(3);
        expect(out['overflow']).toBe(1);
        expect(out['values']).toEqual([1, 2]);
    });

    it('long strings are truncated with a suffix marker', () => {
        expect(sanitize('x'.repeat(10), { maxStringLength: 4 })).toBe('xxxx...[truncated 6 chars]');
    });

    it('bigint stringifies with an n suffix', () => {
        expect(sanitize(10n)).toBe('10n');
        expect(sanitize(-7n)).toBe('-7n');
    });

    it('NaN and infinities become plain strings', () => {
        expect(sanitize(Number.NaN)).toBe('NaN');
        expect(sanitize(Number.POSITIVE_INFINITY)).toBe('Infinity');
        expect(sanitize(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
    });

    it('Error instances serialize to name/message (+stack)', () => {
        const out = sanitize(new TypeError('boom')) as Record<string, unknown>;
        expect(out['name']).toBe('TypeError');
        expect(out['message']).toBe('boom');
    });

    it('Maps keep entries, Sets keep values (no truncation by default)', () => {
        const mapOut = sanitize(new Map([['k', 1]])) as Record<string, unknown>;
        expect(mapOut['type']).toBe('Map');
        expect(mapOut['entries']).toEqual([['k', 1]]);
        const setOut = sanitize(new Set(['x'])) as Record<string, unknown>;
        expect(setOut['values']).toEqual(['x']);
    });

    it('functions become [Function: name]', () => {
        expect(sanitize(function sanitizeMarker(): void {})).toBe('[Function: sanitizeMarker]');
    });

    it('Date serializes to ISO; invalid Date to a marker', () => {
        expect(sanitize(new Date('2020-01-01T00:00:00.000Z'))).toBe('2020-01-01T00:00:00.000Z');
        expect(sanitize(new Date(Number.NaN))).toBe('[Invalid Date]');
    });

    it('undefined becomes [undefined]; object keys are preserved', () => {
        expect(sanitize(undefined)).toBe('[undefined]');
        expect(sanitize({ u: undefined })).toEqual({ u: '[undefined]' });
        expect(sanitize([undefined])).toEqual(['[undefined]']);
    });

    it('class instances gain a [type] key with the constructor name', () => {
        class Widget {
            public size: number = 3;
        }
        const out = sanitize(new Widget()) as Record<string, unknown>;
        expect(out['[type]']).toBe('Widget');
        expect(out['size']).toBe(3);
    });

    it('Object.create(null) is treated as a plain object, no [type]', () => {
        const plain: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        plain['a'] = 1;
        expect(sanitize(plain)).toEqual({ a: 1 });
    });

    it('non-enumerable own properties are dropped', () => {
        const obj = { visible: 'yes' };
        Object.defineProperty(obj, 'hidden', { value: 'no', enumerable: false });
        expect(sanitize(obj)).toEqual({ visible: 'yes' });
    });

    it('RegExp stringifies to its literal form', () => {
        expect(sanitize(/ab+c/gi)).toBe('/ab+c/gi');
    });

    it('safeSerialize matches sanitize output', () => {
        const value = { nested: { list: [1, 2n, Number.NaN] }, sym: Symbol.for('s') };
        expect(safeSerialize(value)).toEqual(sanitize(value));
    });

    it('deeply nested acyclic trees walk fine (depth limit honored, not exceeded)', () => {
        const value = { a: { b: { c: { d: { e: 'leaf' } } } } };
        expect(sanitize(value)).toEqual({ a: { b: { c: { d: '[MaxDepth]' } } } });
    });
});
