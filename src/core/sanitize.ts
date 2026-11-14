/**
 * Safe serializer that squashes arbitrary values into JSON-safe output.
 *
 * Used for error contexts and condition failure details, which can carry
 * anything the user threw at them — including cycles, bigints, symbols,
 * class instances and other non-JSON goodness. Never invokes user code:
 * getters, `toJSON()` and friends are all bypassed, so a hostile or just
 * broken object cannot crash the reporter.
 *
 * The output is always safe to hand to `JSON.stringify` (modulo extremely
 * weird keys, which JSON itself tolerates).
 */

/** JSON-safe value tree produced by {@link sanitize}. */
export type SanitizedJson =
    | string
    | number
    | boolean
    | null
    | SanitizedJson[]
    | { [key: string]: SanitizedJson };

export interface SanitizeOptions {
    /** How deep containers may nest before values collapse into '[MaxDepth]'. Default 4. */
    readonly maxDepth?: number;
    /** Max entries kept in arrays/objects/map-set listings. Default 100. */
    readonly maxItems?: number;
    /** Max characters kept from a single string. Default 500. */
    readonly maxStringLength?: number;
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_STRING_LENGTH = 500;

/** Whole numbers only, NaN/negative collapse to the default. */
function clampOr(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.floor(value));
}

/**
 * Squash any value into a JSON-safe tree.
 *
 * - cycles become '[Circular]' (detected per path, repeated references in
 *   different branches are fine)
 * - anything past `maxDepth` becomes '[MaxDepth]'
 * - oversized arrays/objects get an overflow marker instead of growing forever
 * - strings are truncated past `maxStringLength`
 * - bigints stringify with an `n` suffix, non-finite numbers and symbols
 *   become strings, functions become '[Function: name]'
 * - `undefined` becomes the string '[undefined]' (object keys are kept)
 * - `Date`/`RegExp`/`Error`/typed arrays get compact, readable forms
 * - everything else: plain objects spread, class instances additionally get
 *   a `'[type]'` key with the constructor name
 */
export function sanitize(value: unknown, options?: SanitizeOptions): SanitizedJson {
    const maxDepth = clampOr(options?.maxDepth, DEFAULT_MAX_DEPTH);
    const maxItems = clampOr(options?.maxItems, DEFAULT_MAX_ITEMS);
    const maxStringLength = clampOr(options?.maxStringLength, DEFAULT_MAX_STRING_LENGTH);
    // tracks the objects on the current path, so real cycles get caught
    // without punishing the same object appearing in sibling branches
    const active = new Set<object>();

    const truncate = (input: string): string => {
        if (input.length <= maxStringLength) return input;
        return `${input.slice(0, maxStringLength)}...[truncated ${input.length - maxStringLength} chars]`;
    };

    // one hostile getter must not take the whole serializer down
    const readProp = (input: object, key: string): unknown => {
        try {
            return (input as Record<string, unknown>)[key];
        } catch {
            return '[Unreadable]';
        }
    };

    const ctorNameOf = (input: object): string | undefined => {
        try {
            const proto: unknown = Object.getPrototypeOf(input);
            if (proto === null || proto === undefined) return undefined;
            const ctor = (proto as Record<PropertyKey, unknown>).constructor;
            if (typeof ctor !== 'function') return undefined;
            const name: unknown = (ctor as { name?: unknown }).name;
            return typeof name === 'string' && name.length > 0 ? name : undefined;
        } catch {
            return 'Unknown';
        }
    };

    const walk = (input: unknown, depth: number): SanitizedJson => {
        switch (typeof input) {
            case 'string':
                return truncate(input);
            case 'number':
                return Number.isFinite(input) ? input : String(input);
            case 'boolean':
                return input;
            case 'bigint':
                return `${input}n`;
            case 'undefined':
                return '[undefined]';
            case 'symbol':
                return input.description === undefined
                    ? '[Symbol]'
                    : `[Symbol: ${input.description}]`;
            case 'function':
                return input.name.length > 0 ? `[Function: ${input.name}]` : '[Function]';
            default:
                break;
        }

        if (input === null) return null;
        if (depth >= maxDepth) return '[MaxDepth]';
        // primitives all returned above; only objects reach the cycle tracker
        if (typeof input !== 'object') return '[Unserializable]';
        if (active.has(input)) return '[Circular]';

        if (input instanceof Date) {
            return Number.isNaN(input.getTime()) ? '[Invalid Date]' : input.toISOString();
        }
        if (input instanceof RegExp) return truncate(String(input));

        if (input instanceof Error) {
            const out: Record<string, SanitizedJson> = {
                name: truncate(input.name),
                message: truncate(input.message),
            };
            if (typeof input.stack === 'string' && input.stack.length > 0) {
                out['stack'] = truncate(input.stack);
            }
            return out;
        }

        // node Buffers are Uint8Arrays under the hood, so this covers them too
        if (
            ArrayBuffer.isView(input) ||
            input instanceof ArrayBuffer ||
            input instanceof SharedArrayBuffer
        ) {
            const ctor = ctorNameOf(input) ?? 'ArrayBuffer';
            const byteLength = (input as { byteLength?: unknown }).byteLength;
            return typeof byteLength === 'number' ? `[${ctor}(${byteLength} bytes)]` : `[${ctor}]`;
        }

        if (input instanceof Map) {
            const all = [...input.entries()];
            const kept = all.slice(0, maxItems);
            active.add(input);
            try {
                const entries = kept.map(
                    ([key, value]) =>
                        [walk(key, depth + 1), walk(value, depth + 1)] as SanitizedJson[],
                );
                const out: Record<string, SanitizedJson> = {
                    type: 'Map',
                    size: input.size,
                    entries,
                };
                if (all.length > kept.length) out['overflow'] = all.length - kept.length;
                return out;
            } finally {
                active.delete(input);
            }
        }

        if (input instanceof Set) {
            const all = [...input.values()];
            const kept = all.slice(0, maxItems);
            active.add(input);
            try {
                const values = kept.map((item) => walk(item, depth + 1));
                const out: Record<string, SanitizedJson> = {
                    type: 'Set',
                    size: input.size,
                    values,
                };
                if (all.length > kept.length) out['overflow'] = all.length - kept.length;
                return out;
            } finally {
                active.delete(input);
            }
        }

        if (Array.isArray(input)) {
            active.add(input);
            try {
                const out: SanitizedJson[] = [];
                const limit = Math.min(input.length, maxItems);
                for (let index = 0; index < limit; index++) {
                    // index reads can hit exotic getters, so keep them guarded
                    out.push(walk(readProp(input, String(index)), depth + 1));
                }
                if (input.length > limit) out.push(`[... ${input.length - limit} more items]`);
                return out;
            } finally {
                active.delete(input);
            }
        }

        // arrays of holes and user getter traps both land here
        if (typeof input === 'object') {
            active.add(input);
            try {
                const out: Record<string, SanitizedJson> = {};
                const proto: unknown = Object.getPrototypeOf(input);
                const isPlain = proto === null || proto === Object.prototype;
                if (!isPlain) {
                    const ctor = ctorNameOf(input);
                    if (ctor !== undefined) out['[type]'] = ctor;
                }
                const keys = Object.keys(input);
                const kept = keys.slice(0, maxItems);
                for (const key of kept) {
                    out[key] = walk(readProp(input, key), depth + 1);
                }
                if (keys.length > kept.length)
                    out[`[... ${keys.length - kept.length} more keys]`] = true;
                return out;
            } finally {
                active.delete(input);
            }
        }

        return '[Unserializable]';
    };

    return walk(value, 0);
}

/**
 * Squash any value into a JSON-safe tree and hand it back as plain `unknown`.
 *
 * Same machinery as {@link sanitize}; this is the untyped entry point for
 * callers that just want to log or attach something without a cast. See
 * {@link sanitize} for the exact guarantees (cycles → `[Circular]`, depth
 * and item limits, never throws).
 */
export function safeSerialize(value: unknown): unknown {
    return sanitize(value);
}
