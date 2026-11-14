/**
 * Minimal thenable probe. Deliberately duck-typed instead of
 * `instanceof Promise` so custom thenables (custom classes, cross-realm
 * promises, hand-rolled `.then` objects) behave the same as native ones.
 * Foreign `then` getters that throw are treated as plain values.
 */
export const isThenable = (value: unknown): value is PromiseLike<unknown> => {
    if (value === null) return false;
    const type = typeof value;
    if (type !== 'object' && type !== 'function') return false;
    try {
        return typeof (value as { then?: unknown }).then === 'function';
    } catch {
        return false; // hostile then-getter — treat as plain value
    }
};
