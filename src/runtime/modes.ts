/**
 * Execution modes and violation categories for design-contracts.
 *
 * Mode semantics (normative for the whole library):
 *
 * - `strict`  -  a contract violation throws. The wrapped function is not
 *   executed when a precondition fails, and the postcondition error is
 *   thrown after the function returns/rejects. No handlers are called;
 *   the throw itself is the signal.
 * - `warn`  -  a violation is reported to the configured `onViolation`
 *   handler (or to `console.warn` with a compact one-line message when no
 *   handler is set) and execution continues as if nothing happened.
 * - `silent`  -  violations are completely ignored. Predicates are NOT
 *   evaluated in this mode (see `off` below for why this is the chosen
 *   semantics). This is the only mode, besides `off`, that gives real
 *   performance wins.
 * - `audit`  -  predicates are evaluated, violations never throw. Each
 *   violation is packaged into an `AuditRecord` and sent to the configured
 *   `onAudit` handler (if any) and to `onViolation` (if any). When neither
 *   is configured the record is dropped silently  -  no audit log is kept by
 *   the library itself, by design (no hidden global state). Handler
 *   failures are caught and logged to `console.error`, never propagated,
 *   so auditing can never break business logic.
 * - `off`  -  contract enforcement is fully disabled. Predicates are NOT
 *   called. Wrapped functions run as close to the raw call as possible.
 *   `off` bypasses predicate evaluation entirely; it does not suppress
 *   exceptions from predicates.
 *
 * Why silent skips predicates instead of evaluating-and-ignoring:
 * evaluating predicates whose result is discarded has no observable effect
 * other than wasted work and accidental side effects inside predicates.
 * Skipping them keeps `silent` strictly cheaper and behaviorally identical
 * to a disabled check, which is what users expect from a kill switch.
 */

/** Execution mode for contract enforcement. See {@link MODES} for the canonical list and semantics. */
export const MODES = ['strict', 'warn', 'silent', 'audit', 'off'] as const;

export type Mode = (typeof MODES)[number];

/** Categories of contract violations that can be individually disabled. */
export const VIOLATION_CATEGORIES = [
    'precondition',
    'postcondition',
    'invariant',
    'assertion',
    'on-error',
] as const;

export type ViolationCategory = (typeof VIOLATION_CATEGORIES)[number];

const MODE_SET: ReadonlySet<string> = new Set(MODES);
const CATEGORY_SET: ReadonlySet<string> = new Set(VIOLATION_CATEGORIES);

/** Type guard: is the value a known execution mode? */
export function isMode(value: unknown): value is Mode {
    return typeof value === 'string' && MODE_SET.has(value);
}

/** Type guard: is the value a known violation category? */
export function isViolationCategory(value: unknown): value is ViolationCategory {
    return typeof value === 'string' && CATEGORY_SET.has(value);
}
