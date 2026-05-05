# Changelog

All notable changes to the `@tovsa7/zerosync-client` SDK are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [@tovsa7/zerosync-client 0.3.0] — 2026-05-05

### Added
- **`RoomJoinError`** — new exported error class thrown by `Room.join()` when
  the signaling handshake fails. Carries a `reason: 'capacity' | 'unreachable'
  | 'unknown'` field plus the original WebSocket error on `cause`.
- **`RoomJoinRejectReason`** — exported type alias for the `reason` field.
- **HEAD-fallback rejection detection.** After a WebSocket handshake failure,
  `Room.join()` issues a `GET /health` on the same origin to determine why:
  - HTTP 429 → `reason='capacity'` (per-IP cap reached on the server)
  - HTTP 5xx / fetch failure → `reason='unreachable'`
  - HTTP 200 → `reason='unknown'` (race: a slot freed up between the WS
    attempt and the probe, or the WS endpoint is broken while /health is fine)

  Browser WebSocket close events drop HTTP status, so without this probe a
  capacity rejection is indistinguishable from a network drop. Pair with
  `zerosync-self-hosted ≥ 0.2.0` whose `/health` is now cap-aware.

- **`Transport.closeAllPeers()`** — new public method that closes every
  RTCPeerConnection without tearing down signaling subscriptions.

### Changed
- **WebSocket reconnect handler now resets all peer connections.** When the
  signaling WS reconnects, stale `RTCPeerConnection`s (negotiated against the
  dropped session) are closed and the peer list is re-added with the correct
  lex-ordered initiator role. Previously, peers stayed relay-only for 30 s+
  after a WS reconnect — N1 in the 2026-05-05 pre-launch test report.
- The reconnect re-add now uses `isInitiator(peerId)` instead of an
  unconditional `true`. This fixes a latent glare scenario for peers that
  joined the room during the WS-disconnect window.
- `persistence.load() failed, starting fresh` is now logged at `console.info`
  instead of `console.warn` — the fresh-start fallback is the expected,
  correct behaviour, not an anomaly.

### Internal / tests
- 5 new tests for `Available()` on `ConnLimiter` (server-side counterpart).
- 6 new tests for `RoomJoinError` rejection paths (capacity, unreachable, 5xx,
  unknown, cause-propagation, derived-URL correctness).
- 2 new tests for `Transport.closeAllPeers()`.

---

## [@tovsa7/zerosync-react 0.3.0] — 2026-05-05

### Added
- **`'rejected'`** — new value in `ConnectionStatus` for `Room.join()` failures.
- **`RejectedReason`** — exported type alias matching the SDK's
  `RoomJoinRejectReason` (`'capacity' | 'unreachable' | 'unknown'`).
- **`useRejectedReason()`** — new hook. Returns the rejection cause when
  `status === 'rejected'`, else `null`. Pair with `useConnectionStatus()` to
  surface a precise UX message (e.g. "Server at capacity" vs "Server
  unavailable").
- `rejectedReason: RejectedReason | null` field on `ZeroSyncContextValue`.

### Changed — BREAKING
- **`'closed'` no longer means "Room.join rejected".** It is now reserved
  exclusively for the Provider-unmounted case (`leave()` was called). Failed
  joins produce `status === 'rejected'` with `useRejectedReason()` carrying
  the cause.

  **Migration:** if your code does `if (status === 'closed') showError(...)`,
  change it to `if (status === 'rejected') showError(useRejectedReason())`.

- `peerDependencies['@tovsa7/zerosync-client']` bumped from `^0.2.0` to
  `^0.3.0` — required for the `RoomJoinError` re-export.
- Provider's catch path now distinguishes `RoomJoinError` (forwards
  `err.reason`) from other rejections (collapses to `'unknown'`).

### Internal / tests
- 1 new test verifying `RoomJoinError.reason` propagates to context.
- Test mocks updated to include a stand-in `RoomJoinError` class.

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

[Unreleased]: https://github.com/tovsa7/ZeroSync/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/tovsa7/ZeroSync/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tovsa7/ZeroSync/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/tovsa7/ZeroSync/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/tovsa7/ZeroSync/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/tovsa7/ZeroSync/releases/tag/v0.1.5
