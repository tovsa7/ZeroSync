# @tovsa7/zerosync-react

React hooks for [ZeroSync](https://github.com/tovsa7/ZeroSync) — end-to-end encrypted real-time collaboration.

> **Status**: v0.1.x — under active development. API surface may change.

## Install

```bash
npm install @tovsa7/zerosync-react @tovsa7/zerosync-client react yjs
```

## Quick start

```tsx
import { ZeroSyncProvider, useYText, usePresence } from '@tovsa7/zerosync-react'

function App() {
  return (
    <ZeroSyncProvider
      serverUrl="wss://sync.example.com/ws"
      roomId="my-room"
      roomKey={roomKey}
      peerId={peerId}
      nonce={nonce}
      hmac=""
      iceServers={[{ urls: 'stun:stun.l.google.com:19302' }]}
    >
      <Editor />
    </ZeroSyncProvider>
  )
}

function Editor() {
  const text = useYText('editor')
  const peers = usePresence()
  // ...
}
```

## API

(In progress — see [ROADMAP](https://github.com/tovsa7/ZeroSync/blob/main/docs/ROADMAP.md).)

## License

MIT
