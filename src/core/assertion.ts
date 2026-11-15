/**
 * Inline assertions — internal claims about the program's own state.
 *
 * Unlike preconditions, assertions are for bugs ("this value is impossible
 * here"), not for caller requirements. A falsy condition is a violation of
 * kind `'assertion'`, dispatched exactly like a contract violation: it throws
 * `AssertionViolationError` in `strict` mode, is reported to `onViolation`
 * (and `onAudit` in `audit`) without throwing in `warn`/`audit`, and is
 * skipped entirely — nothing thrown, no handlers called — in `off`,
 * `silent`, or when the `'assertion'` category is disabled in the runtime
 * configuration. A truthy condition passes silently.
 */

import { AssertionViolationError } from '../errors/assertion.js';
import type { ContractViolationDetails } from '../errors/base.js';
import { canSkip, getEffectiveConfig, reportViolation } from '../runtime/index.js';
import { hideStack } from '../utils/stack.js';
import type { SanitizedJson } from './sanitize.js';
import { sanitize } from './sanitize.js';

export interface AssertFunction {
    /**
     * Assert that `condition` is truthy. Narrows `condition` for the
     * compiler after the call, mirroring `node:assert`.
     *
     * In `warn`/`audit` mode (or with the `'assertion'` category disabled)
     * nothing throws; the narrowing is as optimistic as `asserts condition`
     * always is. See the module docs for the exact dispatch rules.
     */
    (condition: unknown, message?: string, context?: unknown): asserts condition;
    /**
     * Unconditionally report an `AssertionViolationError`. Useful for
     * "unreachable" branches that must not silently continue.
     *
     * Dispatches like {@link AssertFunction} — in `strict` it throws; in
     * `warn`/`audit` the violation is reported and execution continues; in
     * `off`/`silent`/`disabled: ['assertion']` it is a no-op. The `never`
     * return type is kept for API stability: code after `assert.fail` is
     * unreachable in enforcement mode, only reachable when checks are
     * disabled.
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

const reportAssertion = (message: string | undefined, context: unknown): void => {
    const resolved = getEffectiveConfig();
    const details: ContractViolationDetails =
        context === undefined
            ? { mode: resolved.mode }
            : { context: toContextRecord(context), mode: resolved.mode };
    // no message? let the error module render its default — it composes a
    // decent one ('Assertion violated') and stays the single source of truth
    const error = new AssertionViolationError(message, details);
    if (!resolved.captureStack) hideStack(error);
    // strict throws inside reportViolation; warn/audit dispatch to the
    // configured handlers and return — same shape as a contract violation
    reportViolation({ kind: 'assertion', message: error.message }, error);
};

function assertImpl(condition: unknown, message?: string, context?: unknown): asserts condition {
    if (condition) return;
    // enforcement disabled for the category — nothing to do, don't even
    // build the error (sanitizing the context would be wasted work)
    if (canSkip('assertion')) return;
    reportAssertion(message, context);
}

const fail = (message?: string, context?: unknown): never => {
    if (canSkip('assertion')) {
        // checks are off for the category — documented no-op, see the
        // AssertFunction docs for why `never` still stands
        return undefined as never;
    }
    reportAssertion(message, context);
    // strict already threw; warn/audit reported without throwing
    return undefined as never;
};

export const assert: AssertFunction = Object.assign(assertImpl, { fail });
