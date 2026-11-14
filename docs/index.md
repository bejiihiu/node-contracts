# design-contracts documentation

Design by Contract for JavaScript and TypeScript — preconditions, postconditions, invariants, and assertions, enforced at runtime, auditable in production.

## Start here

| Page | What it covers |
| --- | --- |
| [getting-started.md](./getting-started.md) | Install, first contract, what happens on violation, TypeScript & decorators setup |
| [concepts.md](./concepts.md) | DbC philosophy, contracts vs validation, when to use / when not |
| [migration.md](./migration.md) | Migrating three critical functions in 15 minutes; when not to adopt |

## Reference

| Page | What it covers |
| --- | --- |
| [api.md](./api.md) | Complete API reference — `contract()`, conditions, `assert`, `old`, merge, decorators, config, modes, `isContractsCompiledIn()`, errors overview, adapters overview |
| [errors.md](./errors.md) | Error hierarchy, `toJSON()`, message format, writing handlers, catching each type |
| [modes.md](./modes.md) | The five enforcement modes in depth, rollout recipes, per-contract and scoped modes |
| [inheritance.md](./inheritance.md) | Liskov rules, pre-disjunction, post union, decorators vs `mergeClassContracts()` |
| [async.md](./async.md) | Async contracts, async predicates, thenables, `withConfig` and concurrency |
| [object-contracts.md](./object-contracts.md) | `contractObject()` — proxies, invariants, method settle, direct writes |
| [adapters.md](./adapters.md) | pino / winston / OpenTelemetry / diagnostics_channel / console — full examples |
| [benchmarks.md](./benchmarks.md) | Methodology, measured numbers (Node 24.2.0 / Bun 1.4.2), honest caveats |
| [faq.md](./faq.md) | Frequent questions — production safety, Zod, minification, decorators, browser |

## Contributing

| Page | What it covers |
| --- | --- |
| [contributing.md](./contributing.md) | Dev flow summary — shortcut to the repository's contributing guide |

## Examples

Runnable, numbered examples live in [../examples/README.md](../examples/README.md) — each doc page links to the ones it references.
