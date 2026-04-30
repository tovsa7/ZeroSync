# @tovsa7/zerosync-client

[![CI](https://github.com/tovsa7/ZeroSync/actions/workflows/ci.yml/badge.svg)](https://github.com/tovsa7/ZeroSync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tovsa7/zerosync-client)](https://www.npmjs.com/package/@tovsa7/zerosync-client)
[![Socket Badge](https://badge.socket.dev/npm/package/@tovsa7/zerosync-client)](https://socket.dev/npm/package/@tovsa7/zerosync-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12456/badge)](https://www.bestpractices.dev/projects/12456)

**End-to-end encrypted real-time collaboration SDK. The server never sees plaintext.**

Add Google Docs-style multi-user editing, presence, and chat to any web app — with cryptographic zero-knowledge guarantees. Built on WebRTC, Yjs CRDTs, and AES-256-GCM via the browser's native Web Crypto API. No third-party crypto libraries.

- ✅ Zero-knowledge server — keys never leave the browser
- ✅ Peer-to-peer via WebRTC DataChannel, encrypted relay fallback
- ✅ CRDT sync via Yjs — works with Tiptap, CodeMirror, Quill, ProseMirror, etc.
- ✅ **Encrypted-at-rest persistence** (v0.2.0+) — Yjs state survives page reloads, IndexedDB row is ciphertext only
- ✅ Self-hosted in one Docker command ([guide](https://github.com/tovsa7/ZeroSync/blob/main/SELF-HOSTED.md))
- ✅ Comprehensive test suite — property-based via `fast-check`, integration, and headless-browser E2E
- ✅ SLSA provenance on every release, OpenSSF Best Practices badge

## Use cases

Products where two or more humans collaborate on sensitive content — and "your server cannot read it" is itself a feature:

- **Legal tech** — privileged attorney-client work, live document redlines, e-signing ceremonies
- **Mental health / therapy** — therapist-client sessions with notes, homework, chat
- **Finance** — token deal rooms, M&A data rooms, OTC coordination
- **Regulated SaaS with EU customers** — DPA-grade architecture you can show during procurement

## Install

```bash
npm install @tovsa7/zerosync-client yjs
```

### Using React?

See the companion package [`@tovsa7/zerosync-react`](https://www.npmjs.com/package/@tovsa7/zerosync-react) for declarative hooks (`useYText`, `usePresence`, `useMyPresence`, …). It wraps this SDK and handles Room lifecycle, re-rendering, and cleanup for you.

```bash
npm install @tovsa7/zerosync-react @tovsa7/zerosync-client react yjs
```

## Quick start

```typescript
import { Room, deriveRoomKey } from '@tovsa7/zerosync-client'

// Room key is derived client-side and never transmitted.
const userSecret = crypto.getRandomValues(new Uint8Array(32))
const roomKey    = await deriveRoomKey(userSecret, 'my-room-id')

const room = await Room.join({
  serverUrl:  'wss://your-server/ws',
  roomId:     'my-room-id',
  roomKey,
  peerId:     crypto.randomUUID(),
  nonce:      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
  hmac:       '',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
})

// Shared Yjs document — all edits encrypted before broadcast.
const doc  = room.getDoc()
const text = doc.getText('editor')

text.observe(() => console.log(text.toString()))

// Presence — broadcasts encrypted awareness state to peers.
room.updatePresence({ name: 'Alice' })
room.onPresence(peers => {
  for (const [peerId, state] of peers) console.log(peerId, state.name)
})

// Connection status subscription.
room.onStatus(status => console.log(status))
// 'connected' | 'reconnecting' | 'closed'

room.leave()
```

## How it works

```
Browser A                 ZeroSync Server              Browser B
    │                           │                           │
    ├── encrypt(data, key) ─────┤                           │
    │                           │                           │
    │◄══════════ WebRTC DataChannel (P2P) ════════════════►│
    │                           │  relay fallback only      │
    │                      ciphertext                       │
    │                   (server cannot decrypt)             │
```

Peers connect P2P by default. When P2P fails (NAT/firewall), the signaling server acts as an encrypted relay — it sees only opaque ciphertext blobs (max 64 KB, 30 s TTL). The server logs only SHA-256-hashed identifiers.

## Encrypted-at-rest persistence

Pages reload. Browsers crash. Without persistence, every session starts from
zero. `EncryptedPersistence` keeps the merged Yjs state in IndexedDB, encrypted
with a key derived from your `userSecret` but **independent of the wire
roomKey**. When the tab reopens, the doc is restored from disk **before**
`Room.join()` resolves — no flash of empty editor, no waiting on peers.

```typescript
import {
  Room,
  EncryptedPersistence,
  deriveRoomKey,
  derivePersistKey,
} from '@tovsa7/zerosync-client'

// Same userSecret yields two domain-separated keys via HKDF.
const userSecret = crypto.getRandomValues(new Uint8Array(32))
const [roomKey, persistKey] = await Promise.all([
  deriveRoomKey(userSecret,    'my-room-id'),
  derivePersistKey(userSecret, 'my-room-id'),
])

const persistence = await EncryptedPersistence.open({
  roomId: 'my-room-id',
  key:    persistKey,
})

const room = await Room.join({
  serverUrl:  'wss://your-server/ws',
  roomId:     'my-room-id',
  roomKey,
  peerId:     crypto.randomUUID(),
  nonce:      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
  hmac:       '',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  persistence,
})

// On unmount / page navigation:
window.addEventListener('beforeunload', () => {
  room.leave()         // flushes pending save inside CRDTSync.stop()
  persistence.close()  // close AFTER leave() so the final flush lands
})
```

**What it does:**

- **Per-room IDB database** — name `zerosync-persistence-{roomId}`. Wipe one room without touching others: `indexedDB.deleteDatabase('zerosync-persistence-' + roomId)`.
- **AES-256-GCM** — same wire format as message encryption (12-byte IV + ciphertext+tag). On-disk row is opaque bytes; nothing in IDB is plaintext.
- **Debounced saves** — 500 ms window coalesces rapid edits into single writes. Local edits **and** remote merges (SYNC_RES) both trigger save, so on-disk state tracks the merged document, not just local changes.
- **Flush on hide** — `visibilitychange → hidden` and `pagehide` flush pending saves immediately, surviving tab close and BFCache eviction.
- **Restore failure recovery** — tampered row, wrong key, or corruption → load returns silently, sync continues with peer SYNC_RES, and the next save overwrites the bad row. No spinner, no broken state.

### Domain separation

Wire encryption and at-rest encryption use **independent keys** derived from the same `userSecret`:

| Helper | HKDF `info` | Purpose |
|--------|-------------|---------|
| `deriveRoomKey(secret, roomId)` | `"zerosync-room:{roomId}"` | Encrypts WebRTC + relay traffic |
| `derivePersistKey(secret, roomId)` | `"zerosync-persist:{roomId}"` | Encrypts IndexedDB rows |

A leak of the on-disk key cannot decrypt wire traffic captured from the network, and a leak of the wire key cannot decrypt IndexedDB rows. Same `userSecret`, distinct cryptographic domains.

### Lifecycle: caller owns it

`Room.leave()` does **NOT** close `EncryptedPersistence`. You opened it, you close it. This lets you keep persistence around across multiple `Room.join()` cycles for the same room (e.g. signaling reconnects), or share state with a worker. Order matters:

```typescript
room.leave()         // flushes the final save (CRDTSync.stop → flushSave)
persistence.close()  // then close the IDB connection
```

## API

### `Room.join(opts)` → `Promise<Room>`

| Option | Type | Description |
|--------|------|-------------|
| `serverUrl` | `string` | WebSocket URL of the signaling server |
| `roomId` | `string` | Room identifier (opaque to the server) |
| `roomKey` | `CryptoKey` | AES-256-GCM key — never transmitted |
| `peerId` | `string` | UUIDv4 for this peer |
| `nonce` | `string` | Base64 random bytes for HELLO replay protection |
| `hmac` | `string` | HMAC-SHA-256 of the HELLO message (`""` while opt-in) |
| `iceServers` | `RTCIceServer[]` | ICE servers for WebRTC. Pass `[]` to disable STUN (same-network P2P only). |
| `persistence` _(optional)_ | `EncryptedPersistence` | Encrypted-at-rest IndexedDB store. When set, stored state is loaded and applied to the doc **before** `Room.join` resolves; subsequent updates are saved on a 500 ms debounce. Caller owns lifecycle. |

### Room methods

| Method | Returns | Purpose |
|--------|---------|---------|
| `getDoc()` | `Y.Doc` | Shared Yjs document |
| `updatePresence(state)` | `void` | Broadcast presence state to all peers |
| `onPresence(cb)` | `() => void` | Subscribe to presence changes; returns unsubscribe |
| `getPresence()` | `ReadonlyMap<string, PresenceState>` | Current peer presence snapshot |
| `onStatus(cb)` | `() => void` | Subscribe to connection status changes |
| `getConnectionSummary()` | `{ total: number; p2p: number }` | Peer count + P2P vs relay breakdown |
| `leave()` | `void` | Disconnect, clean up all resources |

### `deriveRoomKey(secret, roomId)` → `Promise<CryptoKey>`

Derives a non-extractable AES-256-GCM key via HKDF-SHA-256 with `info="zerosync-room:{roomId}"`. Used for wire encryption. Store `secret` (32 bytes), not the derived key.

### `derivePersistKey(secret, roomId)` → `Promise<CryptoKey>`

Derives a non-extractable AES-256-GCM key via HKDF-SHA-256 with `info="zerosync-persist:{roomId}"`. Used for IndexedDB at-rest encryption. **Domain-separated** from `deriveRoomKey` — same `secret` + same `roomId` yields a different key.

### `EncryptedPersistence`

Per-room IndexedDB store with AES-256-GCM applied transparently before write and after read.

| Method | Returns | Purpose |
|--------|---------|---------|
| `static open({ roomId, key })` | `Promise<EncryptedPersistence>` | Open or create the IDB database `zerosync-persistence-{roomId}`. |
| `load()` | `Promise<Uint8Array \| null>` | Decrypt and return the stored Yjs state, or `null` if nothing has been saved yet. Throws on tampered / wrong-key / corrupted rows. |
| `save(state)` | `Promise<void>` | Encrypt `state` and write to IDB. Resolves once the transaction commits. |
| `clear()` | `Promise<void>` | Remove the stored row so subsequent `load()` returns `null`. |
| `close()` | `void` | Close the IDB connection. Subsequent operations throw. Idempotent. |

In normal use you don't call these directly — pass `persistence` to `Room.join` and `CRDTSync` handles load/save automatically. Direct calls are useful for tests, "Save and Close" UX, or wiping local state on logout.

## Self-hosting

Run your own signaling server in one command:

```bash
docker run -p 8080:8080 ghcr.io/tovsa7/zerosync-server:latest
```

For production (auto-TLS, multi-peer relay, license enforcement): see the [self-hosted guide](https://github.com/tovsa7/ZeroSync/blob/main/SELF-HOSTED.md).

## Security

| Property | Detail |
|----------|--------|
| Encryption | AES-256-GCM via Web Crypto API |
| IV | 12 random bytes per message — never reused |
| Key derivation | HKDF-SHA-256 |
| Server visibility | Hashed room/peer IDs + ICE candidates only |
| Peer auth | AES-GCM challenge-response handshake on DataChannel open |
| Relay blobs | Max 64 KB · TTL 30 s · opaque ciphertext |
| Third-party crypto | None — `crypto.subtle` only |

Full threat model + disclosure process: [SECURITY.md](https://github.com/tovsa7/ZeroSync/blob/main/SECURITY.md).

## Browser support

Requires Web Crypto API, WebRTC DataChannel, and WebSocket.
Chrome 89+, Firefox 78+, Safari 15+, Edge 89+.

## Pricing

Open-core model: client SDK is MIT, signaling server is BSL 1.1 (free for dev/test, paid for production).

See [pricing tiers](https://github.com/tovsa7/ZeroSync#pricing) on the main repo — from Community (free, dev/test) to Enterprise ($25K+/yr, unlimited + SLA).

## License

MIT — see [LICENSE](../../LICENSE).

## Links

- **Main repo**: https://github.com/tovsa7/ZeroSync
- **React hooks**: [@tovsa7/zerosync-react](https://www.npmjs.com/package/@tovsa7/zerosync-react)
- **Live demo**: https://tovsa7.github.io/ZeroSync
- **Commercial / enterprise**: contact.zerosync@proton.me
