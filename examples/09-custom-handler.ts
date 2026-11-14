/**
 * 09 — your own violation handler, and scoped mode overrides.
 *
 * A toy logger is registered as the global `onViolation` handler (mode:
 * 'warn' — log and carry on). Two `withConfig` scopes then override the
 * mode for the same code path: one scope makes the contract throw
 * (`strict`), another disables checks entirely (`off`). Same function,
 * same call, three behaviors.
 *
 * Run: bun run examples/09-custom-handler.ts
 */
import {
    type ContractViolationError,
    configure,
    contract,
    resetConfig,
    withConfig,
} from '../src/index.js';

// toy logger — the kind of thing you'd wire to pino/winston in a real app
const toyLogger = {
    counts: { warn: 0 },
    warn(message: string) {
        this.counts.warn += 1;
        console.log('[toy-logger][warn]', message);
    },
};

configure({
    mode: 'warn',
    onViolation: (error: ContractViolationError) => toyLogger.warn(error.message),
});

const divide = contract(
    function divide(a: number, b: number): number {
        return a / b;
    },
    {
        name: 'divide',
        pre: [(_a, b) => b !== 0],
    },
);

console.log('--- global config: warn (log via toy-logger, execution continues) ---');
console.log('divide(10, 0) ->', divide(10, 0));

console.log('--- scoped override: strict (throws, never reaches the body) ---');
try {
    withConfig({ mode: 'strict' }, () => divide(10, 0));
    console.log('unreachable: no error thrown');
} catch (error) {
    console.log('caught:', (error as Error).constructor.name);
    console.log('  message:', (error as Error).message);
}

console.log('--- scoped override: off (checks skipped, predicates not evaluated) ---');
const result = withConfig({ mode: 'off' }, () => divide(10, 0));
console.log('divide(10, 0) ->', result);

console.log('back in global scope, divide(10, 0) ->', divide(10, 0));
console.log('toy-logger warn count:', toyLogger.counts.warn);

// restore the global config so nothing leaks into the next example
resetConfig();
console.log('done — one contract, three enforcement behaviors');
