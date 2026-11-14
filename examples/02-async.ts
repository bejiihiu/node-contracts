/**
 * 02 — contracts over async code: a tiny in-memory "database", no network.
 *
 * The contract sits on the async boundary: it checks the input before the
 * query runs and the promise's *resolved* value after it settles —
 * postconditions never see a raw promise.
 *
 * Run: bun run examples/02-async.ts
 */
import { contract, PostconditionViolationError, PreconditionViolationError } from '../src/index.js';

interface User {
    id: string;
    name: string;
    email: string;
}

// The "database": a Map, including one deliberately corrupt row (null) that
// breaks the postcondition when read.
const users = new Map<string, User | null>([
    ['u-1', { id: 'u-1', name: 'Ada', email: 'ada@example.com' }],
    ['u-2', { id: 'u-2', name: 'Grace', email: 'grace@example.com' }],
    ['ghost', null],
]);

const stats = { queries: 0 };

const fetchUser = contract(
    async function fetchUser(id: string): Promise<User | null> {
        stats.queries += 1;
        // yield once — a real driver would await I/O here
        await Promise.resolve();
        return users.get(id) ?? null;
    },
    {
        name: 'fetchUser',
        pre: [(id) => id.trim().length > 0],
        post: [(user) => user !== null],
    },
);

// Happy path: a known-good id.
const ada = await fetchUser('u-1');
console.log('fetched:', ada);

// Precondition violation: empty id is rejected before the query runs.
try {
    await fetchUser('   ');
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

// Postcondition violation: the corrupt row resolves to null, which is exactly
// what the postcondition forbids — the derived promise rejects with the
// violation instead of handing null to the caller.
try {
    await fetchUser('ghost');
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PostconditionViolationError) {
        console.log('caught PostconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

console.log('total queries against the database:', stats.queries);
console.log('done — async contracts caught the bad row');
