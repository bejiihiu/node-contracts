/**
 * 06 — enforcement modes: strict / warn / audit / off.
 *
 * Same call, four behaviors — flip the global config between calls and watch
 * what changes. `resetConfig()` between steps so handlers never leak from
 * one scenario into the next.
 *
 * - strict: violation throws, function body never runs (the default)
 * - warn:   handler is notified, function runs anyway
 * - audit:  handler gets a machine-readable record, function runs anyway
 * - off:    checks are skipped entirely — predicates are NOT evaluated
 *
 * Run: bun run examples/06-modes.ts
 */
import { configure, contract, PreconditionViolationError, resetConfig } from '../src/index.js';

// Count how many times the predicate actually executes — this is how we
// prove that `off` skips the check instead of just swallowing the result.
let preEvaluations = 0;
const setVolume = contract(
    function setVolume(level: number): number {
        return level;
    },
    {
        name: 'setVolume',
        pre: [
            (level) => {
                preEvaluations += 1;
                return level >= 0 && level <= 100;
            },
        ],
    },
);

console.log('--- strict (violation throws) ---');
resetConfig();
configure({ mode: 'strict' });
try {
    setVolume(150);
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
    } else {
        throw error;
    }
}
console.log('  predicate evaluations:', preEvaluations);

console.log('--- warn (onViolation notified, execution continues) ---');
resetConfig();
configure({
    mode: 'warn',
    onViolation: (error) => console.log('  [onViolation]', error.message),
});
console.log('  setVolume(150) returned:', setVolume(150));
console.log('  predicate evaluations:', preEvaluations);

console.log('--- audit (onAudit receives a JSON-able record) ---');
resetConfig();
configure({
    mode: 'audit',
    onAudit: (record) => console.log('  [onAudit]', JSON.stringify(record)),
});
console.log('  setVolume(150) returned:', setVolume(150));
console.log('  predicate evaluations:', preEvaluations);

console.log('--- off (checks and predicates are skipped) ---');
resetConfig();
configure({ mode: 'off' });
console.log('  setVolume(150) returned:', setVolume(150));
console.log('  predicate evaluations:', preEvaluations);

// Leave the global config back at defaults for the next example in the process.
resetConfig();
console.log('done — mode flip, same contract, four behaviors');
