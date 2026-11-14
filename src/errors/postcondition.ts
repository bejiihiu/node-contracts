import type { ContractViolationDetails } from './base.js';
import { ContractViolationError, composeViolationMessage } from './base.js';

/**
 * Thrown when a postcondition does not hold after a function returns.
 *
 * The function body has already executed at this point; this error signals
 * that the promised result contract was broken.
 */
export class PostconditionViolationError extends ContractViolationError {
    constructor(message?: string, details: ContractViolationDetails = {}) {
        super('postcondition', composeViolationMessage('Postcondition', details, message), details);
        this.name = 'PostconditionViolationError';
    }
}
