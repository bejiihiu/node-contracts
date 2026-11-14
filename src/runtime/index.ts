/**
 * Runtime subsystem: execution modes, global and scoped configuration,
 * violation dispatch. See `./modes`, `./config` and `./context` for docs.
 *
 * Only the public surface is re-exported here. Sibling modules that need
 * internal resolution helpers should import them from `./config` directly.
 */

export type {
    AuditRecord,
    ContractConfig,
    ResolvedConfig,
    ViolationReport,
} from './config';
export { configure, getConfig, resetConfig } from './config';
export {
    canSkip,
    formatViolation,
    getEffectiveConfig,
    reportViolation,
    withConfig,
} from './context';
export type { Mode, ViolationCategory } from './modes';
export { isMode, isViolationCategory, MODES, VIOLATION_CATEGORIES } from './modes';
