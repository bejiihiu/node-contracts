# Object Contracts

`contractObject(target, options?)` wraps an object in a `Proxy` and enforces invariants on it. Use it when a *whole object* must remain legal, not just one function's inputs and outputs.

## The three check boundaries

Invariants are checked **after** each of these, never on reads:

1. **Creation** — immediately when `contractObject()` returns (`'<init>'`). In `strict` mode, an object that starts illegal never reaches your code.
2. **Method settlement** — when a method call completes: synchronous return, synchronous throw, or promise fulfill/reject. The check runs once per method call, with the error (if any) preserved as `cause` on the violation.
3. **Direct writes** — `'<set>'`, via the proxy's `set` trap. The write **is applied**, then the invariant is checked — so by the time the violation throws, the illegal state is already in place. Contracts report; they do not roll back.

There is deliberately **no check on `get`**, and no attempt to detect "did this method mutate something" via deep-diffing. The invariant is simply re-verified at each boundary.

## A worked example

```ts
import { condition, contractObject, InvariantViolationError } from 'design-contracts';

class BankAccount {
    owner: string;
    balance: number;
    constructor(owner: string, balance: number) {
        this.owner = owner;
        this.balance = balance;
    }
    deposit(amount: number): number {
        this.balance += amount;
        return this.balance;
    }
    withdraw(amount: number): number {
        this.balance -= amount;
        return this.balance;
    }
}

const balanceNonNegative = condition((self: BankAccount) => self.balance >= 0, {
    name: 'balance non-negative',
    message: 'an account balance can never go negative',
});

const ada = contractObject(new BankAccount('Ada', 100), {
    name: 'ada account',
    invariant: [balanceNonNegative],
});

ada.withdraw(150); // InvariantViolationError (kind: 'invariant', functionName: 'withdraw', conditionIndex: 0)
```

Direct writes are guarded too — decorators cannot see these:

```ts
ada.balance = -50; // write applied, then InvariantViolationError ('<set>')
```

## Options

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `invariant` | `readonly ObjectInvariant<Self>[]` | `[]` | Invariants checked at the three boundaries |
| `name` | `string` | target's constructor name, else `'object'` | Contract name in violation reports |
| `mode` | `Mode` | resolved config | Per-object mode override (wins over scope and global) |
| `captureStack` | `boolean` | resolved config (`true`) | Capture stack on violation errors |

`ObjectInvariant<Self>` is `NamedCondition<[Self]> | ((self: Self) => unknown)`. Named conditions use their `check(self)` (and their `message` feeds the violation); bare predicates pass on any truthy value. `conditionName` in the error is the named condition's name, or the bare predicate's `function.name`, or `'anonymous'`.

## Runtime semantics you should know

- **Methods are bound to the wrapper.** `this` inside a method is the proxy, so methods see the same guarded state. Aliases are stable: `const m = obj.m; m()` still gets `this === wrapper`, and `obj.m === obj.m`.
- **Field values** (non-function properties) read and write through the trap as usual.
- **Accessors** run with the wrapper as receiver.
- **`instanceof` works** — the proxy shares the target's prototype chain.
- **The wrapper is a new identity** (`wrapper !== target`) but is typed as `T`. Documented lie: same shape, different identity. If you rely on identity comparisons (`===` between two references to "the same object"), normalize before wrapping or keep the wrapper.
- **`methodDepth` accounting.** Writes performed *inside* a wrapped method do not report per-assignment — the invariant is checked once, when the method settles. A method assigning to three fields produces exactly one report, not three.
- **Re-entrancy** is guarded: if an invariant predicate itself writes to the wrapper (don't do this), the recursive check is suppressed; the outer boundary reports whatever it sees.
- **Async methods**: the check fires in `.then` on settle (fulfill *and* reject). In `strict` mode a violating fulfill rejects the derived promise with `InvariantViolationError`; the method's own error (on reject) is preserved as `cause`.
- **Nested objects are not wrapped.** Writing to `wrapper.nested.field = x` bypasses the invariant and is caught at the *next* boundary on the outer object (or never, if the outer object sees no further activity). Wrap nested objects explicitly if they need their own invariants.
- **Class instances with `#private` fields are unsupported.** Private brand checks fail through a Proxy — the method call throws a `TypeError` about private fields. Use regular `private` or no privacy for contracted classes.
- **Symbol keys work.** Violations report them as `Symbol(description)`.
- **Sparse invariant arrays**: holes are skipped; `conditionIndex` remains the honest index into the original `invariant` array.

## Invariants are read-only contracts

Predicate exceptions propagate unwrapped (same rule as everywhere in the library):

```ts
const bad = condition(() => {
    throw new Error('db gone');
}, { name: 'db check' });

contractObject(obj, { invariant: [bad] }); // throws Error('db gone'), not a violation error
```

Write predicates that only read state and compute a boolean. Anything heavier has side effects on unrelated paths — remember, invariants run on **every** boundary.

## Multiple invariants

All invariants run on every boundary. The *first* failing one (by array index) is reported; indexes are honest even with sparse arrays. In `warn` mode you get one `onViolation` per boundary, not per failing invariant.

## Deep example: sort invariant

```ts
import { condition, contractObject } from 'design-contracts';

class SortedList<T> {
    items: T[];
    constructor(items: T[] = []) {
        this.items = [...items].sort();
    }
    insert(item: T): void {
        this.items.push(item);
        this.items.sort();
    }
}

const sorted = condition(
    (self: SortedList<number>) =>
        self.items.every((v, i) => i === 0 || self.items[i - 1]! <= v),
    { name: 'items sorted', message: 'items must remain in ascending order' },
);

const list = contractObject(new SortedList<number>([3, 1, 2]), {
    invariant: [sorted],
});

list.insert(4);
list.items.push(0); // direct write → caught at the '<set>' boundary? NO — push mutates in place.
```

> **Important**: in-place mutation of a referenced object (`push`, `sort`, `map[i] = x`) is invisible to the `set` trap. The invariant catches up at the *next method settle* on this wrapper, or you catch nothing if no further contracted call happens. For containers, prefer methods that go through the wrapper — and prefer post-method invariants over write-traps for exactly this reason.

## When to reach for `contractObject`

- Objects with **state legality that spans methods** — balances, capacities, sortedness, state machines.
- Objects handed across **team or module boundaries** where misuse is likely.
- **Not** for: plain data records (nothing to protect), hot loops over many small objects (proxy overhead per method call is real — see [benchmarks.md](./benchmarks.md)), or cross-object invariants (those belong in a ledger/domain-level contract).
