# ZeroSync

[![CI](https://github.com/tovsa7/ZeroSync/actions/workflows/ci.yml/badge.svg)](https://github.com/tovsa7/ZeroSync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tovsa7/zerosync-client)](https://www.npmjs.com/package/@tovsa7/zerosync-client)
[![Socket Badge](https://badge.socket.dev/npm/package/@tovsa7/zerosync-client)](https://socket.dev/npm/package/@tovsa7/zerosync-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12456/badge)](https://www.bestpractices.dev/projects/12456)

**Real-time collaboration where the server cannot read your data.**

ZeroSync adds end-to-end encrypted real-time sync to any app. Built on WebRTC and Yjs — peers connect directly, share a CRDT document, and the signaling server sees only opaque ciphertext. Self-hosted in one Docker command.

**[Try the demo →](https://tovsa7.github.io/ZeroSync)**

---

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

- **P2P by default** — peers connect directly via WebRTC DataChannel
- **Relay fallback** — encrypted blobs only, server sees opaque ciphertext
- **Zero-knowledge server** — holds no keys, logs only hashed room/peer IDs

---

## Installation

```bash
npm install @tovsa7/zerosync-client yjs
```

---

## Quick start

```typescript
import { Room, deriveRoomKey } from '@tovsa7/zerosync-client'

// Room key is derived client-side and never transmitted
const secret  = crypto.getRandomValues(new Uint8Array(32))
const roomKey = await deriveRoomKey(secret, 'my-room-id')

// Join the room
const room = await Room.join({
  serverUrl:  'wss://your-server/ws',
  roomId:     'my-room-id',
  roomKey,
  peerId:     crypto.randomUUID(),
  nonce:      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
  hmac:       '',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
})

// Shared Yjs document — all changes are encrypted before broadcast
const doc  = room.getDoc()
const text = doc.getText('editor')

text.observe(() => console.log(text.toString()))

// Presence
room.updatePresence({ name: 'Alice' })
room.onPresence(peers => {
  for (const [peerId, state] of peers) {
    console.log(peerId, state.name)
  }
})

// Connection status
room.onStatus(status => {
  // 'connected' | 'reconnecting' | 'closed'
  console.log(status)
})

room.leave()
```

---

## Self-hosting

Run your own signaling server:

```bash
docker run -p 8080:8080 ghcr.io/tovsa7/zerosync-server:latest
```

For production with TLS (auto-cert via Caddy), see the [self-hosted guide](SELF-HOSTED.md).

Point the SDK at your server:

```typescript
const room = await Room.join({
  serverUrl:  'wss://sync.example.com/ws',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  // ...
})
```

Contact [contact.zerosync@proton.me](mailto:contact.zerosync@proton.me) for licensing.

---

## API

### `Room.join(opts)` → `Promise<Room>`

| Option | Type | Description |
|--------|------|-------------|
| `serverUrl` | `string` | WebSocket URL of the signaling server |
| `roomId` | `string` | Room identifier (opaque to the server) |
| `roomKey` | `CryptoKey` | AES-256-GCM key — never transmitted |
| `peerId` | `string` | UUIDv4 for this peer |
| `nonce` | `string` | Base64 random bytes for replay protection |
| `hmac` | `string` | HMAC-SHA-256 of the HELLO message |
| `iceServers` | `RTCIceServer[]` | ICE servers for WebRTC. Typical: `[{ urls: 'stun:stun.l.google.com:19302' }]`. Pass `[]` to disable STUN (P2P only works on the same network). |

### `room.getDoc()` → `Y.Doc`

Returns the shared [Yjs](https://docs.yjs.dev) document. Use any Yjs data structure — all changes are encrypted before broadcast.

### `room.updatePresence(state)` → `void`

Broadcasts encrypted presence state to all peers. Accepts any JSON-serialisable object.

### `room.onPresence(cb)` → `() => void`

Fires when the presence map changes. Returns an unsubscribe function.

### `room.onStatus(cb)` → `() => void`

Fires on connection state changes (`connected` / `reconnecting` / `closed`). Fires immediately with the current state on subscribe.

### `room.getConnectionSummary()` → `{ total: number; p2p: number }`

Returns peer count and how many are on direct WebRTC vs relay fallback.

### `room.leave()` → `void`

Disconnects, broadcasts peer-left presence update, releases all resources.

### `deriveRoomKey(secret, roomId)` → `Promise<CryptoKey>`

Derives a non-extractable AES-256-GCM key via HKDF-SHA-256. Store `secret`, not the derived key.

---

## Security

| Property | Detail |
|----------|--------|
| Encryption | AES-256-GCM via Web Crypto API |
| IV | 12 random bytes per message — never reused |
| Key derivation | HKDF-SHA-256 |
| Server visibility | Hashed room/peer IDs and ICE candidates only |
| Peer auth | AES-GCM challenge-response handshake on DataChannel open |
| Relay blobs | Max 64 KB · TTL 30s · opaque ciphertext |
| Third-party crypto | None — `crypto.subtle` only |

The room key is derived client-side and never leaves the browser. Even under a court order, the server cannot provide document contents — it does not possess the keys.

---

## Browser support

Requires Web Crypto API, WebRTC DataChannel, and WebSocket.  
Chrome 89+, Firefox 78+, Safari 15+, Edge 89+.

---

## Repository layout

```
packages/client/   TypeScript SDK (@tovsa7/zerosync-client on npm)
demo/              React collaborative editor demo
```

---

## License

Client SDK: [MIT](LICENSE)  
Signaling server + relay: BSL 1.1 — free for dev/test, paid for production
