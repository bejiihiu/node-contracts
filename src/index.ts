/**
 * design-contracts — Design by Contract for JavaScript and TypeScript.
 *
 * Describe the promises your code makes to itself: preconditions before a
 * call, postconditions after it, invariants on mutable state, and
 * assertions on internal assumptions. Contracts check behavior at runtime,
 * complementing static types — they do not replace them.
 */

export {
    CONTRACTS_AUDIT_CHANNEL,
    CONTRACTS_VIOLATION_CHANNEL,
    consoleAdapter,
    diagnosticsChannelAdapter,
    diagnosticsChannelAuditAdapter,
    openTelemetryAdapter,
    openTelemetryAuditAdapter,
    pinoAdapter,
    pinoAuditAdapter,
    winstonAdapter,
    winstonAuditAdapter,
} from './adapters/index.js';
export type {
    ContractObjectOptions,
    ObjectInvariant,
    OldSpec,
    OldValues,
} from './contracts/index.js';
export {
    captureValue,
    contractObject,
    isReferenceCapture,
    snapshotArgs,
} from './contracts/index.js';
export type {
    AssertFunction,
    ConditionFailure,
    ConditionInput,
    ConditionOperator,
    ConditionOptions,
    ConditionPredicate,
    ContractContext,
    ContractMetadata,
    ContractOptions,
    ErrorPredicate,
    MergeClassContractsOptions,
    NamedCondition,
    PostPredicate,
    SanitizedJson,
    SanitizeOptions,
} from './core/index.js';
export {
    all,
    any,
    assert,
    attachContractMetadata,
    condition,
    contract,
    getContractMetadata,
    hasContractMetadata,
    isNamedCondition,
    mergeClassContracts,
    mergeContractOptions,
    not,
    sanitize,
} from './core/index.js';
export type { ContractMethodOptions } from './decorators/index.js';
export { contractMethod } from './decorators/index.js';
export type {
    ContractMode,
    ContractViolationDetails,
    ContractViolationJSON,
    ContractViolationKind,
} from './errors/index.js';
export {
    AssertionViolationError,
    ContractViolationError,
    InvariantViolationError,
    OnErrorViolationError,
    PostconditionViolationError,
    PreconditionViolationError,
} from './errors/index.js';
export type {
    AuditRecord,
    ContractConfig,
    Mode,
    ResolvedConfig,
    ViolationCategory,
    ViolationReport,
} from './runtime/index.js';
export {
    configure,
    getConfig,
    MODES,
    resetConfig,
    VIOLATION_CATEGORIES,
    withConfig,
} from './runtime/index.js';
export { isContractsCompiledIn } from './utils/build-flag.js';
