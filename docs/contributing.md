# Contributing

Short version: read [../CONTRIBUTING.md](../CONTRIBUTING.md) — it covers setup, workflow, and standards. This page is the 60-second summary for documentation-adjacent work.

## Dev flow

```sh
git clone https://github.com/bejiihiu/node-contracts.git
cd node-contracts
bun install
bun run test       # vitest run — must stay green
bun run typecheck  # tsc --noEmit
bun run lint       # biome check .
bun run build      # tsup — ESM+CJS+d.ts
bun run examples/01-basic.ts   # examples must keep running
bun run bench      # benchmarks/contract.bench.ts
```

Ground rules from the repo's contributing guide:

- One logical change per pull request.
- New behavior needs tests; no tests, no merge.
- TypeScript strict, no `any` without justification, public API fully typed.
- No runtime dependencies without prior discussion in an issue.
- Conventional Commits, subject ≤ 50 characters (`feat:`, `fix:`, `docs:`, ...).
- Error messages must be stable and machine-detectable.

## Changing behavior? Read this first

This library's mode semantics (`strict`/`warn`/`silent`/`audit`/`off`), Liskov merge rules, and predicate-skip guarantees are documented behavior. If your change would alter any of them, open an issue first — those are the contract with the users, and changing them silently is how trust dies.

## Documentation

Docs live in `docs/` (this directory). When you change user-facing behavior:

1. Update the affected page in the same PR.
2. Keep examples runnable — the snippets mirror `examples/*.ts`; if an example changes, sync the docs to it.
3. Two audiences matter: humans reading sequentially (getting-started → concepts → modes) and people jumping straight to the API reference. Keep both in mind.

## Reporting bugs

Use the issue tracker with: version, Node/Bun version, OS, and a minimal reproduction. Contract bugs are almost always “the contract rejected something it shouldn't have” or “the violation surfaced at the wrong time” — a small runnable snippet settles them fast.
