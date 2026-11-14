/**
 * Base machinery shared by all contract violation errors.
 */

/**
 * The kind of contract condition that was violated.
 *
 * - `precondition` — a requirement that must hold before a function runs.
 * - `postcondition` — a guarantee expected after a function returns.
 * - `invariant` — a property that must hold for an object's state.
 * - `assertion` — an internal claim that was expected to be true.
 * - `on-error` — an error-contract check failed while the function was failing.
 */
export type ContractViolationKind =
    | 'precondition'
    | 'postcondition'
    | 'invariant'
    | 'assertion'
    | 'on-error';

/**
 * Enforcement modes the runtime can operate in.
 *
 * - `strict` — a violation throws.
 * - `warn` — a violation is reported, execution continues.
 * - `silent` — a violation is swallowed.
 * - `audit` — a violation is reported to the audit pipeline.
 * - `off` — checks are disabled entirely.
 */
export type ContractMode = 'strict' | 'warn' | 'silent' | 'audit' | 'off';

/**
 * Structured details that describe a contract violation.
 *
 * All fields are optional except where noted; `mode` defaults to `'strict'`.
 */
export interface ContractViolationDetails {
    /** Name of the contract, when it was created with one. */
    readonly contractName?: string;
    /** Name of the function or method the contract wraps, when available. */
    readonly functionName?: string;
    /** Zero-based index of the condition within its contract section. */
    readonly conditionIndex?: number;
    /** Name of a named condition, if the failing condition was named. */
    readonly conditionName?: string;
    /**
     * Sanitized context attached to the error.
     *
     * Only pass data you are comfortable logging: explicitly provided scalars
     * (strings, numbers, booleans, bigints, null) and plain JSON-safe records.
     * Never attach raw arguments, secrets, tokens, or PII — the library does
     * not sanitize this for you, and `toJSON()` will happily serialize whatever
     * you put here.
     */
    readonly context?: Record<string, unknown>;
    /** Enforcement mode in effect when the violation occurred. Defaults to `'strict'`. */
    readonly mode?: ContractMode;
    /** Underlying cause, forwarded via the standard `Error` `cause` option. */
    readonly cause?: unknown;
}

/**
 * JSON-safe shape produced by {@link ContractViolationError.toJSON}.
 *
 * Kept concrete (not an open record) so consumers get real types and
 * serializers see only known keys.
 */
export interface ContractViolationJSON {
    /** Error class name, e.g. `PreconditionViolationError`. */
    readonly name: string;
    /** The category of condition that was violated. */
    readonly kind: ContractViolationKind;
    /** Human-readable message. */
    readonly message: string;
    /** Enforcement mode in effect when the violation occurred. */
    readonly mode: ContractMode;
    /** Name of the contract, if one was provided. */
    readonly contractName?: string;
    /** Name of the wrapped function or method, if available. */
    readonly functionName?: string;
    /** Zero-based index of the failing condition within its contract section. */
    readonly conditionIndex?: number;
    /** Name of the failing condition, if it was a named condition. */
    readonly conditionName?: string;
    /** Sanitized context attached to the error, if any. */
    readonly context?: Record<string, unknown>;
    /** Serialized cause: `{ name, message }` for errors, primitives as-is, omitted otherwise. */
    readonly cause?: unknown;
}

interface V8ErrorConstructor {
    captureStackTrace?(target: object, constructorOpt?: unknown): void;
}

/**
 * Compose the default message for a violation.
 *
 * Something like `Precondition violated: divide (condition #0): amount must be positive`.
 * Parts that are missing are just skipped, no dangling separators.
 */
export function composeViolationMessage(
    label: string,
    details: ContractViolationDetails,
    userMessage?: string,
): string {
    let message = `${label} violated`;
    if (details.functionName !== undefined && details.functionName.length > 0) {
        message += `: ${details.functionName}`;
    }
    if (details.conditionIndex !== undefined) {
        message += ` (condition #${details.conditionIndex})`;
    }
    if (details.conditionName !== undefined && details.conditionName.length > 0) {
        message += ` [${details.conditionName}]`;
    }
    if (userMessage !== undefined && userMessage.length > 0) {
        message += `: ${userMessage}`;
    }
    return message;
}

/**
 * Serialize an unknown `cause` into something JSON-safe.
 *
 * Errors collapse to `{ name, message }`, primitives pass through, everything
 * else is dropped rather than leaked into logs.
 */
function serializeCause(cause: unknown): unknown {
    if (cause instanceof Error) {
        return { name: cause.name, message: cause.message };
    }
    const t = typeof cause;
    if (cause === null || t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
        return cause;
    }
    return undefined;
}

/**
 * Base class for every error thrown by design-contracts.
 *
 * Carries structured, readonly metadata about the violation in addition to the
 * regular `Error` message and stack. Instances are safe to `instanceof`-check,
 * `catch`-narrow, and serialize via {@link ContractViolationError.toJSON}.
 *
 * `context` is never populated implicitly by the library — it only contains
 * what the caller (or a failing contract) explicitly attaches, and it is the
 * caller's responsibility to keep it free of sensitive data.
 */
export class ContractViolationError extends Error {
    /** The category of condition that was violated. */
    readonly kind: ContractViolationKind;
    /** Name of the contract, if one was provided. */
    readonly contractName?: string;
    /** Name of the wrapped function or method, if available. */
    readonly functionName?: string;
    /** Zero-based index of the failing condition within its contract section. */
    readonly conditionIndex?: number;
    /** Name of the failing condition, if it was a named condition. */
    readonly conditionName?: string;
    /**
     * Sanitized context explicitly attached to this error.
     *
     * Contains only caller-provided, JSON-safe data. Never holds secrets,
     * tokens, or raw function arguments unless someone put them there on purpose.
     */
    readonly context?: Record<string, unknown>;
    /** Enforcement mode in effect when the violation occurred. */
    readonly mode: ContractMode;

    constructor(
        kind: ContractViolationKind,
        message: string,
        details: ContractViolationDetails = {},
    ) {
        const options: ErrorOptions = {};
        if ('cause' in details) {
            options.cause = details.cause;
        }
        super(message, options);

        // keep the prototype chain intact even if downleveled later
        Object.setPrototypeOf(this, new.target.prototype);

        this.name = 'ContractViolationError';
        this.kind = kind;
        if (details.contractName !== undefined) this.contractName = details.contractName;
        if (details.functionName !== undefined) this.functionName = details.functionName;
        if (details.conditionIndex !== undefined) this.conditionIndex = details.conditionIndex;
        if (details.conditionName !== undefined) this.conditionName = details.conditionName;
        if (details.context !== undefined) this.context = details.context;
        this.mode = details.mode ?? 'strict';

        // V8-only nicety, guarded so non-V8 runtimes don't choke
        const ctor = Error as unknown as V8ErrorConstructor;
        if (typeof ctor.captureStackTrace === 'function') {
            ctor.captureStackTrace(this, new.target);
        }
    }

    /**
     * JSON representation that is safe to log or ship to an error tracker.
     *
     * Includes the structured violation fields and the `cause` (sanitized to
     * `{ name, message }` for errors). Deliberately omits `stack` — stack
     * traces leak absolute paths and should not travel by default.
     */
    toJSON(): ContractViolationJSON {
        const json: {
            -readonly [K in keyof ContractViolationJSON]: ContractViolationJSON[K];
        } = {
            name: this.name,
            kind: this.kind,
            message: this.message,
            mode: this.mode,
        };
        if (this.contractName !== undefined) json.contractName = this.contractName;
        if (this.functionName !== undefined) json.functionName = this.functionName;
        if (this.conditionIndex !== undefined) json.conditionIndex = this.conditionIndex;
        if (this.conditionName !== undefined) json.conditionName = this.conditionName;
        if (this.context !== undefined) json.context = this.context;
        if (this.cause !== undefined) {
            const serialized = serializeCause(this.cause);
            if (serialized !== undefined) json.cause = serialized;
        }
        return json;
    }
}
