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
} from './config.js';
export { configure, getConfig, resetConfig } from './config.js';
export {
    canSkip,
    formatReport,
    getEffectiveConfig,
    reportViolation,
    withConfig,
} from './context.js';
export type { Mode, ViolationCategory } from './modes.js';
export { isMode, isViolationCategory, MODES, VIOLATION_CATEGORIES } from './modes.js';
