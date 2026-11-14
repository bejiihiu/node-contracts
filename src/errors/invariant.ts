import type { ContractViolationDetails } from './base.js';
import { ContractViolationError, composeViolationMessage } from './base.js';

/**
 * Thrown when an invariant of a contracted object no longer holds.
 *
 * Invariants are checked at object lifecycle boundaries such as after
 * construction and after public methods mutate state.
 */
export class InvariantViolationError extends ContractViolationError {
    constructor(message?: string, details: ContractViolationDetails = {}) {
        super('invariant', composeViolationMessage('Invariant', details, message), details);
        this.name = 'InvariantViolationError';
    }
}
