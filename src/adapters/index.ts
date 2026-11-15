/**
 * Ready-made adapters wiring contract violations and audit records into
 * common logging/telemetry infrastructure. Adapters are factories: they take
 * your logger/tracer/console and return a handler for `configure()`.
 *
 * Nothing is connected implicitly — no global hooks, no side effects at
 * import time, no dependencies beyond the package itself.
 *
 * ```ts
 * import pino from 'pino';
 * import { configure } from '@bejiihiu/design-contracts';
 * import { pinoAdapter, pinoAuditAdapter } from '@bejiihiu/design-contracts/adapters';
 *
 * const logger = pino();
 * configure({ mode: 'warn', onViolation: pinoAdapter(logger) });
 * configure({ mode: 'audit', onAudit: pinoAuditAdapter(logger) });
 * ```
 *
 * All adapters are structurally typed — pino/winston/OTel are not dependencies.
 */

export type { ConsoleAdapterOptions } from './console.js';
export { consoleAdapter } from './console.js';
export type { ChannelLike, DiagnosticsChannelModule } from './diagnostics-channel.js';
export {
    CONTRACTS_AUDIT_CHANNEL,
    CONTRACTS_VIOLATION_CHANNEL,
    diagnosticsChannelAdapter,
    diagnosticsChannelAuditAdapter,
    getAuditChannel,
    getViolationChannel,
    loadDiagnosticsChannel,
} from './diagnostics-channel.js';
export type { ViolationLogObjectOptions } from './format.js';
export { auditLogObject, formatAudit, formatViolation, violationLogObject } from './format.js';
export type {
    OpenTelemetryAdapterOptions,
    OtelAttributeValue,
    SpanEventLike,
} from './otel.js';
export { openTelemetryAdapter, openTelemetryAuditAdapter } from './otel.js';
export type { PinoAdapterOptions, PinoLikeLogger } from './pino.js';
export { pinoAdapter, pinoAuditAdapter } from './pino.js';
export type { WinstonAdapterOptions, WinstonLikeLogger } from './winston.js';
export { winstonAdapter, winstonAuditAdapter } from './winston.js';
