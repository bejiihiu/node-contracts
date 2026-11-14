import type { ContractViolationDetails } from './base.js';
import { ContractViolationError, composeViolationMessage } from './base.js';

/**
 * Thrown when a precondition does not hold before a function runs.
 *
 * The wrapped function is not executed when its precondition fails.
 */
export class PreconditionViolationError extends ContractViolationError {
    constructor(message?: string, details: ContractViolationDetails = {}) {
        super('precondition', composeViolationMessage('Precondition', details, message), details);
        this.name = 'PreconditionViolationError';
    }
}
