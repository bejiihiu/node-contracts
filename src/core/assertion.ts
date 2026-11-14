/**
 * Inline assertions — internal claims about the program's own state.
 *
 * Unlike preconditions, assertions are for bugs ("this value is impossible
 * here"), not for caller requirements. A falsy condition throws
 * `AssertionViolationError`; a truthy one passes silently with zero
 * overhead beyond the branch itself.
 */

import { AssertionViolationError } from '../errors/assertion.js';
import type { ContractViolationDetails } from '../errors/base.js';
import type { SanitizedJson } from './sanitize.js';
import { sanitize } from './sanitize.js';

export interface AssertFunction {
    /**
     * Assert that `condition` is truthy. Narrows `condition` for the
     * compiler after the call, mirroring `node:assert`.
     */
    (condition: unknown, message?: string, context?: unknown): asserts condition;
    /**
     * Unconditionally throw an `AssertionViolationError`. Useful for
     * "unreachable" branches that must not silently continue.
     */
    readonly fail: (message?: string, context?: unknown) => never;
}

/**
 * The errors API wants a `Record<string, unknown>` context. Arbitrary
 * values get squashed to JSON-safe data first; anything that isn't a plain
 * object afterwards is wrapped in `{ value: ... }` so the contract holds
 * no matter what the caller passed. Cycles become '[Circular]' instead of
 * blowing up the process.
 *
 * Note: sanitizing fixes crashes, not leaks — never attach secrets or PII
 * to a context just because it can survive round-tripping.
 */
const toContextRecord = (context: unknown): Record<string, unknown> => {
    const squashed: SanitizedJson = sanitize(context);
    if (squashed !== null && typeof squashed === 'object' && !Array.isArray(squashed)) {
        return squashed as Record<string, unknown>;
    }
    return { value: squashed };
};

const buildDetails = (context: unknown): ContractViolationDetails =>
    context === undefined ? {} : { context: toContextRecord(context) };

function assertImpl(condition: unknown, message?: string, context?: unknown): asserts condition {
    if (condition) return;
    // no message? let the error module render its default — it composes a
    // decent one ('Assertion violated') and stays the single source of truth
    throw new AssertionViolationError(message, buildDetails(context));
}

const fail = (message?: string, context?: unknown): never => {
    throw new AssertionViolationError(message, buildDetails(context));
};

export const assert: AssertFunction = Object.assign(assertImpl, { fail });
