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
- ✅ Self-hosted in one Docker command ([guide](https://github.com/tovsa7/ZeroSync/blob/main/SELF-HOSTED.md))
- ✅ 141 tests including property-based tests (`fast-check`)
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

Derives a non-extractable AES-256-GCM key via HKDF-SHA-256. Store `secret` (32 bytes), not the derived key.

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
