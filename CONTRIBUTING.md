# Contributing to ZeroSync

Thank you for your interest in contributing! This document explains how to participate in the project.

## Ways to Contribute

- Report bugs via [GitHub Issues](https://github.com/tovsa7/ZeroSync/issues)
- Request features via [GitHub Issues](https://github.com/tovsa7/ZeroSync/issues)
- Submit pull requests for bug fixes or improvements
- Improve documentation

## Reporting Bugs

Open an issue and include:
- ZeroSync version (`@tovsa7/zerosync-client` version from `package.json`)
- Browser / Node.js version
- Minimal reproduction steps
- Expected vs. actual behavior

For security vulnerabilities, do **not** open a public issue — follow the process in [SECURITY.md](SECURITY.md).

## Pull Request Process

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b fix/short-description
   ```
2. Make your changes (see [Local Development](#local-development) below).
3. Add or update tests for any changed behavior (see [Testing Policy](#testing-policy)).
4. Ensure all checks pass:
   ```bash
   npm test
   npm run typecheck
   npm run build
   ```
5. Open a pull request against `main`. Describe what changed and why.

Pull requests are reviewed by maintainers. Please keep PRs focused — one logical change per PR.

## Local Development

**Prerequisites:** Node.js ≥ 18, npm ≥ 9.

```bash
# Clone the repo
git clone https://github.com/tovsa7/ZeroSync.git
cd ZeroSync

# Install dependencies
npm install

# Run the test suite
npm test

# Type-check without emitting
npm run typecheck

# Build the SDK (ESM + CJS)
npm run build
```

The demo app lives in `demo/` and can be run separately with `npm run dev` from that directory (requires a running signaling server).

## Testing Policy

**All significant changes must be accompanied by tests.**

- Bug fixes: add a regression test that would have caught the bug
- New features: add tests covering the new behavior and edge cases
- Refactors: ensure existing tests continue to pass without modification

Tests live alongside source files in `packages/client/src/` and use [Vitest](https://vitest.dev/). Run the full suite with:

```bash
npm test
```

The CI pipeline runs `npm test` and `npm run typecheck` on every push and pull request. A PR will not be merged if tests fail.

## Coding Standards

- **TypeScript strict mode** is enforced (`strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Do not disable strict flags.
- Keep the public API surface minimal. New exports require discussion.
- Follow the existing naming conventions (camelCase for variables/functions, PascalCase for classes/types).
- Do not introduce runtime dependencies without prior discussion in an issue.

## Cryptographic Changes

ZeroSync's security model relies on specific cryptographic primitives (AES-256-GCM, HKDF-SHA-256, Web Crypto API). Changes to cryptographic code require:

1. An issue explaining the motivation and threat model impact
2. Review by a maintainer with cryptographic background
3. Updated tests in `crypto.test.ts`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) that covers the client SDK.
