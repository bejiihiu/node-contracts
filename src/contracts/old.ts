/**
 * Old values — pre-execution snapshots for postconditions.
 *
 * The `old` mechanism captures state *before* a wrapped function mutates it, so
 * postconditions can compare against the pre-call world instead of poking at
 * already-mutated objects. Snapshots are explicit and controlled: nothing is
 * cloned unless the caller asks for it.
 *
 * Semantics of {@link captureValue}, in short:
 *
 * - Primitives, `undefined`, functions and symbols are kept as-is (they are
 *   pass-by-value or inherently reference values).
 * - Objects, arrays, Maps, Sets and everything else structuredClone understands
 *   are deep-copied via `structuredClone`.
 * - If `structuredClone` throws (functions inside the graph, DOM nodes,
 *   Proxies, class instances with uncloneable internals, ...), we fall back to
 *   a *shallow* copy for arrays, Maps, Sets and plain objects. Anything else
 *   is kept by reference — query {@link isReferenceCapture} if you need to know.
 *
 * Parameter-name introspection for `old: ['account']`-style specs is
 * best-effort: it reads `fn.toString()`, so minified or transpiled code may
 * lose real parameter names. When introspection fails, the key is skipped and a
 * one-time `console.warn` is emitted. For full control use the function form:
 * `old: (args) => ({ account: captureValue(args[0]) })`.
 */

/**
 * Specification of what to capture before a function runs.
 *
 * - `readonly string[]` — names of parameters to snapshot. Names are resolved
 *   against the source text of the function (best-effort, see module docs).
 * - Function — receives the raw args array and returns the record to merge
 *   into `old`. Full control; values are used exactly as returned (wrap mutable
 *   objects yourself if you want a copy, e.g. via {@link captureValue}).
 */
export type OldSpec =
    | readonly string[]
    | ((args: readonly unknown[]) => Record<string, unknown>);

/**
 * Frozen view of captured pre-call values handed to postconditions.
 *
 * Keys are the requested names; values are whatever {@link captureValue}
 * produced (or whatever the capture function returned for the function form).
 */
export type OldValues<T = unknown> = Readonly<Record<string, T>>;

// objects we handed out by reference because they can't be cloned — so callers
// can tell "snapshot" apart from "live handle" later
const referenceCaptures = new WeakSet<object>();

// feature-detect structuredClone instead of relying on ambient lib types —
// keeps us safe on runtimes/lib configs where it isn't declared
type StructuredClone = <T>(value: T) => T;
const structuredCloneFn: StructuredClone | undefined = (
    globalThis as { structuredClone?: StructuredClone }
).structuredClone;

// same trick for console — one warn path, zero hard dependency on ambient types
function warn(message: string): void {
    const c = (globalThis as { console?: { warn?(...args: unknown[]): void } }).console;
    c?.warn?.(`design-contracts: ${message}`);
}

// shared degraded path: shallow copy where possible, live reference otherwise
function shallowCapture(obj: object): unknown {
    if (Array.isArray(obj)) {
        return obj.slice();
    }
    if (obj instanceof Map) {
        return new Map(obj);
    }
    if (obj instanceof Set) {
        return new Set(obj);
    }
    if (isPlainObject(obj)) {
        return { ...obj };
    }
    // class instances, exotic objects — no honest way to copy, keep the ref
    referenceCaptures.add(obj);
    return obj;
}

function isPlainObject(value: object): boolean {
    const proto = Object.getPrototypeOf(value) as unknown;
    return proto === Object.prototype || proto === null;
}

/**
 * Capture a single value.
 *
 * Never throws. Primitives/symbols/functions pass through untouched; objects
 * go through `structuredClone` with a shallow/reference fallback for
 * uncloneable graphs. See the module docs for the full matrix.
 */
export function captureValue(value: unknown): unknown {
    const t = typeof value;
    if (value === null || (t !== 'object' && t !== 'function')) {
        // primitives are immutable, symbols are tokens — both safe by value
        return value;
    }
    if (t === 'function') {
        referenceCaptures.add(value as object);
        return value;
    }
    const obj = value as object;
    if (structuredCloneFn !== undefined) {
        try {
            return structuredCloneFn(obj);
        } catch {
            // clone blew up (functions/DOM nodes/Proxies inside) — degrade gracefully
            return shallowCapture(obj);
        }
    }
    return shallowCapture(obj);
}

/**
 * Reports whether `value` was handed out as a live reference because it could
 * not be cloned at capture time.
 *
 * Useful in postconditions/debugging to distinguish "snapshot of the past"
 * from "the same object, now mutated".
 */
export function isReferenceCapture(value: unknown): boolean {
    if (value === null) return false;
    const t = typeof value;
    if (t !== 'object' && t !== 'function') return false;
    return referenceCaptures.has(value as object);
}

// ---------------------------------------------------------------------------
// parameter name introspection (best-effort, `fn.toString()` based)
// ---------------------------------------------------------------------------

// name is null for destructured/unparseable slots; rest slots group the tail of args
interface ParameterSlot {
    readonly name: string | null;
    readonly rest: boolean;
}
type ParameterSlots = readonly ParameterSlot[];
const introspectionCache = new WeakMap<object, ParameterSlots | null>();
const warnedOnce = new Set<string>();

// notify once per key per process — log spam helps nobody
function warnOnce(key: string, message: string): void {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    warn(message);
}

const SINGLE_PARAM_ARROW = /^(?:async[\s\r\n]+)?([A-Za-z_$][\w$]*)\s*=>/;

// scan for the matching closing paren, skipping strings/comments/nesting
function findMatchingParen(source: string, openIndex: number): number {
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = openIndex; i < source.length; i += 1) {
        const ch = source.charAt(i);
        const next = source.charAt(i + 1);

        if (inLineComment) {
            if (ch === '\n' || ch === '\r') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }
        if (quote !== null) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\' && quote !== '`') {
                escaped = true;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '/' && next === '/') {
            inLineComment = true;
            i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') {
            depth += 1;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

// split the parameter list on top-level commas only
function splitTopLevelCommas(inner: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < inner.length; i += 1) {
        const ch = inner.charAt(i);
        const next = inner.charAt(i + 1);

        if (inLineComment) {
            if (ch === '\n' || ch === '\r') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }
        if (quote !== null) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\' && quote !== '`') {
                escaped = true;
                continue;
            }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '/' && next === '/') {
            inLineComment = true;
            i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') {
            depth += 1;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') {
            depth -= 1;
            continue;
        }
        if (ch === ',' && depth === 0) {
            parts.push(inner.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(inner.slice(start));
    return parts;
}

const IDENT_START = /^[A-Za-z_$][\w$]*/;

// pull a plain identifier out of a raw parameter segment; null name if it's exotic
function parseParameter(raw: string): ParameterSlot {
    let text = raw.trim();
    let rest = false;
    if (text.startsWith('...')) {
        text = text.slice(3).trimStart();
        rest = true;
    }
    // destructured or otherwise weird patterns carry no usable name
    if (text.startsWith('{') || text.startsWith('[')) return { name: null, rest };
    const match = IDENT_START.exec(text);
    return { name: match ? match[0] : null, rest };
}

// null when the source is unparsable (toString throws, no parens, unbalanced) —
// an empty param list is a valid result, not a failure
function introspectParameterNames(fn: (...args: never[]) => unknown): ParameterSlots | null {
    const cached = introspectionCache.get(fn);
    if (cached !== undefined) return cached;

    let result: ParameterSlots | null = null;
    try {
        const source = Function.prototype.toString.call(fn);
        const single = SINGLE_PARAM_ARROW.exec(source);
        if (single?.[1] !== undefined) {
            result = [{ name: single[1], rest: false }];
        } else {
            const open = source.indexOf('(');
            if (open !== -1) {
                const close = findMatchingParen(source, open);
                if (close > open) {
                    const inner = source.slice(open + 1, close);
                    if (inner.trim().length === 0) {
                        result = [];
                    } else {
                        result = splitTopLevelCommas(inner).map(parseParameter);
                    }
                }
            }
        }
    } catch {
        result = null; // toString blew up (proxies, weird binds) — treat as unparsable
    }

    introspectionCache.set(fn, result);
    return result;
}

function functionLabel(fn: (...args: never[]) => unknown): string {
    return fn.name.length > 0 ? fn.name : 'anonymous function';
}

/**
 * Build the `old` object for a wrapped call.
 *
 * - Array form: each requested name is located in the function's parameter
 *   list (best-effort source introspection) and the matching argument is
 *   snapshotted via {@link captureValue}. A rest parameter captures the whole
 *   tail of args as an array. Unknown names and out-of-range arguments are
 *   skipped, with a one-time `console.warn` per key — the snapshot is partial
 *   rather than silent, and never throws.
 * - Function form: the capture function is invoked with the raw args and its
 *   return value becomes `old` (shallow-copied into a fresh record). Any
 *   exception it throws propagates untouched — a capture callback is plain
 *   userland code and hiding its failures would mask real bugs.
 *
 * Only the array form clones implicitly; the function form uses values exactly
 * as returned, so wrap mutable payloads yourself:
 * `old: (args) => ({ account: captureValue(args[0]) })`.
 *
 * @throws {TypeError} If a function-form capture does not return a plain,
 *   non-array object.
 * @throws Whatever the capture function throws — intentionally not wrapped.
 */
export function snapshotArgs(
    fn: (...args: never[]) => unknown,
    args: readonly unknown[],
    spec: OldSpec,
): Record<string, unknown> {
    if (typeof spec === 'function') {
        const produced = spec(args);
        if (produced === null || typeof produced !== 'object' || Array.isArray(produced)) {
            throw new TypeError(
                'design-contracts: an `old` capture function must return a plain object record',
            );
        }
        // detach from whatever object the user happened to hand back
        return { ...produced };
    }

    const snapshot: Record<string, unknown> = {};
    const slots = introspectParameterNames(fn);
    if (slots === null) {
        warnOnce(
            `introspect:${functionLabel(fn)}`,
            `could not introspect parameter names of ${functionLabel(fn)}; ` +
                'skipping all string-based `old` keys (minified code? use the function form instead)',
        );
        return snapshot;
    }

    for (const wanted of spec) {
        const index = slots.findIndex((slot) => slot.name === wanted);
        if (index === -1) {
            warnOnce(
                `lookup:${functionLabel(fn)}:${wanted}`,
                `no parameter named "${wanted}" in ${functionLabel(fn)}; skipping this "old" key`,
            );
            continue;
        }
        const slot = slots[index];
        if (slot?.rest === true) {
            // rest parameter — the tail of args, as an array (possibly empty)
            snapshot[wanted] = captureValue(args.slice(index));
            continue;
        }
        if (index >= args.length) {
            warnOnce(
                `range:${functionLabel(fn)}:${wanted}`,
                `argument "${wanted}" was not passed to ${functionLabel(fn)}; skipping this "old" key`,
            );
            continue;
        }
        snapshot[wanted] = captureValue(args[index]);
    }
    return snapshot;
}
