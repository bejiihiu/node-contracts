/**
 * 04 — class contracts, two flavors.
 *
 * Class-level promises come in two shapes in this library:
 *
 * 1. Method contracts — `@contractMethod({...})` decorators (TC39 Stage 3,
 *    the kind TS 5 emits natively, no experimentalDecorators flag) or plain
 *    `contract()` wrappers around functions stored in fields.
 * 2. Object invariants — `contractObject(instance, { invariant: [...] })`
 *    wraps the instance in a Proxy and checks the invariant after every
 *    method settles and after every direct property write.
 *
 * Run: bun run examples/04-class-contracts.ts
 */
import {
    condition,
    contract,
    contractMethod,
    contractObject,
    InvariantViolationError,
    PreconditionViolationError,
} from '../src/index.js';

class BankAccount {
    owner: string;
    balance: number;

    constructor(owner: string, balance: number) {
        this.owner = owner;
        this.balance = balance;
    }

    // Stage 3 decorator — merges with an inherited @contractMethod on the
    // same method name when a subclass overrides it (see example 07).
    @contractMethod({
        name: 'BankAccount.deposit',
        pre: [(amount: number) => amount > 0],
        post: [(result: number) => result > 0],
    })
    deposit(amount: number): number {
        this.balance += amount;
        return this.balance;
    }

    // No postcondition here on purpose: this one lets the object invariant
    // be the enforcer in the demo below.
    @contractMethod({
        name: 'BankAccount.withdraw',
        pre: [(amount: number) => amount > 0],
    })
    withdraw(amount: number): number {
        this.balance -= amount;
        return this.balance;
    }

    // A contract on a field: the field holds an arrow function, and the
    // wrapper travels with the instance.
    readonly statement = contract(
        function statement(this: BankAccount, lines: readonly string[]): string {
            return [`--- ${this.owner} ---`, ...lines].join('\n');
        },
        {
            name: 'BankAccount.statement',
            pre: [(lines) => lines.length > 0],
            post: [(result) => result.length > 0],
        },
    );
}

// A named invariant, reused below. The message rides into the violation error.
const balanceNonNegative = condition((self: BankAccount) => self.balance >= 0, {
    name: 'balance non-negative',
    message: 'an account balance can never go negative',
});

console.log('--- method contracts (@contractMethod) ---');
const ada = new BankAccount('Ada', 500);
console.log('deposit(150) ->', ada.deposit(150));
try {
    ada.deposit(-50);
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

console.log('--- contract() on a field ---');
console.log(ada.statement(['deposit 150.00']));
try {
    ada.statement([]);
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

console.log('--- object invariants (contractObject) ---');
// The Proxy also guards direct writes, which decorators cannot see.
const grace = contractObject(new BankAccount('Grace', 100), {
    name: 'Grace account',
    invariant: [balanceNonNegative],
});
console.log('deposit(50) through guarded proxy ->', grace.deposit(50));

// A method goes negative: the body ran, the invariant check fires when the
// method settles. The mutation already happened — contracts report, they do
// not roll back.
try {
    grace.withdraw(500);
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof InvariantViolationError) {
        console.log('caught InvariantViolationError:', error.message);
        console.log('  balance after violation:', grace.balance);
    } else {
        throw error;
    }
}

// Repair the books, then try sneaking a negative balance in through a direct
// write. The write trap applies the write first, then checks — so the value
// lands, the violation is reported, and we put it back.
grace.balance = 100;
try {
    grace.balance = -25;
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof InvariantViolationError) {
        console.log('caught InvariantViolationError:', error.message);
        console.log('  balance after direct-write violation:', grace.balance);
    } else {
        throw error;
    }
}
grace.balance = 100;

console.log('final balance:', grace.balance);
console.log('done — decorators, contracted fields and invariants all held');
