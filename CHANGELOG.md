# Changelog

All notable changes to the `@tovsa7/zerosync-client` SDK are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [@tovsa7/zerosync-react 0.2.1] — 2026-05-05

### Fixed
- **`react` is now correctly declared as a `peerDependency`** instead of a
  regular `dependency` in the published package. v0.2.0 incorrectly shipped
  with `react` as a direct dependency, which caused consumer apps to end up
  with two copies of React in their bundle and runtime failures like
  `Uncaught TypeError: Cannot read properties of null (reading 'useState')`
  the moment any hook (`useYText`, `usePresence`, …) ran. Local source
  already had the correct `peerDependencies` declaration — this release
  just rebuilds and republishes with that config so npm resolution dedupes
  React against the consumer app.

This is a packaging fix only — no behaviour change. `@tovsa7/zerosync-client`
is unaffected and stays on 0.2.0.

---

## [0.2.0] — 2026-04-30

### Added
- **Encrypted-at-rest persistence** (offline-first foundation)
  - New `EncryptedPersistence` class — per-room IndexedDB store with
    AES-256-GCM encryption applied transparently before write and after read.
    On-disk row is ciphertext only; the server, devtools, and disk forensics
    see only opaque blobs.
  - New `derivePersistKey(userSecret, roomId)` — HKDF-SHA-256 with
    `info="zerosync-persist:{roomId}"`, domain-separated from the wire
    `roomKey`. A leak of the on-disk key cannot decrypt wire traffic and
    vice versa.
  - New `RoomOptions.persistence?: EncryptedPersistence` — opt-in field on
    `Room.join`. When present, stored state is restored before `Room.join`
    resolves; subsequent local + remote doc updates are saved on a 500 ms
    debounce. `visibilitychange→hidden` and `pagehide` flush pending saves.
  - In `@tovsa7/zerosync-react`: new `persistKey?: CryptoKey` prop on
    `ZeroSyncProvider` — provider opens and closes the underlying
    `EncryptedPersistence` automatically.
  - `derivePersistKey` re-exported from `@tovsa7/zerosync-react` so React
    consumers don't need to take a direct dependency on the client SDK.

### Changed
- `CRDTSync.start()` is now async — awaits persistence load before
  resolving (no behaviour change when persistence is absent). `Room.join`
  awaits this internally; external callers see `Room.join` resolve once the
  doc is populated from disk.

### Security
- Wire-encryption and at-rest-encryption keys are independently derived;
  storage compromise does not enable wire-traffic decryption.
- Restore failure (tampered row, wrong key, corruption) is logged and
  swallowed — sync continues with peer SYNC_RES rather than blocking on a
  broken local cache.

---

## [Pre-0.2.0 Unreleased — security & infra]

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

[Unreleased]: https://github.com/tovsa7/ZeroSync/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tovsa7/ZeroSync/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/tovsa7/ZeroSync/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/tovsa7/ZeroSync/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/tovsa7/ZeroSync/releases/tag/v0.1.5
