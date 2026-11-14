// public surface of the contracts namespace — keep flat, no namespaces

export type { ContractObjectOptions, ObjectInvariant } from './object.js';
export { contractObject } from './object.js';
export {
    captureValue,
    isReferenceCapture,
    type OldSpec,
    type OldValues,
    snapshotArgs,
} from './old.js';
