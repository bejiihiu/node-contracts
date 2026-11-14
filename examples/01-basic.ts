/**
 * 01 — the basics: pre/post contracts on plain functions.
 *
 * The default enforcement mode is `strict`: a violated contract throws a
 * violation error instead of letting bad data flow downstream. Other modes
 * (warn/audit/off) are covered in example 06.
 *
 * Run: bun run examples/01-basic.ts
 */
import { contract, PostconditionViolationError, PreconditionViolationError } from '../src/index.js';

// Precondition-only contract: the divisor must not be zero.
const divide = contract(
    function divide(a: number, b: number): number {
        return a / b;
    },
    {
        name: 'divide',
        pre: [(_a, b) => b !== 0],
        post: [(result) => Number.isFinite(result)],
    },
);

// Non-empty array precondition — generic over the element type.
const first = contract(
    function first<T>(items: readonly T[]): T | undefined {
        return items[0];
    },
    {
        name: 'first',
        pre: [(items) => items.length > 0],
    },
);

// String input, non-empty precondition, non-empty result postcondition.
const hello = contract(
    function hello(name: string): string {
        return `Hello, ${name}!`;
    },
    {
        name: 'hello',
        pre: [(name) => name.trim().length > 0],
        post: [(result) => result.length > 0],
    },
);

console.log('divide(10, 2) =', divide(10, 2));
console.log('first([3, 4, 5]) =', first([3, 4, 5]));
console.log(hello('Ada'));

// A violated precondition throws before the function body runs.
try {
    divide(10, 0);
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
        console.log('  kind:', error.kind, '| conditionIndex:', error.conditionIndex);
    } else {
        throw error;
    }
}

try {
    first([]);
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

try {
    hello('   ');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

// A violated postcondition throws after the body ran — the body's bogus
// result never reaches the caller.
const broken = contract(
    async function brokenResult(): Promise<string> {
        return 'broken';
    },
    {
        name: 'brokenResult',
        post: [(result) => typeof result === 'number'],
    },
);

try {
    await broken();
} catch (error) {
    if (error instanceof PostconditionViolationError) {
        console.log('caught PostconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

console.log('done — violations were caught, execution continued');
