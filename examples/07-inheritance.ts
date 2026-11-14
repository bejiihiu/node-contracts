/**
 * 07 — Liskov merging: a subclass can't dodge its base class's contract.
 *
 * When two classes attach contracts to the same method name, the contracts
 * merge:
 *
 * - effective pre  = ALL(base.pre) OR ALL(derived.pre) — the derived class
 *   can relax, never strengthen, what base-typed callers rely on;
 * - effective post = base.post ∪ derived.post — every base postcondition
 *   still applies, plus the derived ones.
 *
 * IMPORTANT (runtime note): the merge works at call time — the first call
 * walks the receiver's prototype chain and caches the merged contract on the
 * wrapper. No `addInitializer` ordering is involved, so the behaviour is the
 * same on every engine. `mergeClassContracts()` is still available for
 * manual `contract()`-wrapped prototypes (plain functions without decorators).
 *
 * Run: bun run examples/07-inheritance.ts
 */
import type { ContractContext } from '../src/index.js';
import {
    condition,
    contractMethod,
    PostconditionViolationError,
    PreconditionViolationError,
} from '../src/index.js';

// --- part 1: decorators enforce the own contract (single level) ------------
class Notifier {
    @contractMethod({
        name: 'Notifier.notify',
        pre: [(message: string) => message.trim().length > 0],
        post: [(result: boolean) => result === true],
    })
    notify(message: string): boolean {
        console.log(`notified: ${message}`);
        return true;
    }
}

console.log('--- single-level decorator contract ---');
const notifier = new Notifier();
console.log('notify("ping") ->', notifier.notify('ping'));
try {
    notifier.notify('   ');
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

// --- part 2: Liskov merge across an override (decorators) -------------------
// The decorators do the merge at call time: the first call on a derived
// override walks the receiver's chain and builds the effective contract.
class BaseWorker {
    readonly name: string = 'base';

    // named conditions so the merged disjunction reads well in violation messages
    @contractMethod({
        name: 'BaseWorker.save',
        pre: [condition((p: string) => p.trim().length > 0, { name: 'non-blank' })],
        post: [
            condition<[boolean, ContractContext<[string], boolean>]>((r) => r === true, {
                name: 'returns true',
            }),
        ],
    })
    save(payload: string): boolean {
        console.log(`${this.name} saved: ${JSON.stringify(payload)}`);
        return true;
    }
}

class StrictWorker extends BaseWorker {
    override readonly name: string = 'strict';

    @contractMethod({
        name: 'StrictWorker.save',
        pre: [condition((p: string) => p.startsWith('task:'), { name: 'task: prefix' })],
        post: [
            condition<[boolean, ContractContext<[string], boolean>]>((r) => r === true, {
                name: 'returns true',
            }),
        ],
    })
    override save(payload: string): boolean {
        console.log(`${this.name} saved (strict): ${JSON.stringify(payload)}`);
        return super.save(payload);
    }
}

class SloppyWorker extends StrictWorker {
    override readonly name: string = 'sloppy';

    // "forgets" the base postcondition — the call-time merge puts it back
    @contractMethod({ name: 'SloppyWorker.save' })
    override save(payload: string): boolean {
        console.log(`${this.name} pretends to save: ${JSON.stringify(payload)}`);
        return false;
    }
}

console.log('--- base-typed call sites ---');
const workers: BaseWorker[] = [new BaseWorker(), new StrictWorker()];

for (const worker of workers) {
    // 'hello world' satisfies base but NOT derived — the base side of the
    // disjunction rescues the call, exactly what Liskov promises
    console.log(`${worker.name}.save("hello world") ->`, worker.save('hello world'));
}

try {
    // '' fails BOTH sides of the disjunction — this one really throws
    new StrictWorker().save('');
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PreconditionViolationError) {
        console.log('caught PreconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

try {
    // SloppyWorker returns false; the base postcondition still applies
    new SloppyWorker().save('task: deploy');
    console.log('unreachable: no error thrown');
} catch (error) {
    if (error instanceof PostconditionViolationError) {
        console.log('caught PostconditionViolationError:', error.message);
    } else {
        throw error;
    }
}

console.log('done — derived classes kept the base contract');
// mergeClassContracts() from '../src/index.js' remains available for
// prototypes you wrap by hand with contract() — same Liskov rules, applied
// explicitly instead of at call time.
