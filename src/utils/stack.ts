/**
 * Best-effort stack suppression for freshly created violation errors.
 *
 * Used when `captureStack` resolves to `false`. Covers the usual engines:
 * v8/jsc (writable own data property), spidermonkey (accessor with a setter),
 * and anything else where redefining the property throws — in that last case
 * we leave the stack alone rather than break error construction.
 */
export function hideStack(error: Error): void {
    try {
        Object.defineProperty(error, 'stack', {
            value: undefined,
            writable: true,
            configurable: true,
        });
        return;
    } catch {
        // non-configurable or accessor stack — try the plain assignment route
    }
    try {
        (error as { stack?: unknown }).stack = undefined;
    } catch {
        // stack could not be suppressed — the rest of the error is intact
    }
}
