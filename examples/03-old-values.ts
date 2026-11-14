/**
 * 03 — `old` snapshots: contracts that reason about *what changed*.
 *
 * The snapshot is taken before `fn` runs and exposed to postconditions as
 * `context.old`. Two spec forms are shown on two otherwise identical
 * functions:
 *
 * - array form  — parameter names, resolved via `fn.toString()` introspection.
 *                 Simple, but breaks under minification; warns and skips
 *                 unknown names.
 * - function form — a callback receiving the raw args; survives minification
 *                   and gives full control over what gets snapshotted.
 *
 * Run: bun run examples/03-old-values.ts
 */
import { contract, PreconditionViolationError } from '../src/index.js';

interface Account {
    id: string;
    balance: number;
}

const withdrawArrayForm = contract(
    function withdrawArrayForm(account: Account, amount: number): number {
        account.balance -= amount;
        return account.balance;
    },
    {
        name: 'withdrawArrayForm',
        pre: [(_account, amount) => amount > 0, (account, amount) => account.balance >= amount],
        // array form: snapshot the `account` and `amount` parameters by name
        old: ['account', 'amount'],
        post: [
            (result, ctx) => {
                const old = ctx.old;
                if (old === undefined) return false;
                const oldAccount = old['account'] as Account;
                const oldAmount = old['amount'] as number;
                // the account object is mutated in place by fn — what we compare
                // against is the pre-call deep clone
                return result === oldAccount.balance - oldAmount;
            },
        ],
    },
);

const withdrawFunctionForm = contract(
    function withdrawFunctionForm(account: Account, amount: number): number {
        account.balance -= amount;
        return account.balance;
    },
    {
        name: 'withdrawFunctionForm',
        pre: [(_account, amount) => amount > 0, (account, amount) => account.balance >= amount],
        // function form: pick exactly what the postcondition needs
        old: (args) => ({
            balance: (args[0] as Account).balance,
            amount: args[1] as number,
        }),
        post: [
            (result, ctx) => {
                const old = ctx.old;
                if (old === undefined) return false;
                const oldBalance = old['balance'] as number;
                const oldAmount = old['amount'] as number;
                return result === oldBalance - oldAmount;
            },
        ],
    },
);

const account: Account = { id: 'acc-1', balance: 1000 };

console.log('start balance:', account.balance);

const afterArray = withdrawArrayForm(account, 250);
console.log('withdrawArrayForm(account, 250) ->', afterArray, '| balance now:', account.balance);

const afterFunction = withdrawFunctionForm(account, 250);
console.log(
    'withdrawFunctionForm(account, 250) ->',
    afterFunction,
    '| balance now:',
    account.balance,
);

// Overdraft attempt: the precondition (balance >= amount) rejects the call
// before any money moves, so the account is untouched.
try {
    withdrawFunctionForm(account, 10000);
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
        console.log('  balance after rejected call:', account.balance);
    } else {
        throw error;
    }
}

console.log('done — old snapshots verified both withdrawals');
