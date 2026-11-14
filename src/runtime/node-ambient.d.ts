// Minimal ambient declarations for the two node builtins we touch.
// The package intentionally ships without @types/node; only the exact
// surface we use is declared here. Keep in sync with what context.ts consumes.

declare module 'node:async_hooks' {
    export class AsyncLocalStorage<T> {
        getStore(): T | undefined;
        run<R>(store: T, callback: () => R): R;
        disable(): void;
    }
}

declare module 'node:module' {
    export function createRequire(filename: string): (id: string) => unknown;
}
