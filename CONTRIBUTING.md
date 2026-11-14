# Contributing to node-contracts

Thanks for your interest in contributing! This document explains how to get involved.

## Ways to contribute

- Report bugs and propose features via GitHub Issues
- Improve documentation
- Submit pull requests with fixes or new functionality
- Add examples and integration guides

## Development setup

Requirements:

- [Bun](https://bun.sh) >= 1.1 (package manager, build, tests)
- Node.js >= 18 (runtime compatibility target)
- Git

```sh
git clone https://github.com/bejiihiu/node-contracts.git
cd node-contracts
bun install
bun run test
```

## Workflow

1. Fork the repository and create a branch from `main`: `feature/<short-name>` or `fix/<short-name>`.
2. Make your changes. Keep them focused — one pull request per logical change.
3. Add or update tests. New behavior without tests will not be merged.
4. Make sure all checks pass locally:
   - `bun run test`
   - `bun run typecheck`
   - `bun run lint`
   - `bun run build`
5. Open a pull request using the provided template.

## Coding standards

- TypeScript, strict mode — no `any` unless absolutely unavoidable and justified in a comment.
- Public API must be fully typed and documented with JSDoc.
- Comments explain _why_, not _what_. Keep them short and in English.
- User-facing strings (errors, docs) must be grammatically correct English.
- No runtime dependencies unless discussed first in an issue.
- Error messages must be stable and machine-detectable where practical (error classes carry structured fields).

## Commit messages

Conventional Commits, subject line at or below 50 characters:

```
feat: add async postcondition support
fix: skip predicates entirely when mode is off
docs: document audit mode
```

## Reporting bugs

Include:

- node-contracts version, Node/Bun version, OS
- Minimal reproduction (a small runnable snippet or repository)
- Expected vs actual behavior

## Code of Conduct

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
