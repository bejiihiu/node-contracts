# Inheritance (Liskov)

Design by Contract's answer to inheritance, implemented and enforced by this library: a subclass must be usable anywhere its base class is, and the base class's contract is part of that usability guarantee.

## The rules

| Section | Rule | Why |
| --- | --- | --- |
| Preconditions | Derived may **weaken**, never strengthen | Callers that satisfy the base precondition must not be rejected by the derived one |
| Postconditions | Derived may **add**, never drop | Callers may rely on the base postcondition after any call |
| Invariants | Base invariants are **preserved** | The derived object is an instance of the base — its laws travel with it |
| Error contracts | Derived unions onto base | The set of legal failures may only shrink, never grow |

## Precondition disjunction — the truth table

`pre` sections merge as:

> **effective pre = ALL(base.pre) OR ALL(derived.pre)**

That is, the merged contract passes if the *whole* base side is satisfied, or the *whole* derived side is. It is never stronger than the base alone — base-typed callers are never newly rejected.

| base.pre (all) | derived.pre (all) | effective | Call proceeds? |
| --- | --- | --- | --- |
| true | true | true | yes |
| true | false | true | yes (base rescues) |
| false | true | true | yes (derived rescues) |
| false | false | false | **no — throws** |

This matches Eiffel's rule and it is exactly what `mergeContractOptions` builds: a single `any(all(...base.pre), all(...derived.pre))` disjunction. Note the all-or-nothing property per side — a partially satisfied base side does not count as a rescue.

## Postcondition union — base-first

> **effective post = [...base.post, ...derived.post]**

All of them must hold; a base-post failure reports `conditionIndex` within the *merged* list (base entries keep indices `0..base.length-1`, derived entries follow). Order of evaluation is base-first; failures short-circuit at the first falsy predicate.

## Other fields

`old` / `mode` / `name` / `captureStack` / `message` are **derived ?? base** (derived wins when set, `false` counts as "set"). There is no `invariant` in `ContractOptions` — object invariants live in `contractObject()` and are **not** merged by `mergeClassContracts`; the same union semantics applies by convention if you merge invariants yourself (keep all ancestors' invariants plus yours).

## Path 1: decorators — `@contractMethod` (call-time merge)

The recommended path. When a derived member is decorated and a same-name member below it carries contract metadata (via `@contractMethod` **or** a plain `contract()` wrapper), the merge happens **at the first call**, not at decoration time:

```ts
import { contractMethod } from 'design-contracts';

class Notifier {
    @contractMethod({
        pre: [(msg: string) => msg.trim().length > 0],
        post: [(ok: boolean) => ok === true],
    })
    save(message: string): boolean {
        return true;
    }
}

class LoudNotifier extends Notifier {
    @contractMethod({
        pre: [(msg: string) => msg.startsWith('loud:')],
    })
    override save(message: string): boolean {
        this.notify(message);
        return super.save(message);
    }
}

const notifier = new LoudNotifier();
notifier.save('loud: hello');  // derived pre passes → call proceeds
notifier.save('quiet hello');  // derived pre fails; base pre passes → base side of the disjunction rescues
notifier.save('');             // both sides fail → PreconditionViolationError
```

Mechanics and edge cases (documented behavior, stable):

- The merge result is **cached on the wrapper after the first call**; later calls pay nothing extra.
- The base member need not be decorated — any element carrying contract metadata is picked up the same way. If the nearest same-name ancestor carries none, the walk continues upward (nearest-ancestor-wins at each level).
- This works at call time, so **no class-evaluation or `addInitializer` ordering is involved** — the behavior is identical on every engine and for multi-level hierarchies.
- `getContractMetadata()` on the merged wrapper reports provisional (own-only) options until the first call, and the fully merged options afterwards — matters if you introspect metadata for grandchildren.
- **Extracted members** called on the owning receiver merge normally (`const m = obj.save; m.call(obj)`); extracted members called on a *foreign* receiver fall back to their own contract only.
- **Private members** are never merged.
- **Getters/setters** merge with same-kind members only (`getter ≠ setter ≠ method`). Setter `pre` receives the assigned value; getter `pre` is forbidden entirely (zero-argument member, nothing to check — it throws `TypeError` at class-definition time).
- Instance arrow-function fields are per-instance and do not participate in prototype-chain merging; static arrow-function fields on constructors **do** merge against the constructor chain.
- Async predicates participate correctly: composite disjunctions are awaited when needed (see [async.md](./async.md)). A merged contract with async sides enforces both sides.

## Path 2: manual prototypes — `mergeClassContracts`

For hand-written prototype methods wrapped in `contract()` without decorators:

```ts
import { contract, mergeClassContracts } from 'design-contracts';

class Base { save(payload: string): boolean { return true; } }
const contractedBase = Base.prototype.save; // wrap it somehow first

class Derived extends Base {
    override save(payload: string): boolean { return true; }
}

mergeClassContracts(Derived); // walks Derived.prototype against nearest contracted ancestors
```

Rules:

- Only derived **own** prototype methods **with** contract metadata are rewrapped (no contracts conjured from nothing).
- The nearest same-name method carrying metadata below the derived level on the base chain wins; ancestors above it accumulate bottom-up — merge lower levels first for full-chain accumulation (this is what the decorator path does automatically at call time).
- The original wrappers are never mutated or reused; a fresh wrapper is defined with the original descriptor (`writable`/`enumerable`/`configurable` preserved).
- **Accessors are always skipped** (wrapping changes semantics, not just checks).
- `Object.prototype` / `Function.prototype` / `Object` are excluded from the walk.
- Static members merge only with `{ statics: true }`, against the constructor chain; `length`/`name`/`prototype` are skipped.
- `Base` defaults to the direct prototype ancestor; pass it explicitly to merge against a specific class.

## `mergeContractOptions(base?, derived?)`

The pure building block both paths use — also usable standalone:

```ts
import { mergeContractOptions } from 'design-contracts';

const merged = mergeContractOptions(baseOptions, derivedOptions);
// or: undefined when both are absent; same reference returned when only one side is defined
```

Semantics, exactly:

- `pre`: both sides non-empty → `[any(all(...base.pre), all(...derived.pre))]`; one-sided lists pass through verbatim (same reference); empty/sparse arrays are compacted first. If *base* is absent, `derived.pre` is verbatim — strengthening over nothing is the caller's choice.
- `post` / `onError`: `[...base, ...derived]`, base first.
- `old` / `mode` / `name` / `captureStack` / `message`: `derived ?? base`.
- Both absent → `undefined`; exactly one side defined → the **same reference** is returned; both defined → a new object is returned.
- Contract options do not carry `invariant` — object invariants must keep your full ancestor union by convention (see [object-contracts.md](./object-contracts.md)).

## Deep hierarchies

```ts
class Grand { @contractMethod({ post: [isPositive] })   total(): number { return 1; } }
class Mid   extends Grand { @contractMethod({ post: [isInteger] }) override total() { return 2; } }
class Leaf  extends Mid   { @contractMethod({ post: [isFinite] })  override total() { return 3; } }
```

After the first call on a `Leaf`, the effective post list is `[isPositive, isInteger, isFinite]` (grandparent first) — call-time recursion accumulates fully merged views bottom-up, independent of call order or construction order.

## Introspecting merged contracts

```ts
import { getContractMetadata, hasContractMetadata } from 'design-contracts';

hasContractMetadata(someFn);          // true iff fn carries contract metadata
const meta = getContractMetadata(someFn);
meta?.name;                           // effective contract name
meta?.options.post?.length;           // merged post list length
```

- `getContractMetadata(fn)` reads the wrapper's metadata. Before the first call on a decorator-wrapped method, this reports the own (provisional) options; after the first call, the fully merged ones.
- `attachContractMetadata(fn, meta)` writes the same symbol-based metadata onto raw wrappers — useful in tests and for manual wrapping.
- The metadata symbol is realm-global (`Symbol.for('design-contracts/contract')`), so metadata survives dual ESM/CJS loading. Shape is validated on read.

## Choosing a path

| Situation | Path |
| --- | --- |
| New code, TypeScript, standard decorators | `@contractMethod` |
| JS project or legacy decorators | `contract()` + `mergeClassContracts(Derived, Base?)` |
| Fine-grained manual merges (e.g. generated code) | `mergeContractOptions` |
| Migrating an existing prototype-based hierarchy | `mergeClassContracts` once, then leave it |
