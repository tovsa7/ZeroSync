# @tovsa7/zerosync-client

[![CI](https://github.com/tovsa7/ZeroSync/actions/workflows/ci.yml/badge.svg)](https://github.com/tovsa7/ZeroSync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../../LICENSE)

End-to-end encrypted real-time collaboration SDK.

All content is encrypted client-side with **AES-256-GCM** before leaving the browser.
The server never receives plaintext data or encryption keys.

**[Live demo](https://tovsa7.github.io/ZeroSync)** · **[Full docs](https://github.com/tovsa7/ZeroSync)**

## Installation

```bash
npm install @tovsa7/zerosync-client yjs
```

## Quick start

```typescript
import { Room, deriveRoomKey } from '@tovsa7/zerosync-client'

const userSecret = crypto.getRandomValues(new Uint8Array(32))
const roomKey = await deriveRoomKey(userSecret, 'my-room-id')

const room = await Room.join({
  serverUrl: 'wss://demo.zerosync.dev/ws',
  roomId:    'my-room-id',
  roomKey,
  peerId:    crypto.randomUUID(),
  nonce:     btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
  hmac:      'your-hmac',
})

const text = room.getDoc().getText('editor')
text.observe(() => console.log(text.toString()))

room.updatePresence({ name: 'Alice' })
room.onPresence(peers => console.log([...peers.entries()]))
room.onStatus(status => console.log(status)) // 'connected' | 'reconnecting' | 'closed'

room.leave()
```

## Security

| Property | Detail |
|----------|--------|
| Encryption | AES-256-GCM via Web Crypto API |
| IV | 12 random bytes per message — never reused |
| Key derivation | HKDF-SHA-256 |
| Server visibility | Hashed IDs and ICE candidates only — never plaintext |
| Third-party crypto | None — `crypto.subtle` only |

## Browser support

Chrome 89+, Firefox 78+, Safari 15+, Edge 89+

## License

MIT
