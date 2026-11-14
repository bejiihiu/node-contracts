/**
 * Compile-time flag for stripping contract machinery out of production
 * bundles.
 *
 * The library reads a single global constant, `__DESIGN_CONTRACTS_ENABLED__`,
 * through a `typeof` guard. When that constant is defined as `false`,
 * `isContractsCompiledIn()` folds to `false` and contract checks stop
 * executing entirely. What survives in the emitted bundle — and what gets
 * removed — depends on your minifier (see the two layers below).
 *
 * "Compiled out" comes in two layers, and they are not the same thing:
 *
 * - Behavior (always guaranteed): when the constant is `false`,
 *   `isContractsCompiledIn()` is `false`, `canSkip()` returns `true`
 *   before resolving anything, and predicates never execute. Nothing
 *   about your program's observable behavior depends on the checks.
 * - Physical removal (minifier-dependent): the constant folds inside this
 *   module, but whether the dead branches elsewhere disappear depends on
 *   the minifier's willingness to inline trivial functions. esbuild's
 *   minifier folds `isContractsCompiledIn` to `() => false` but does not
 *   inline cross-module calls, so the gated branches remain in the bundle
 *   (unreachable, not removed). terser's `compress` (multi-pass, with
 *   function inlining) does drop them. For the strongest guarantee, the
 *   check must be textually visible at the call site — that is a property
 *   of the contract wrapper, not of this flag.
 *
 * Default behavior: when no bundler defines the constant, `typeof` on the
 * undeclared identifier evaluates to `'undefined'` and contracts stay
 * ON. You have to opt out explicitly — silence never disables checks.
 *
 * Setup examples
 *
 * esbuild (build script):
 *
 *   import { build } from 'esbuild';
 *
 *   await build({
 *     entryPoints: ['src/index.ts'],
 *     bundle: true,
 *     minify: true,
 *     define: {
 *       __DESIGN_CONTRACTS_ENABLED__: 'false',
 *     },
 *   });
 *
 * tsup (tsup.config.ts):
 *
 *   import { defineConfig } from 'tsup';
 *
 *   export default defineConfig({
 *     entry: ['src/index.ts'],
 *     format: ['esm', 'cjs'],
 *     minify: true,
 *     esbuildOptions(options) {
 *       options.define = {
 *         ...options.define,
 *         __DESIGN_CONTRACTS_ENABLED__: 'false',
 *       };
 *     },
 *   });
 *
 * Vite (vite.config.ts):
 *
 *   import { defineConfig } from 'vite';
 *
 *   export default defineConfig({
 *     define: {
 *       __DESIGN_CONTRACTS_ENABLED__: false,
 *     },
 *   });
 *
 * webpack (webpack.config.js), using the built-in DefinePlugin:
 *
 *   const webpack = require('webpack');
 *
 *   module.exports = {
 *     mode: 'production',
 *     plugins: [
 *       new webpack.DefinePlugin({
 *         __DESIGN_CONTRACTS_ENABLED__: 'false',
 *       }),
 *     ],
 *   };
 *
 * Rollup (rollup.config.js), using @rollup/plugin-replace:
 *
 *   import replace from '@rollup/plugin-replace';
 *
 *   export default {
 *     plugins: [
 *       replace({
 *         preventAssignment: true,
 *         values: {
 *           __DESIGN_CONTRACTS_ENABLED__: 'false',
 *         },
 *       }),
 *     ],
 *   };
 *
 * Gotchas that actually bite:
 *
 * - The replacement must be the bare boolean `false`, not the string
 *   `'"false"'`. A quoted value is a truthy string, so contracts would
 *   stay enabled while looking disabled — the worst outcome.
 * - Vite JSON.stringifies non-string `define` values, so a raw `false`
 *   there is fine; everywhere else pass the exact expression text.
 * - The `typeof` guard is deliberate: without a define, the identifier is
 *   undeclared and a bare reference would throw `ReferenceError`. It also
 *   keeps untransformed sources (tests, ts-node, plain `node`) working.
 * - Pair the define with minification. The constant folds inside this
 *   module either way, but removing the dead code elsewhere relies on
 *   your minifier inlining the trivial `isContractsCompiledIn()` — terser
 *   does this, esbuild's minifier does not. Behavior is identical either
 *   way: with the flag `false`, predicates never run. If the last few
 *   bytes genuinely matter, verify with your own bundle output instead of
 *   trusting any doc (this one included).
 * - To strip contracts only in production, define the constant from your
 *   bundler's mode flag, e.g. `define: {
 *     __DESIGN_CONTRACTS_ENABLED__:
 *       String(process.env.NODE_ENV !== 'production'),
 *   }`.
 */

// module-local ambient declaration: keeps this module type-safe without a
// global .d.ts, and it stays accurate when the define is absent (`undefined`).
declare const __DESIGN_CONTRACTS_ENABLED__: boolean | undefined;

/**
 * Returns `true` when contract checks are compiled into this build.
 *
 * Cheap to call: one `typeof` comparison and one boolean compare, no
 * allocations, safe on hot paths. When a bundler defines
 * `__DESIGN_CONTRACTS_ENABLED__` to `false`, this folds to `false` after
 * constant replacement.
 */
export const isContractsCompiledIn = (): boolean =>
    typeof __DESIGN_CONTRACTS_ENABLED__ === 'undefined' || __DESIGN_CONTRACTS_ENABLED__ !== false;
