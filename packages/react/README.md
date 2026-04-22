# @tovsa7/zerosync-react

React hooks for [ZeroSync](https://github.com/tovsa7/ZeroSync) — end-to-end encrypted real-time collaboration.

Declarative React bindings for the [@tovsa7/zerosync-client](https://www.npmjs.com/package/@tovsa7/zerosync-client) SDK. Adds Google Docs-style collaboration to any React app — where your server never sees plaintext.

- ✅ Zero-knowledge server (AES-256-GCM via Web Crypto)
- ✅ Peer-to-peer via WebRTC DataChannel with encrypted relay fallback
- ✅ CRDT-based sync via Yjs
- ✅ No runtime dependencies — all Yjs/client/React are peer deps
- ✅ TypeScript strict mode, full type inference
- ✅ React 18+ (`useSyncExternalStore` for tear-free Yjs reactivity)

---

## Install

```bash
npm install @tovsa7/zerosync-react @tovsa7/zerosync-client react yjs
```

## Quick start

```tsx
import { useState, useEffect } from 'react'
import {
  ZeroSyncProvider,
  useYText,
  useConnectionStatus,
} from '@tovsa7/zerosync-react'
import { deriveRoomKey } from '@tovsa7/zerosync-client'

function App() {
  const [roomKey, setRoomKey] = useState<CryptoKey | null>(null)

  useEffect(() => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    deriveRoomKey(secret, 'my-room').then(setRoomKey)
  }, [])

  if (!roomKey) return <p>Loading…</p>

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

  return (
    <textarea
      value={text?.toString() ?? ''}
      onChange={(e) => {
        // Naive sync — replace the whole Y.Text on every keystroke.
        // For production, use a proper binding like y-prosemirror or y-codemirror.next.
        text?.delete(0, text.length)
        text?.insert(0, e.target.value)
      }}
    />
  )
}
```

---

## API

### `<ZeroSyncProvider>`

Mounts a `Room` from the ZeroSync client SDK and exposes it through React context. Call `Room.join(opts)` on mount; call `room.leave()` on unmount.

```tsx
<ZeroSyncProvider
  serverUrl="wss://..."
  roomId="..."
  roomKey={cryptoKey}
  peerId="..."
  nonce="..."
  hmac=""
  iceServers={[...]}
  onError={(err) => console.error(err)}
>
  {children}
</ZeroSyncProvider>
```

| Prop         | Type                                    | Notes                                             |
|--------------|-----------------------------------------|---------------------------------------------------|
| `serverUrl`  | `string`                                | WebSocket URL of the ZeroSync signaling server    |
| `roomId`     | `string`                                | Room identifier — opaque to the server            |
| `roomKey`    | `CryptoKey`                             | AES-256-GCM key — never transmitted to server     |
| `peerId`     | `string`                                | UUIDv4 for this peer                              |
| `nonce`      | `string`                                | Base64 random bytes for HELLO replay protection   |
| `hmac`       | `string`                                | HMAC of HELLO message (`""` while opt-in)         |
| `iceServers` | `RTCIceServer[]`                        | WebRTC ICE servers (pass `[]` to disable STUN)    |
| `onError`    | `(e: unknown) => void` _optional_       | Called if `Room.join` rejects                     |
| `children`   | `ReactNode`                             |                                                   |

Props are **snapshotted at mount** — changes after mount do not trigger rejoin. To switch rooms, unmount and remount (e.g. via a `key` prop).

### `useRoom(): Room | null`

Returns the currently-joined `Room` instance, or `null` while `Room.join` is in flight or rejected. Use to call low-level SDK methods (`getConnectionSummary`, etc.).

```tsx
const room = useRoom()
const summary = room?.getConnectionSummary()
```

### `useConnectionStatus(): 'connecting' | 'connected' | 'reconnecting' | 'closed'`

Reactive connection status.

- `'connecting'` — `<ZeroSyncProvider>` mounted, `Room.join()` pending.
- `'connected'` — WebSocket is up (initial) or reconnected.
- `'reconnecting'` — WebSocket dropped, client retrying with backoff.
- `'closed'` — Provider unmounted, or `Room.join` rejected.

```tsx
const status = useConnectionStatus()
if (status !== 'connected') return <Banner>Offline</Banner>
```

### `useYText(name: string): Y.Text | null`

Returns a [Y.Text](https://docs.yjs.dev/api/shared-types/y.text) keyed by `name`. Component re-renders on every `Y.Text` mutation.

```tsx
const text = useYText('editor')
text?.insert(0, 'hello')
console.log(text?.toString())
```

### `useYMap<V>(name: string): Y.Map<V> | null`

Returns a [Y.Map](https://docs.yjs.dev/api/shared-types/y.map). Component re-renders on every `set` / `delete` / nested update.

```tsx
const cursors = useYMap<{ x: number; y: number }>('cursors')
cursors?.set('alice', { x: 10, y: 20 })
```

### `useYArray<V>(name: string): Y.Array<V> | null`

Returns a [Y.Array](https://docs.yjs.dev/api/shared-types/y.array). Component re-renders on every `push` / `insert` / `delete`.

```tsx
const messages = useYArray<string>('chat')
messages?.push(['hello!'])
messages?.toArray().forEach((m) => console.log(m))
```

### `usePresence<T>(): ReadonlyMap<string, T>`

Returns a snapshot of remote peers' presence state (excluding the local peer). Re-renders on every awareness change.

```tsx
interface UserPresence { name: string; color: string }

const peers = usePresence<UserPresence>()
for (const [peerId, { name, color }] of peers) {
  console.log(peerId, name, color)
}
```

### `useMyPresence<T>(): [T | null, (state: T) => void]`

React-style `[state, setState]` tuple. `setState` updates local state AND broadcasts to peers via `room.updatePresence`.

```tsx
interface MyPresence { name: string; color: string }

const [me, setMe] = useMyPresence<MyPresence>()

// Publish initial presence once connected
useEffect(() => {
  if (status === 'connected') {
    setMe({ name: 'Alice', color: '#f00' })
  }
}, [status, setMe])
```

Full-replace semantics: the value passed to `setMe` replaces the whole presence state. For partial updates, spread the previous value:

```tsx
setMe({ ...me, cursor: { x, y } })
```

**Do not include `peerId` in the state** — the SDK injects it internally as a routing field.

---

## Examples

### Collaborative text (plain textarea)

See [Quick start](#quick-start) above. For production, bind Y.Text to a proper editor:
- [y-prosemirror](https://github.com/yjs/y-prosemirror) — ProseMirror / Tiptap
- [y-codemirror.next](https://github.com/yjs/y-codemirror.next) — CodeMirror 6
- [y-quill](https://github.com/yjs/y-quill) — Quill

```tsx
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'

function Tiptap() {
  const room = useRoom()
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: room?.getDoc() }),
    ],
  }, [room])
  return <EditorContent editor={editor} />
}
```

### Cursor presence

```tsx
function WhiteboardWithCursors() {
  const peers = usePresence<{ x: number; y: number; color: string }>()
  const [, setMe] = useMyPresence<{ x: number; y: number; color: string }>()

  return (
    <div
      onMouseMove={(e) => setMe({ x: e.clientX, y: e.clientY, color: '#f00' })}
      style={{ position: 'relative', height: '100vh' }}
    >
      {Array.from(peers).map(([peerId, { x, y, color }]) => (
        <div
          key={peerId}
          style={{
            position: 'absolute',
            left: x, top: y,
            width: 10, height: 10,
            background: color,
            borderRadius: '50%',
            transition: 'left 100ms, top 100ms',
          }}
        />
      ))}
    </div>
  )
}
```

### Chat with `useYArray`

```tsx
interface Message { author: string; text: string; ts: number }

function Chat() {
  const messages = useYArray<Message>('chat')
  const [draft, setDraft] = useState('')

  if (!messages) return null

  return (
    <>
      <ul>
        {messages.toArray().map((m, i) => (
          <li key={i}><b>{m.author}:</b> {m.text}</li>
        ))}
      </ul>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => {
        messages.push([{ author: 'me', text: draft, ts: Date.now() }])
        setDraft('')
      }}>Send</button>
    </>
  )
}
```

---

## Troubleshooting

### "Hook re-renders too often"

`useYText` / `useYMap` / `useYArray` re-render on **every** Yjs observe event — that's the point. If this causes performance issues in large lists, memoize derived data:

```tsx
const snapshot = useMemo(() => arr?.toArray(), [arr?.length, arr]) // not perfect
```

For heavy lists, consider using Yjs's `observeDeep` manually outside the hook, or use a virtualizing list (`react-window`).

### "`Room.join` keeps getting called on every render"

Provider snapshots props at mount; if you see rejoin logs, check whether the Provider is being unmounted and remounted (e.g. via conditional parent render, key-prop change, or HMR during development).

### "`useMyPresence` doesn't publish on mount"

`setMyPresence` broadcasts only if a Room is available. On first mount the Room is `null`, so the initial state isn't published. Gate publishing on `useConnectionStatus() === 'connected'` (see example above).

### "Two Yjs instances warning"

Yjs's constructor checks fail if your bundler includes two Yjs copies (one from this package's dev tree, one from your app). Dedupe in your bundler:

```ts
// vite.config.ts
export default defineConfig({
  resolve: { dedupe: ['yjs'] },
})
```

---

## Bundle size

~3 KB ESM minified + gzipped. Zero runtime dependencies — React, Yjs, and `@tovsa7/zerosync-client` are all peer dependencies.

## License

MIT — see [LICENSE](https://github.com/tovsa7/ZeroSync/blob/main/LICENSE).

## Links

- [Main repo](https://github.com/tovsa7/ZeroSync)
- [Client SDK](https://www.npmjs.com/package/@tovsa7/zerosync-client)
- [Self-hosted setup](https://github.com/tovsa7/ZeroSync/blob/main/SELF-HOSTED.md)
- [Security](https://github.com/tovsa7/ZeroSync/blob/main/SECURITY.md)
