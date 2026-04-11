# Changelog

All notable changes to the `@tovsa7/zerosync-client` SDK are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Security
- Pin all GitHub Actions to commit SHAs to prevent supply-chain attacks
- Add `permissions: read-all` to CI workflows (principle of least privilege)
- Upgrade Vite to 6.4.2 — fixes esbuild CVE in demo dev server
- Upgrade Vitest to 3.x — fixes esbuild CVE in test runner
- Remove unused `encrypt` import in `crdt.ts` (flagged by CodeQL)

### Added
- CodeQL security scanning on every push, PR, and weekly schedule
- OpenSSF Scorecard analysis with results published to GitHub Security tab
- Dependabot for automated weekly dependency updates (npm, GitHub Actions)
- Security policy (`SECURITY.md`) with private vulnerability reporting and 72-hour SLA

---

## [0.1.7] — 2026-04-11

### Fixed
- CI publish workflow: remove `always-auth` before `npm publish` to prevent auth conflicts

---

## [0.1.6] — 2026-04-11

### Fixed
- Verified provenance publish flow with token authentication

---

## [0.1.5] — 2026-04-10

### Added
- Initial public release of `@tovsa7/zerosync-client`
- End-to-end encrypted real-time sync via WebRTC + Yjs CRDT
- AES-256-GCM encryption with HKDF-SHA-256 key derivation
- Room-based API: `new Room(roomId, key, iceServers)`
- Presence state synchronization
- ESM + CJS dual output with TypeScript declarations
- Provenance-signed npm publish workflow (`npm publish --provenance`)
- Pinned dependency versions for reproducible builds

### Fixed
- Normalize `repository.url` field in `package.json` for correct npm metadata

---

[Unreleased]: https://github.com/tovsa7/ZeroSync/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/tovsa7/ZeroSync/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/tovsa7/ZeroSync/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/tovsa7/ZeroSync/releases/tag/v0.1.5
