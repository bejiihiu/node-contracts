import type { ContractViolationDetails } from './base.js';
import { ContractViolationError, composeViolationMessage } from './base.js';

/**
 * Thrown when an on-error contract check fails.
 *
 * On-error conditions describe what is expected to be true while the wrapped
 * function is failing — for example, that a thrown error matches a required
 * shape. This error means the failure itself broke its contract.
 */
export class OnErrorViolationError extends ContractViolationError {
    constructor(message?: string, details: ContractViolationDetails = {}) {
        super('on-error', composeViolationMessage('On-error condition', details, message), details);
        this.name = 'OnErrorViolationError';
    }
}
