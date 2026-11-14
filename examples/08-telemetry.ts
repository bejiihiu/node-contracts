/**
 * 08 — telemetry: push `audit` records onto node:diagnostics_channel.
 *
 * `configure({ mode: 'audit', onAudit: diagnosticsChannelAuditAdapter() })`
 * publishes one structured event per violation to the `design-contracts:audit`
 * channel. Any subscriber — logging pipeline, OTel bridge, a test — gets it,
 * and execution never stops.
 *
 * The subscriber loads diagnostics_channel structurally (this repo compiles
 * without node typings) and prints each record.
 *
 * Run: bun run examples/08-telemetry.ts
 */
import {
    CONTRACTS_AUDIT_CHANNEL,
    configure,
    contract,
    diagnosticsChannelAuditAdapter,
    resetConfig,
} from '../src/index.js';

// structural shape of what we need from node:diagnostics_channel
interface AuditRecordLike {
    readonly kind: string;
    readonly message: string;
    readonly timestamp: number;
    readonly mode: string;
    readonly contractName?: string;
    readonly functionName?: string;
    readonly conditionIndex?: number;
    readonly durationMs?: number;
}
interface DiagnosticsChannelLike {
    channel(name: string): {
        subscribe(listener: (message: { record: AuditRecordLike }) => void): void;
        unsubscribe(listener: (message: { record: AuditRecordLike }) => void): void;
    };
}

// load diagnostics_channel the same layered way the adapter does:
// process.getBuiltinModule first (node >= 20.16 / bun), then a plain require
const loadDiagnosticsChannel = (): DiagnosticsChannelLike => {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
        .process;
    const viaBuiltin = proc?.getBuiltinModule?.('diagnostics_channel');
    if (viaBuiltin !== undefined && viaBuiltin !== null) {
        return viaBuiltin as DiagnosticsChannelLike;
    }
    const viaRequire = (globalThis as { require?: (id: string) => unknown }).require?.(
        'node:diagnostics_channel',
    );
    if (viaRequire !== undefined && viaRequire !== null) {
        return viaRequire as DiagnosticsChannelLike;
    }
    throw new Error('node:diagnostics_channel is not available in this runtime');
};

const dc = loadDiagnosticsChannel();
const auditChannel = dc.channel(CONTRACTS_AUDIT_CHANNEL);

const received: AuditRecordLike[] = [];
const onAudit = (message: { record: AuditRecordLike }) => {
    received.push(message.record);
    console.log('[subscriber] record received:', JSON.stringify(message.record));
};
auditChannel.subscribe(onAudit);

configure({ mode: 'audit', onAudit: diagnosticsChannelAuditAdapter() });

const setVolume = contract(
    function setVolume(level: number): number {
        return level;
    },
    {
        name: 'setVolume',
        pre: [(level) => level >= 0 && level <= 100],
    },
);

console.log('setVolume(150) returned:', setVolume(150), '(audit mode never throws)');
console.log('records captured by the subscriber:', received.length);

auditChannel.unsubscribe(onAudit);
resetConfig();

console.log('done — the audit record flowed through diagnostics_channel');
