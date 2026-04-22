# ZeroSync

[![CI](https://github.com/tovsa7/ZeroSync/actions/workflows/ci.yml/badge.svg)](https://github.com/tovsa7/ZeroSync/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tovsa7/zerosync-client)](https://www.npmjs.com/package/@tovsa7/zerosync-client)
[![Socket Badge](https://badge.socket.dev/npm/package/@tovsa7/zerosync-client)](https://socket.dev/npm/package/@tovsa7/zerosync-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/12456/badge)](https://www.bestpractices.dev/projects/12456)

**End-to-end encrypted real-time collaboration SDK. Self-hosted in one Docker command.**

Add Google Docs-style multi-user editing, presence, and chat to any web app — where your server mathematically cannot read plaintext. Built on WebRTC + Yjs + AES-256-GCM via the browser's Web Crypto API. Client SDK is MIT; signaling server is BSL 1.1 (free for dev/test, paid for production).

**[Try the demo →](https://tovsa7.github.io/ZeroSync)** · [Pricing](#pricing) · [Self-hosting](SELF-HOSTED.md)

---

## Why ZeroSync

- **Zero-knowledge server** — room keys live only in the browser. The server sees hashed identifiers and opaque ciphertext. Even under subpoena, there is nothing to disclose.
- **Architecture supports regulated workflows** — HIPAA technical safeguards, attorney-client privilege, GDPR data-minimization by design. (Not certified — architecture enables your own compliance program.)
- **Self-hosted** — run on your own Hetzner / AWS / bare metal via one Docker image. No vendor-cloud dependency.
- **Open-source client** — MIT licensed, auditable, no proprietary crypto. Server is BSL 1.1 (free for dev/test, paid in production).
- **Real React hooks** — `@tovsa7/zerosync-react` for declarative integration (`useYText`, `usePresence`, `useMyPresence` …). Works with Tiptap, CodeMirror, Quill via standard Yjs bindings.
- **141+ tests** — property-based + integration. OpenSSF Best Practices badge. SLSA provenance on every npm release.

## Use cases

ZeroSync is designed for products where **two or more humans collaborate on sensitive content in real time**, and where "your server cannot read it" is itself a feature:

- **Legal tech** — privileged attorney-client collaboration, live document redlines, e-signing ceremonies with witnesses
- **Mental health / therapy** — therapist-client sessions with notes, homework, and chat that the platform itself cannot see
- **Finance / fintech** — token deal rooms, M&A data rooms, OTC trading desk coordination, private equity deal flow
- **Enterprise R&D** — cross-team collaboration on IP, patents, regulatory filings, trade secrets
- **Regulated SaaS with EU customers** — a DPA-grade architecture you can point at during procurement

If your product is single-user, async-only, or entirely AI-driven — ZeroSync is probably not your fit.

---

## Quick start — React

```bash
npm install @tovsa7/zerosync-react @tovsa7/zerosync-client react yjs
```

```tsx
import { ZeroSyncProvider, useYText, useConnectionStatus } from '@tovsa7/zerosync-react'
import { deriveRoomKey } from '@tovsa7/zerosync-client'

function App({ roomKey }: { roomKey: CryptoKey }) {
  return (
    <ZeroSyncProvider
      serverUrl="wss://sync.example.com/ws"
      roomId="my-room"
      roomKey={roomKey}
      peerId={crypto.randomUUID()}
      nonce={btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))}
      hmac=""
      iceServers={[{ urls: 'stun:stun.l.google.com:19302' }]}
    >
      <Editor />
    </ZeroSyncProvider>
  )
}

function Editor() {
  const status = useConnectionStatus()
  const text   = useYText('editor')
  if (status !== 'connected') return <p>Status: {status}</p>
  return <textarea value={text?.toString() ?? ''} onChange={(e) => {
    text?.delete(0, text.length); text?.insert(0, e.target.value)
  }} />
}
```

See the [React hooks package](packages/react) for `useYMap`, `useYArray`, `usePresence`, `useMyPresence`, and Tiptap / CodeMirror integration examples.

## Quick start — vanilla SDK

```bash
npm install @tovsa7/zerosync-client yjs
```

```typescript
import { Room, deriveRoomKey } from '@tovsa7/zerosync-client'

// Room key is derived client-side and never transmitted.
const secret  = crypto.getRandomValues(new Uint8Array(32))
const roomKey = await deriveRoomKey(secret, 'my-room-id')

const room = await Room.join({
  serverUrl:  'wss://your-server/ws',
  roomId:     'my-room-id',
  roomKey,
  peerId:     crypto.randomUUID(),
  nonce:      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
  hmac:       '',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
})

const doc  = room.getDoc()
const text = doc.getText('editor')

text.observe(() => console.log(text.toString()))
room.updatePresence({ name: 'Alice' })

room.leave()
```

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
- **Relay fallback** — encrypted blobs only, server sees opaque ciphertext (max 64 KB, 30s TTL)
- **Zero-knowledge server** — holds no keys, logs only SHA-256-hashed room / peer IDs
- **Mutual peer auth** — AES-GCM challenge-response on DataChannel open proves both peers possess the room key without transmitting it

Full threat model + disclosure process: [`SECURITY.md`](https://github.com/tovsa7/ZeroSync/blob/main/SECURITY.md) · Regulatory mappings (HIPAA §164.312, GDPR Art. 25/32/33/34, SOC 2 CC6): [`COMPLIANCE.md`](https://github.com/tovsa7/ZeroSync/blob/main/COMPLIANCE.md) · Security contact: [`.well-known/security.txt`](https://tovsa7.github.io/ZeroSync/.well-known/security.txt)

## Comparison

| | **ZeroSync** | Liveblocks | Yjs + y-websocket | Jazz.tools |
|-|--------------|------------|-------------------|------------|
| End-to-end encrypted | ✅ AES-256-GCM | ❌ cloud reads data | ❌ | ⚠️ opt-in |
| Self-hosted | ✅ one Docker | ❌ cloud only | ✅ | ✅ |
| Zero-knowledge server | ✅ | ❌ | ❌ | ❌ |
| Open-source client | MIT | Proprietary | MIT | MPL-2.0 |
| Production license | BSL 1.1 self-hosted | SaaS subscription | Free | Free + paid cloud |
| CRDT sync | Yjs | Proprietary | Yjs | Custom CoJSON |
| React hooks | ✅ | ✅ | community | ✅ |

## Pricing

| Tier | Price | Rooms × Peers | Email SLA |
|------|-------|---------------|-----------|
| **Community** | Free | 5 × 10 | GitHub Discussions |
| **Starter** | $149/mo or $1,490/yr | 100 × 25 | 3 business days |
| **Business** | $599/mo or $5,990/yr | 1,000 × 50 | 1 business day |
| **Enterprise** | From $25,000/yr | Unlimited | 4 business hours + custom SLA |

Community tier is fully-featured for development and evaluation. Production use (commercial deployment) requires a paid tier. Contact [sales](mailto:contact.zerosync@proton.me) for Enterprise.

---

## Self-hosting

Run your own signaling server:

```bash
docker run -p 8080:8080 ghcr.io/tovsa7/zerosync-server:latest
```

For production (auto-TLS via Caddy, multi-peer relay, license enforcement), see the [self-hosted guide](SELF-HOSTED.md).

Point the SDK at your server:

```typescript
const room = await Room.join({
  serverUrl:  'wss://sync.example.com/ws',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  // ...
})
```

## API reference

### `@tovsa7/zerosync-client`

`Room.join(opts)` → `Promise<Room>` — connects, joins the room, starts sync + presence.

| Option | Type | Description |
|--------|------|-------------|
| `serverUrl` | `string` | WebSocket URL of the signaling server |
| `roomId` | `string` | Room identifier (opaque to the server) |
| `roomKey` | `CryptoKey` | AES-256-GCM key — never transmitted |
| `peerId` | `string` | UUIDv4 for this peer |
| `nonce` | `string` | Base64 random bytes for replay protection |
| `hmac` | `string` | HMAC-SHA-256 of the HELLO message |
| `iceServers` | `RTCIceServer[]` | WebRTC ICE servers. Pass `[]` to disable STUN (same-network P2P only). |

Room methods: `getDoc()` / `updatePresence()` / `onPresence()` / `getPresence()` / `onStatus()` / `getConnectionSummary()` / `leave()` — see `packages/client/src/room.ts` for full spec.

Helpers: `deriveRoomKey(secret, roomId)` — HKDF-SHA-256 key derivation, returns non-extractable `CryptoKey`.

### `@tovsa7/zerosync-react`

Declarative React hooks layered on the client SDK:

| Hook | Returns |
|------|---------|
| `<ZeroSyncProvider>` | Context provider — calls `Room.join` on mount, `leave` on unmount |
| `useRoom()` | `Room \| null` |
| `useConnectionStatus()` | `'connecting' \| 'connected' \| 'reconnecting' \| 'closed'` |
| `useYText(name)` | `Y.Text \| null` (re-renders on update) |
| `useYMap(name)` | `Y.Map \| null` (re-renders on update) |
| `useYArray(name)` | `Y.Array \| null` (re-renders on update) |
| `usePresence<T>()` | `ReadonlyMap<peerId, T>` |
| `useMyPresence<T>()` | `[T \| null, setState]` — broadcasts via `room.updatePresence` |

Full docs + Tiptap / CodeMirror / cursor-presence examples: [`packages/react/README.md`](packages/react/README.md).

---

## Security

| Property | Detail |
|----------|--------|
| Encryption | AES-256-GCM via Web Crypto API |
| IV | 12 random bytes per message — never reused |
| Key derivation | HKDF-SHA-256 |
| Server visibility | Hashed room/peer IDs and ICE candidates only |
| Peer auth | AES-GCM challenge-response handshake on DataChannel open |
| Relay blobs | Max 64 KB · TTL 30 s · opaque ciphertext |
| Third-party crypto | None — `crypto.subtle` only |

The room key is derived client-side and never leaves the browser. Even under a court order, the server cannot provide document contents — it does not possess the keys.

Disclosure process + threat model: [SECURITY.md](SECURITY.md).

## Browser support

Requires Web Crypto API, WebRTC DataChannel, and WebSocket.
Chrome 89+, Firefox 78+, Safari 15+, Edge 89+. Node.js ≥ 20 for server-side integrations.

## Repository layout

```
packages/client/   TypeScript SDK        (@tovsa7/zerosync-client on npm)
packages/react/    React hooks package   (@tovsa7/zerosync-react)
demo/              React collaborative editor demo
docs/              Protocol + architecture + security documentation
```

## For companies

Running ZeroSync in production? I'm actively working with design partners building HIPAA/GDPR-sensitive collaboration apps. If you need:

- Production license for the signaling server (BSL → commercial)
- Direct support from the maintainer
- Priority on feature requests and roadmap input
- Help with self-hosted deployment

Email [contact.zerosync@proton.me](mailto:contact.zerosync@proton.me) with a short description of your use case.

Early-stage design partners get meaningful discounts in exchange for feedback and, optionally, a case study.

---

## License

Client SDK + React hooks: [MIT](LICENSE)
Signaling server + relay: BSL 1.1 — free for dev/test, paid for production (see [Pricing](#pricing))

---

Questions? Commercial / enterprise inquiries? [contact.zerosync@proton.me](mailto:contact.zerosync@proton.me)
