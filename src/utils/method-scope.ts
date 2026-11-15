/**
 * Tracking for "this code runs inside a wrapped method".
 *
 * `contractObject()` defers invariant checks that happen on the `set` trap
 * inside a wrapped method to the post-settle check — one check per method
 * boundary instead of one per assignment. "Inside a method" needs to survive
 * `await`s, so it is tracked with `AsyncLocalStorage` when the runtime has it
 * (node >= 12.20, bun, deno): the scope propagates across `await` points and
 * through continuations scheduled inside the method's dynamic extent, which
 * is exactly the window in which external writes must NOT be mistaken for
 * in-method writes... and in-method writes must not trigger per-assignment
 * checks either.
 *
 * Detection is lazy: nothing is probed at import time, the first actual
 * scope operation resolves AsyncLocalStorage (and caches the result).
 * The probe is layered, mirroring the runtime context module:
 * 1. `process.getBuiltinModule('async_hooks')` (node >= 20.16 / >= 22.3, bun)
 * 2. `process.getBuiltinModule('module').createRequire(...)` → `node:async_hooks` (older node ESM)
 * 3. plain `require('node:async_hooks')` (CJS builds, CommonJS-ish hosts)
 *
 * Scopes nest per call: every wrapped-method invocation pushes a node that
 * carries its owner wrapper and a link to the enclosing scope. Membership is
 * checked by walking the chain, so two different wrappers stay independent —
 * the scope of one never suppresses checks on the other, and a nested call
 * to wrapper B from wrapper A's method pushes B's node without dropping A's.
 *
 * Runtimes without AsyncLocalStorage (some edge hosts) get a best-effort
 * fallback: a synchronous depth counter per owner. It only covers the
 * synchronous phase of the method — writes in async continuations after an
 * `await` check eagerly at the assignment site instead of deferring to the
 * settle check. The settle check itself always runs, so violations are still
 * caught, just reported eagerly (and possibly more than once per method).
 * Documented degradation, not a bug.
 */

interface ScopeNode {
    readonly owner: object;
    readonly parent: ScopeNode | undefined;
}

interface AsyncLocalStorageLike<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
}

interface ProcessWithGetBuiltinModule {
    getBuiltinModule?: (id: string) => unknown;
    cwd?: () => string;
}

const processWithProbe = (): ProcessWithGetBuiltinModule | undefined => {
    const candidate = (globalThis as { process?: unknown }).process;
    if (candidate === null || typeof candidate !== 'object') {
        return undefined;
    }
    return candidate as ProcessWithGetBuiltinModule;
};

const asAsyncLocalStorageCtor = (
    value: unknown,
): (new () => AsyncLocalStorageLike<ScopeNode>) | undefined => {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const ctor = (value as { AsyncLocalStorage?: unknown }).AsyncLocalStorage;
    return typeof ctor === 'function'
        ? (ctor as new () => AsyncLocalStorageLike<ScopeNode>)
        : undefined;
};

// layer 1 — process.getBuiltinModule('async_hooks') (node >= 20.16 / >= 22.3, bun)
const probeViaGetBuiltinModule = (): AsyncLocalStorageLike<ScopeNode> | undefined => {
    const proc = processWithProbe();
    const getBuiltinModule = proc?.getBuiltinModule;
    if (typeof getBuiltinModule !== 'function') {
        return undefined;
    }
    try {
        const ctor = asAsyncLocalStorageCtor(getBuiltinModule.call(proc, 'async_hooks'));
        return ctor === undefined ? undefined : new ctor();
    } catch {
        return undefined;
    }
};

// layer 2 — createRequire from the module builtin (older node ESM)
const probeViaCreateRequire = (): AsyncLocalStorageLike<ScopeNode> | undefined => {
    const proc = processWithProbe();
    const getBuiltinModule = proc?.getBuiltinModule;
    if (typeof getBuiltinModule !== 'function') {
        return undefined;
    }
    try {
        const moduleModule = getBuiltinModule.call(proc, 'module') as
            | { createRequire?: (filename: string) => (id: string) => unknown }
            | undefined;
        if (typeof moduleModule?.createRequire !== 'function') {
            return undefined;
        }
        const cwd = typeof proc?.cwd === 'function' ? proc.cwd() : '/';
        const require_ = moduleModule.createRequire(`${cwd}/design-contracts.cjs`);
        const ctor = asAsyncLocalStorageCtor(require_('node:async_hooks'));
        return ctor === undefined ? undefined : new ctor();
    } catch {
        return undefined;
    }
};

// layer 3 — plain require('node:async_hooks') (CJS builds, CommonJS-ish hosts)
const probeViaPlainRequire = (): AsyncLocalStorageLike<ScopeNode> | undefined => {
    const candidate = (globalThis as { require?: unknown }).require;
    if (typeof candidate !== 'function') {
        return undefined;
    }
    try {
        const ctor = asAsyncLocalStorageCtor(
            (candidate as (id: string) => unknown)('node:async_hooks'),
        );
        return ctor === undefined ? undefined : new ctor();
    } catch {
        return undefined;
    }
};

// null = not probed yet. Probed once, lazily, then cached forever.
let als: AsyncLocalStorageLike<ScopeNode> | undefined | null = null;
const fallbackDepth = new WeakMap<object, number>();

const asyncLocalStorage = (): AsyncLocalStorageLike<ScopeNode> | undefined => {
    if (als === null) {
        als = probeViaGetBuiltinModule() ?? probeViaCreateRequire() ?? probeViaPlainRequire();
    }
    return als ?? undefined;
};

/**
 * True when code for `owner`'s wrapped method is in flight in the current
 * async flow — sync execution or any continuation scheduled inside it.
 */
export function isInsideMethodScope(owner: object): boolean {
    const store = asyncLocalStorage();
    if (store === undefined) {
        return (fallbackDepth.get(owner) ?? 0) > 0;
    }
    for (let node = store.getStore(); node !== undefined; node = node.parent) {
        if (node.owner === owner) {
            return true;
        }
    }
    return false;
}

/**
 * Run `fn` with a method scope for `owner` pushed.
 *
 * With AsyncLocalStorage the scope covers `fn`'s synchronous body, any
 * `await`s inside it, and callbacks attached while it runs (including the
 * `.then` continuations this module's consumers hang on returned thenables).
 * Without it, only the synchronous body is covered — see the module docs.
 */
export function runMethodScope<R>(owner: object, fn: () => R): R {
    const store = asyncLocalStorage();
    if (store !== undefined) {
        return store.run({ owner, parent: store.getStore() }, fn);
    }
    fallbackDepth.set(owner, (fallbackDepth.get(owner) ?? 0) + 1);
    try {
        return fn();
    } finally {
        const depth = (fallbackDepth.get(owner) ?? 1) - 1;
        if (depth <= 0) {
            fallbackDepth.delete(owner);
        } else {
            fallbackDepth.set(owner, depth);
        }
    }
}
