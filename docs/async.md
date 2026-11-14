# Async Functions

Contracts work transparently over async functions. This page covers what the wrapper does with promises, async predicates, thenables, and concurrency.

## The basics

```ts
import { contract } from 'design-contracts';

const fetchUser = contract(
    async function fetchUser(id: string): Promise<User | null> {
        return db.get(id);
    },
    {
        pre: [(id) => id.trim().length > 0],
        post: [(user) => user !== null],
    },
);
```

- **Preconditions** still run synchronously before the body is invoked — before the first `await` even schedules. In `strict` mode a violated precondition throws **synchronously** (the call site sees the exception, not a rejected promise).
- **Postconditions** run after the promise **resolves**, on the resolved value — never on the raw promise. `post: [(user) => user !== null]` checks `User | null`, not `Promise<User | null>`.
- If the promise **rejects**, postconditions do not run. `onError` predicates run instead, receiving the rejection reason.
- The returned promise is a **derived** promise — the original from `fn` is not handed to the caller, but it flows through intact: same resolution value, same rejection (unless an on-error contract fails, see below).

## Async predicates

All three sections (`pre`, `post`, `onError`) accept async predicates — but only inside contracts whose wrapped function is async (or otherwise returns a thenable):

```ts
const verified = contract(
    async function verified(token: string): Promise<Session> {
        return sessions.open(token);
    },
    {
        // async predicate — fine, fn is async
        pre: [async (token) => (await revocationList.has(token)) === false],
    },
);
```

Async predicates are awaited, in declaration order, before/after the phases they guard.

**Synchronous call path + async predicate → `TypeError`.** A contract cannot suspend a synchronous call, so instead of silently returning a truthy thenable (which would always "pass"), the wrapper throws:

```ts
const broken = contract((n: number) => n * 2, {
    pre: [async (n) => n > 0], // fn is sync
});
broken(1); // TypeError: contract(): async predicate used in a synchronous call path
```

This is the single most important rule to know. If you want async predicates, your function must return a thenable.

### Async predicates inside composites

Composite conditions (`all` / `any` / `not`) also await their children when the composite settles asynchronously:

```ts
const trusted = all(notBlank, asyncEmailCheck); // fine inside an async contract
```

Every predicate still executes exactly once. Composites short-circuit on the async path just like the sync one (`all` on first false, `any` on first true).

## Error path

```ts
const charge = contract(chargeImpl, {
    onError: [(error) => error instanceof GatewayError],
});

try {
    await charge(card, 1000);
} catch (error) {
    // GatewayError → propagates untouched (on-error contract passed)
    // anything else → OnErrorViolationError (on-error contract failed)
}
```

- Postconditions are never evaluated on the error path.
- If the on-error predicates all pass (or none are configured), the original error flies — identity intact.
- If any on-error predicate fails in `strict` mode, the derived promise rejects with `OnErrorViolationError`. In `warn`/`audit` mode the violation is reported and the original error continues to fly.

## Thenables in general

`fn` may return any thenable, not just native promises — the wrapper detects `typeof value.then === 'function'` and treats it as a promise. A synchronous function returning a thenable gets the same async treatment as an `async` function.

- If every phase is skippable (`off`/`silent` mode or all categories disabled) **and** no `old` snapshot is needed, the wrapper takes a bare fast path: your thenable comes back untouched, identity and all.
- In `off`/`silent` modes predicates never run; in other modes the wrapper is visible in the rejection/resolution chain but passes values through.
- A predicate's thenable in a synchronous path → `TypeError` (see above).

## Concurrency and `withConfig`

Async scopes follow [AsyncLocalStorage](https://nodejs.org/api/async_context.html), so per-call configuration is correct under concurrency:

```ts
import { withConfig, contract } from 'design-contracts';

const audited = withConfig({ mode: 'audit', onAudit: ship }, () => processBatch(batch));
const plain   = withConfig({ mode: 'off' },                () => processBatch(batch));

await Promise.all([audited(), plain()]); // each sees its own mode — never each other's
```

- Configuration is snapshotted at wrapper entry; a `configure()` call made *during* an in-flight invocation is not observed by that invocation (documented "config snapshot semantics" — reconfiguring under a running call is racy by design).
- Nested `withConfig` frames compose outer→inner with inner winning per field; both are visible across `await`s inside their extent.
- On runtimes without `node:async_hooks` (exotic/edge hosts), the fallback is a synchronous stack only — scopes will not survive `await`. Node.js >= 18 and Bun both have AsyncLocalStorage.

## Parallel predicates?

Predicates are evaluated **sequentially**, in declaration order — even async ones. This is deliberate: deterministic order makes `conditionIndex` meaningful, makes predicate side effects predictable, and keeps the failure cause chain stable. If you need parallelism, parallelize inside the predicate itself.

## Common async mistakes

- Expecting a rejected promise when a sync predicate fails on an async function — in `strict` mode the violation throws synchronously, before `fn` is even called. Test for it with `expect(() => call()).toThrow`, not `await expect(call()).rejects.toThrow`.
- Assuming `post` sees a promise — it sees the resolved value. `ctx.result` is the same value.
- Writing async predicates inside `contract()` around a **synchronous** function — `TypeError`, by design.
- Snapshotting with `old` and expecting zero cost on hot async paths — `structuredClone` on every call adds up; see [benchmarks.md](./benchmarks.md).
