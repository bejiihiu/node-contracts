import type { ContractViolationDetails } from './base.js';
import { ContractViolationError, composeViolationMessage } from './base.js';

/**
 * Thrown when an assertion fails.
 *
 * Assertions are internal claims about the program's own state, as opposed
 * to preconditions (caller-facing requirements) which describe the contract.
 */
export class AssertionViolationError extends ContractViolationError {
    constructor(message?: string, details: ContractViolationDetails = {}) {
        super('assertion', composeViolationMessage('Assertion', details, message), details);
        this.name = 'AssertionViolationError';
    }
}
