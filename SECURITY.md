# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report them privately via GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/bejiihiu/node-contracts/security) of the repository.
2. Click "Report a vulnerability".
3. Provide a description, reproduction steps and potential impact.

You should receive an acknowledgement within 72 hours. If the report is accepted, a fix will be developed and released as a patch version, and you will be credited in the release notes unless you prefer otherwise.

## Scope

In scope:

- Contract evaluation bypassing `off` mode or other enforcement configuration
- Information leakage through error contexts or audit payloads
- Prototype pollution or unsafe snapshot handling
- Dependency vulnerabilities in the published package

Out of scope:

- Issues in applications that misuse the library (contracts are a safety net, not a sandbox)
- Denial of service caused by inherently expensive user-supplied predicates

## Disclosure policy

We follow coordinated disclosure. Please allow reasonable time for a fix to be released before public discussion.
