/**
 * ZeroSync Demo — collaborative text editor.
 *
 * Connects to a ZeroSync server via Room.join() for real-time
 * E2E-encrypted CRDT sync. Falls back to local-only mode when
 * no server is available.
 *
 * When no room hash is present in the URL, a landing page is shown instead
 * of the editor. Clicking "Try Demo" generates a fresh room, sets the hash,
 * and switches to editor view.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import * as Y from 'yjs'
import { Room } from '@zerosync/client'
import type { PresenceState, RoomStatus } from '@zerosync/client'

// ── Config ──────────────────────────────────────────────────────────────────

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8080/ws'

// localStorage key used to suppress onboarding hints after first dismiss.
const ONBOARDING_KEY = 'zerosync_onboarding_done'

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Returns true when the viewport is narrower than 600px.
 * Re-evaluates on window resize via matchMedia.
 */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 600px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 600px)')
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return mobile
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function base64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(s.length + (4 - s.length % 4) % 4, '=')
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0))
}

/**
 * Parses room ID and raw key from the URL hash.
 * Format: #room={roomId}&key={base64url(rawKey)}
 * If key is absent (creator), rawKey is null — a fresh key will be generated.
 */
function getRoomParamsFromHash(): { roomId: string; rawKey: Uint8Array | null } {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const roomId = params.get('room') ?? generateId()
  const keyStr = params.get('key')
  const rawKey = keyStr ? base64urlDecode(keyStr) : null
  return { roomId, rawKey }
}

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

async function buildRoomKey(rawKey: Uint8Array): Promise<CryptoKey> {
  // Slice to a plain ArrayBuffer — required by importKey (no SharedArrayBuffer).
  const buf = rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength) as ArrayBuffer
  return crypto.subtle.importKey('raw', buf, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * Encrypts the given text with AES-256-GCM and returns display metadata.
 * Used only for the encryption proof panel — not part of the sync protocol.
 * Wire format matches the SDK: IV (12 bytes) || ciphertext+tag.
 */
async function encryptForPreview(key: CryptoKey, text: string): Promise<{
  ivHex: string
  totalBytes: number
  hexPreview: string
  plaintextBytes: number
}> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(text.length > 0 ? text : '\0')
  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  const ciphertext = new Uint8Array(ciphertextBuf)

  // Assemble wire blob: IV || ciphertext+tag
  const blob = new Uint8Array(12 + ciphertext.length)
  blob.set(iv, 0)
  blob.set(ciphertext, 12)

  // IV as 3 groups of 4 bytes: "a3f7b2e1 9c4d5f6a 7b8c9d0e"
  const ivHex = Array.from(iv)
    .map(b => b.toString(16).padStart(2, '0'))
    .reduce((s, h, i) => s + (i > 0 && i % 4 === 0 ? ' ' : '') + h, '')

  const previewLen = Math.min(blob.length, 32)
  const hexPreview = Array.from(blob.slice(0, previewLen), b => b.toString(16).padStart(2, '0')).join(' ')
    + (blob.length > previewLen ? ' …' : '')

  return { ivHex, totalBytes: blob.length, hexPreview, plaintextBytes: plaintext.length }
}

// ── App ─────────────────────────────────────────────────────────────────────

export function App() {
  const isMobile = useIsMobile()

  const [text, setText] = useState('')
  // 'connecting' = initial handshake, 'connected'/'reconnecting'/'closed' = Room status, 'local' = no server
  const [status, setStatus] = useState<'connecting' | RoomStatus | 'local'>('connecting')
  const [peers, setPeers] = useState<Map<string, PresenceState>>(new Map())
  const [connSummary, setConnSummary] = useState({ total: 0, p2p: 0 })
  const [copied, setCopied] = useState(false)
  const [name, setName] = useState('')

  // null when on the landing page; set to room params when entering editor view.
  // Initialised from the URL hash if a room is already present (direct link / reload).
  const [roomParams, setRoomParams] = useState<{ roomId: string; rawKey: Uint8Array | null } | null>(() =>
    window.location.hash.includes('room=') ? getRoomParamsFromHash() : null
  )
  const [showLanding, setShowLanding] = useState(() => !window.location.hash.includes('room='))
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [tryDemoHover, setTryDemoHover] = useState(false)

  // peerId must be a UUIDv4 — the server validates this format on HELLO.
  const [peerId] = useState(() => crypto.randomUUID())

  // Derived for display; empty string while on landing page (never rendered there).
  const roomId = roomParams?.roomId ?? ''

  const docRef      = useRef<Y.Doc | null>(null)
  const roomRef     = useRef<Room | null>(null)
  const yTextRef    = useRef<Y.Text | null>(null)
  const roomKeyRef  = useRef<CryptoKey | null>(null)

  // Encryption proof panel state.
  const [keyReady, setKeyReady] = useState(false)
  const [proofOpen, setProofOpen] = useState(false)
  const [cryptoProof, setCryptoProof] = useState<{
    ivHex: string; totalBytes: number; hexPreview: string; plaintextBytes: number
  } | null>(null)

  // Connect to room when roomParams becomes non-null (not on landing page).
  useEffect(() => {
    if (!roomParams) return

    const { roomId: id, rawKey: initialRawKey } = roomParams

    const doc = new Y.Doc()
    const yText = doc.getText('editor')
    docRef.current = doc
    yTextRef.current = yText

    const observer = () => setText(yText.toString())
    yText.observe(observer)

    ;(async () => {
      // Use the key from the URL (joiner) or generate a fresh random key (creator).
      const rawKey = initialRawKey ?? crypto.getRandomValues(new Uint8Array(32))
      const roomKey = await buildRoomKey(rawKey)
      roomKeyRef.current = roomKey
      setKeyReady(true)

      // Always keep the full invite link in the URL hash so the creator can
      // share it at any time and joiners get a stable URL.
      window.location.hash = `room=${id}&key=${base64urlEncode(rawKey)}`

      try {
        const room = await Room.join({
          serverUrl: SERVER_URL,
          roomId: id,
          roomKey,
          peerId,
          nonce: generateNonce(),
          hmac: 'demo', // server does not verify HMAC
        })

        roomRef.current = room

        const roomDoc  = room.getDoc()
        const roomText = roomDoc.getText('editor')
        docRef.current  = roomDoc
        yTextRef.current = roomText

        yText.unobserve(observer)
        const roomObserver = () => setText(roomText.toString())
        roomText.observe(roomObserver)
        setText(roomText.toString())

        room.onPresence(p => setPeers(new Map(p)))
        // Use Room.onStatus for live signaling connection state.
        // This replaces the one-time setStatus('connected') so the UI
        // reflects reconnects and disconnects transparently.
        room.onStatus(s => setStatus(s))
      } catch {
        setStatus('local')
      }
    })()

    return () => {
      roomRef.current?.leave()
      roomKeyRef.current = null
      setKeyReady(false)
    }
  }, [roomParams, peerId])

  // Poll transport connection summary while connected.
  useEffect(() => {
    if (status !== 'connected') return
    const id = setInterval(() => {
      if (roomRef.current) setConnSummary(roomRef.current.getConnectionSummary())
    }, 2000)
    return () => clearInterval(id)
  }, [status])

  // Broadcast presence when name changes.
  useEffect(() => {
    if (name && roomRef.current) {
      roomRef.current.updatePresence({ name })
    }
  }, [name])

  // Re-encrypt current text whenever the proof panel is open or text changes.
  // 400ms debounce to avoid encrypting on every keystroke.
  useEffect(() => {
    if (!keyReady || !proofOpen) return
    const key = roomKeyRef.current
    if (!key) return
    const timer = setTimeout(() => {
      encryptForPreview(key, text).then(setCryptoProof)
    }, 400)
    return () => clearTimeout(timer)
  }, [text, proofOpen, keyReady])

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const doc    = docRef.current
    const yText  = yTextRef.current
    if (!doc || !yText) return

    const newVal = e.target.value
    const oldVal = yText.toString()
    if (newVal === oldVal) return

    // Compute the smallest diff (common prefix + common suffix) so Y.Text
    // records incremental operations instead of a full replace. This preserves
    // CRDT merge semantics and cursor positions during concurrent edits.
    let start = 0
    while (start < oldVal.length && start < newVal.length && oldVal[start] === newVal[start]) {
      start++
    }
    let oldEnd = oldVal.length
    let newEnd = newVal.length
    while (oldEnd > start && newEnd > start && oldVal[oldEnd - 1] === newVal[newEnd - 1]) {
      oldEnd--
      newEnd--
    }

    doc.transact(() => {
      const deleteCount = oldEnd - start
      const insertStr   = newVal.slice(start, newEnd)
      if (deleteCount > 0) yText.delete(start, deleteCount)
      if (insertStr)       yText.insert(start, insertStr)
    })
  }, [])

  const handleClear = useCallback(() => {
    const doc   = docRef.current
    const yText = yTextRef.current
    if (!doc || !yText) return
    doc.transact(() => { yText.delete(0, yText.length) })
  }, [])

  const handleCopyLink = useCallback(async () => {
    // Use the native share sheet on devices that support it (iOS/Android).
    // Falls back to clipboard copy on desktop.
    if (navigator.share) {
      try {
        await navigator.share({ url: window.location.href, title: 'Join ZeroSync room' })
        return
      } catch {
        // User cancelled or share unavailable — fall through to clipboard.
      }
    }
    await navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  // Generates a fresh room, updates the URL hash, and switches to editor view.
  const handleTryDemo = useCallback(() => {
    const newRoomId = generateId()
    const rawKey = crypto.getRandomValues(new Uint8Array(32))
    window.location.hash = `room=${newRoomId}&key=${base64urlEncode(rawKey)}`
    if (!localStorage.getItem(ONBOARDING_KEY)) setShowOnboarding(true)
    setRoomParams({ roomId: newRoomId, rawKey })
    setShowLanding(false)
  }, [])

  // Dismisses onboarding hints and persists the suppression flag.
  const handleDismissOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, '1')
    setShowOnboarding(false)
  }, [])

  const statusColor =
    status === 'connected'    ? '#4ecca3' :
    status === 'reconnecting' ? '#f0a030' :
    status === 'local'        ? '#f0a030' : '#888'
  const statusLabel =
    status === 'connected'    ? 'Connected' :
    status === 'reconnecting' ? 'Reconnecting…' :
    status === 'local'        ? 'Local only' :
    status === 'closed'       ? 'Disconnected' : 'Connecting…'

  // Connection quality indicator derived values.
  const connIsP2P  = connSummary.total > 0 && connSummary.p2p === connSummary.total
  const connIsMix  = connSummary.total > 0 && connSummary.p2p > 0 && !connIsP2P
  const connColor  = connIsP2P ? '#4ecca3' : '#f0a030'
  const connLabel  = connIsP2P ? 'Direct encrypted connection'
                   : connIsMix ? 'Partially direct connection'
                   : 'Encrypted via relay'
  const connBadge  = connIsP2P ? 'P2P' : connIsMix ? 'MIXED' : 'RELAY'

  // ── Landing page ────────────────────────────────────────────────────────

  if (showLanding) {
    return (
      <div style={styles.container}>

        <section style={{
          ...styles.hero,
          background: 'radial-gradient(ellipse 900px 500px at 50% -80px, rgba(78,204,163,0.10) 0%, transparent 70%), radial-gradient(ellipse at 50% -20%, #0f2035 0%, #1a1a2e 55%)',
          ...(isMobile && { padding: '44px 16px 40px' }),
        }}>
          <div style={styles.heroBadge}>Open Source / MIT</div>
          <h1 style={{
            ...styles.heroTitle,
            background: 'linear-gradient(140deg, #ffffff 30%, #4ecca3 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
            ...(isMobile && { fontSize: 26 }),
          }}>
            Real-time collaboration,<br />end-to-end encrypted.
          </h1>
          <p style={{
            ...styles.heroSubtitle,
            ...(isMobile && { fontSize: 15 }),
          }}>
            Open-source, self-hosted sync with AES-256-GCM encryption.<br />
            No vendor lock-in. Deploy in 5 minutes with Docker.
          </p>
          <div style={{
            ...styles.heroCtas,
            ...(isMobile && { flexDirection: 'column' }),
          }}>
            <button
              style={{
                ...styles.tryDemoButton,
                backgroundColor: tryDemoHover ? '#3ab890' : '#4ecca3',
                ...(isMobile && { width: '100%' }),
              }}
              onClick={handleTryDemo}
              onMouseEnter={() => setTryDemoHover(true)}
              onMouseLeave={() => setTryDemoHover(false)}
            >
              Try Live Demo
            </button>
            <a href="https://github.com/tovsa7/ZeroSync" style={{
              ...styles.githubButton,
              ...(isMobile && { width: '100%', textAlign: 'center', justifyContent: 'center' }),
            }}
               target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
          </div>
        </section>

        <section style={styles.installSection}>
          <div style={styles.codeBlock}>
            <div style={styles.codeBlockHeader}>
              <span style={styles.codeBlockLabel}>Quick Start</span>
            </div>
            <pre style={styles.codeBlockPre}><code style={styles.codeBlockCode}>{`npm install @tovsa7/zerosync-client yjs

import { Room, deriveRoomKey } from '@tovsa7/zerosync-client'

const roomKey = await deriveRoomKey(secret, 'my-room')
const room    = await Room.join({
  serverUrl: 'wss://your-server/ws',
  roomId:    'my-room',
  roomKey,
  peerId:    crypto.randomUUID(),
})

const doc = room.getDoc()
doc.getText('editor').observe(e => { /* ... */ })`}</code></pre>
          </div>
        </section>

        <section style={styles.howSection}>
          <h2 style={styles.sectionHeading}>How it works</h2>
          <div style={styles.featureGrid}>
            <div style={{
              ...styles.featureCard,
              ...(isMobile && { minWidth: '100%' }),
            }}>
              <div style={styles.featureCardTitle}>Zero-Knowledge Server</div>
              <p style={styles.featureCardText}>
                The server routes encrypted blobs only — it never sees
                your document content, user identities, or plaintext.
                The room key lives in the URL fragment and never leaves the browser.
              </p>
            </div>
            <div style={{
              ...styles.featureCard,
              ...(isMobile && { minWidth: '100%' }),
            }}>
              <div style={styles.featureCardTitle}>P2P First, Relay Fallback</div>
              <p style={styles.featureCardText}>
                Peers connect directly via WebRTC DataChannel.
                When direct connection fails, the relay forwards
                only encrypted blobs it cannot read.
              </p>
            </div>
            <div style={{
              ...styles.featureCard,
              ...(isMobile && { minWidth: '100%' }),
            }}>
              <div style={styles.featureCardTitle}>AES-256-GCM via Web Crypto</div>
              <p style={styles.featureCardText}>
                Every CRDT update is encrypted in-browser using the
                native Web Crypto API before transmission.
                No third-party crypto dependencies.
              </p>
            </div>
            <div style={{
              ...styles.featureCard,
              ...(isMobile && { minWidth: '100%' }),
            }}>
              <div style={styles.featureCardTitle}>Self-Hosted in 5 Minutes</div>
              <p style={styles.featureCardText}>
                Run your own server and relay via Docker.
                Minimum 512 MB RAM. Your data never leaves
                infrastructure you control.
              </p>
            </div>
          </div>
        </section>

        <section style={styles.dataFlowSection}>
          <h2 style={styles.sectionHeading}>What the server sees</h2>
          <div style={styles.codeBlock}>
            <pre style={styles.codeBlockPre}><code style={styles.codeBlockCode}>{`Browser A              Server / Relay              Browser B
    |                        |                          |
    |-- encrypt(data, key) --+                          |
    |                        |                          |
    |<======= WebRTC DataChannel (P2P) ===============>|
    |                   ciphertext                      |
    |              (cannot decrypt)                     |`}</code></pre>
          </div>
          <p style={styles.dataFlowCaption}>
            The room key is derived from the URL fragment and never sent to the server.
            The server sees only opaque ciphertext it cannot decrypt.
          </p>
        </section>

        <section style={styles.selfHostSection}>
          <h2 style={styles.sectionHeading}>Self-host in 5 minutes</h2>
          <div style={styles.codeBlock}>
            <div style={styles.codeBlockHeader}>
              <span style={styles.codeBlockLabel}>Docker</span>
            </div>
            <pre style={styles.codeBlockPre}><code style={styles.codeBlockCode}>{`docker pull ghcr.io/tovsa7/zerosync-server:latest
docker pull ghcr.io/tovsa7/zerosync-relay:latest

docker compose up -d`}</code></pre>
          </div>
          <p style={{ margin: '10px 0 0', fontSize: 12, color: '#555570', textAlign: 'center' }}>
            Docker images coming soon — star the repo for updates.
          </p>
          <div style={styles.selfHostDetails}>
            <div style={{
              ...styles.selfHostItem,
              ...(isMobile && { flex: '0 0 calc(50% - 8px)' }),
            }}>
              <span style={styles.selfHostLabel}>License</span>
              <span style={styles.selfHostValue}>BSL 1.1 (server) / MIT (client)</span>
            </div>
            <div style={{
              ...styles.selfHostItem,
              ...(isMobile && { flex: '0 0 calc(50% - 8px)' }),
            }}>
              <span style={styles.selfHostLabel}>Minimum</span>
              <span style={styles.selfHostValue}>512 MB RAM</span>
            </div>
          </div>
        </section>

        <div style={styles.trustBar}>
          <span style={styles.trustItem}>AES-256-GCM</span>
          <span style={styles.trustSep}>|</span>
          <span style={styles.trustItem}>Yjs CRDT</span>
          <span style={styles.trustSep}>|</span>
          <span style={styles.trustItem}>WebRTC P2P</span>
          <span style={styles.trustSep}>|</span>
          <span style={styles.trustItem}>Web Crypto API</span>
        </div>

        <footer style={styles.footer}>
          <p style={styles.footerLinks}>
            <a href="https://github.com/tovsa7/ZeroSync" style={styles.footerLink}
               target="_blank" rel="noopener noreferrer">GitHub</a>
            <span style={styles.footerSep}>/</span>
            <a href="https://www.npmjs.com/package/@tovsa7/zerosync-client" style={styles.footerLink}
               target="_blank" rel="noopener noreferrer">npm</a>
            <span style={styles.footerSep}>/</span>
            <a href="mailto:contact.zerosync@proton.me" style={styles.footerLink}>
              contact.zerosync@proton.me
            </a>
          </p>
        </footer>

      </div>
    )
  }

  // ── Editor ───────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>ZeroSync Demo</h1>
        <p style={styles.subtitle}>End-to-end encrypted collaborative editor</p>
      </header>

      <div style={styles.info}>
        <div style={styles.infoRow}>
          <span style={styles.label}>Room:</span>
          <code style={styles.code}>{roomId}</code>
        </div>
        <div style={styles.infoRow}>
          <span style={styles.label}>Status:</span>
          <span style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
        </div>
        <div style={styles.infoRow}>
          <span style={styles.label}>Peers:</span>
          <span>
            {peers.size > 0
              ? Array.from(peers.values()).map((p, i) =>
                  (p as Record<string, unknown>).name as string ?? `peer-${i}`
                ).join(', ')
              : peerId.slice(0, 8) + ' (you)'}
          </span>
        </div>
        <div style={styles.infoRow}>
          <span style={styles.label}>Transport:</span>
          <span style={connSummary.total === 0 ? undefined : connSummary.p2p === connSummary.total ? styles.secure : { color: '#f0a030', fontWeight: 600 }}>
            {connSummary.total === 0
              ? '—'
              : connSummary.p2p === connSummary.total
                ? `P2P (${connSummary.total} peer${connSummary.total !== 1 ? 's' : ''})`
                : connSummary.p2p > 0
                  ? `Mixed — ${connSummary.p2p}/${connSummary.total} P2P`
                  : `Relay (${connSummary.total} peer${connSummary.total !== 1 ? 's' : ''})`}
          </span>
        </div>
        <div style={styles.infoRow}>
          <span style={styles.label}>Encryption:</span>
          <span style={styles.secure}>AES-256-GCM</span>
        </div>
      </div>

      {connSummary.total > 0 && (
        <div style={{ ...styles.connBanner, borderColor: connColor }}>
          <span style={{ ...styles.connDot, backgroundColor: connColor, boxShadow: `0 0 6px 1px ${connColor}60` }} />
          <span style={styles.connDesc}>{connLabel}</span>
          <span style={{ ...styles.connBadge, color: connColor, borderColor: connColor }}>{connBadge}</span>
          <span style={styles.connPeerCount}>
            {connSummary.total} peer{connSummary.total !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      <div style={styles.nameRow}>
        <input
          style={{ ...styles.nameInput, fontSize: isMobile ? 16 : 14 }}
          placeholder="Your name (for presence)"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button style={styles.shareButton} onClick={handleCopyLink}>
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
      </div>

      {showOnboarding && (
        <div style={styles.onboardingBox}>
          <div style={styles.onboardingHint}>
            <span style={styles.onboardingNum}>1</span>
            <span>Share this link to invite collaborators</span>
          </div>
          <div style={styles.onboardingHint}>
            <span style={styles.onboardingNum}>2</span>
            <span>Everything you type is encrypted before leaving your browser</span>
          </div>
          <div style={styles.onboardingHint}>
            <span style={styles.onboardingNum}>3</span>
            <span>Enter your name above to show your presence</span>
          </div>
          <button style={styles.onboardingDismiss} onClick={handleDismissOnboarding}>
            Got it
          </button>
        </div>
      )}

      <div style={styles.editorContainer}>
        <textarea
          style={{ ...styles.editor, fontSize: isMobile ? 16 : 14 }}
          value={text}
          onChange={handleInput}
          placeholder="Start typing... all content is encrypted before sync."
          spellCheck={false}
        />
      </div>

      <div style={styles.toolbar}>
        <button style={styles.button} onClick={handleClear}>
          Clear
        </button>
        <span style={styles.charCount}>
          {text.length} chars | {new TextEncoder().encode(text).length} bytes
        </span>
      </div>

      {keyReady && (
        <div style={styles.proofPanel}>
          <button style={styles.proofToggle} onClick={() => setProofOpen(o => !o)}>
            <span>Encryption proof</span>
            <span style={styles.proofArrow}>{proofOpen ? '▲' : '▼'}</span>
          </button>
          {proofOpen && (
            <div style={styles.proofBody}>
              <p style={styles.proofLabel}>This is what the server sees</p>
              {cryptoProof ? (
                <>
                  <div style={styles.proofRow}>
                    <span style={styles.proofKey}>Algorithm</span>
                    <code style={styles.proofVal}>AES-256-GCM</code>
                  </div>
                  <div style={styles.proofRow}>
                    <span style={styles.proofKey}>IV (12 B)</span>
                    <code style={styles.proofVal}>{cryptoProof.ivHex}</code>
                  </div>
                  <div style={styles.proofRow}>
                    <span style={styles.proofKey}>Total</span>
                    <code style={styles.proofVal}>
                      {cryptoProof.totalBytes} B
                      {' '}(12 IV + {cryptoProof.plaintextBytes} payload + 16 tag)
                    </code>
                  </div>
                  <div style={styles.proofRow}>
                    <span style={styles.proofKey}>Hex</span>
                  </div>
                  <code style={styles.proofHex}>{cryptoProof.hexPreview}</code>
                </>
              ) : (
                <p style={styles.proofSpinner}>Encrypting…</p>
              )}
            </div>
          )}
        </div>
      )}

      <footer style={styles.footer}>
        {status === 'local' && (
          <p>Start the server with <code>docker compose up</code> to enable real-time sync.</p>
        )}
        <p style={styles.footerDetail}>
          roomKey never leaves this browser. Server sees only encrypted blobs.
        </p>
        <p style={styles.footerLinks}>
          <a href="https://github.com/tovsa7/zerosync" style={styles.footerLink}>GitHub</a>
        </p>
      </footer>
    </div>
  )
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  // ── Shared ──────────────────────────────────────────────────────────────
  container: {
    maxWidth: 720,
    margin: '0 auto',
    padding: '24px 16px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#e0e0e0',
    backgroundColor: '#1a1a2e',
    minHeight: '100vh',
    boxSizing: 'border-box',
    overflowX: 'hidden',
  },
  footer: {
    textAlign: 'center',
    fontSize: 12,
    color: '#555570',
    lineHeight: '1.6',
  },
  footerDetail: {
    marginTop: 4,
    fontStyle: 'italic',
  },
  footerLinks: {
    marginTop: 8,
  },
  footerLink: {
    color: '#8888aa',
    fontSize: 13,
    textDecoration: 'none',
  },

  // ── Landing page ────────────────────────────────────────────────────────
  hero: {
    textAlign: 'center',
    padding: '80px 24px 72px',
  },
  heroBadge: {
    display: 'inline-block',
    padding: '4px 14px',
    fontSize: 11,
    fontFamily: '"Fira Code", "Consolas", monospace',
    fontWeight: 600,
    color: '#4ecca3',
    backgroundColor: 'rgba(78, 204, 163, 0.08)',
    border: '1px solid rgba(78, 204, 163, 0.4)',
    borderRadius: 999,
    marginBottom: 28,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    boxShadow: '0 0 16px rgba(78, 204, 163, 0.12)',
  },
  heroTitle: {
    margin: '0 0 24px',
    fontSize: 42,
    fontWeight: 800,
    color: '#ffffff',
    lineHeight: '1.15',
    letterSpacing: '-0.02em',
  },
  heroSubtitle: {
    margin: '0 auto 36px',
    fontSize: 16,
    color: '#8888aa',
    lineHeight: '1.8',
    maxWidth: 520,
  },
  heroCtas: {
    display: 'flex',
    justifyContent: 'center',
    gap: 12,
    flexWrap: 'wrap' as const,
  },
  tryDemoButton: {
    padding: '14px 40px',
    fontSize: 16,
    fontWeight: 700,
    minHeight: 44,
    color: '#1a1a2e',
    backgroundColor: '#4ecca3',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    transition: 'background-color 0.15s ease, box-shadow 0.15s ease',
    boxShadow: '0 0 28px rgba(78, 204, 163, 0.30)',
    boxSizing: 'border-box' as const,
  },
  githubButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '14px 32px',
    fontSize: 16,
    fontWeight: 700,
    minHeight: 44,
    color: '#e0e0e0',
    backgroundColor: 'transparent',
    border: '1px solid #4ecca3',
    borderRadius: 8,
    cursor: 'pointer',
    textDecoration: 'none',
    boxSizing: 'border-box' as const,
  },
  installSection: {
    paddingBottom: 56,
  },
  codeBlock: {
    backgroundColor: '#0d1b2a',
    borderRadius: 8,
    border: '1px solid #1a3a6e',
    overflow: 'hidden' as const,
    maxWidth: '100%',
    boxSizing: 'border-box' as const,
  },
  codeBlockHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 14px',
    backgroundColor: '#16213e',
    borderBottom: '1px solid #1a3a6e',
  },
  codeBlockLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#4ecca3',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  codeBlockPre: {
    margin: 0,
    padding: '16px 14px',
    overflowX: 'auto' as const,
    whiteSpace: 'pre' as const,
  },
  codeBlockCode: {
    fontFamily: '"Fira Code", "Consolas", monospace',
    fontSize: 13,
    lineHeight: '1.7',
    color: '#c0c0cc',
  },
  howSection: {
    paddingBottom: 64,
  },
  sectionHeading: {
    margin: '0 0 24px',
    fontSize: 22,
    fontWeight: 700,
    color: '#ffffff',
    textAlign: 'center',
    letterSpacing: '-0.01em',
  },
  featureGrid: {
    display: 'flex',
    gap: 16,
    flexWrap: 'wrap' as const,
  },
  featureCard: {
    flex: '1 1 calc(50% - 8px)',
    minWidth: 260,
    padding: '24px 20px',
    background: 'linear-gradient(145deg, #16213e 0%, #1a2845 100%)',
    borderRadius: 12,
    border: '1px solid #1e3a5e',
    boxShadow: '0 4px 24px rgba(0, 0, 0, 0.35)',
  },
  featureCardTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: '#4ecca3',
    marginBottom: 10,
  },
  featureCardText: {
    margin: 0,
    fontSize: 14,
    color: '#8888aa',
    lineHeight: '1.7',
  },
  dataFlowSection: {
    paddingBottom: 64,
  },
  dataFlowCaption: {
    margin: '12px 0 0',
    fontSize: 13,
    color: '#8888aa',
    textAlign: 'center',
    lineHeight: '1.6',
  },
  selfHostSection: {
    paddingBottom: 64,
  },
  selfHostDetails: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 16,
    marginTop: 16,
  },
  selfHostItem: {
    flex: '1 1 180px',
    padding: '12px 14px',
    backgroundColor: '#16213e',
    borderRadius: 6,
    border: '1px solid #1a3a6e',
  },
  selfHostLabel: {
    display: 'block',
    fontSize: 11,
    fontWeight: 700,
    color: '#4ecca3',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    marginBottom: 4,
  },
  selfHostValue: {
    display: 'block',
    fontSize: 13,
    color: '#c0c0cc',
  },
  trustBar: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    padding: '14px 16px',
    backgroundColor: '#16213e',
    borderRadius: 8,
    border: '1px solid #1e3a5e',
    marginBottom: 24,
    fontSize: 13,
    flexWrap: 'wrap' as const,
  },
  trustItem: {
    color: '#4ecca3',
    fontWeight: 600,
  },
  trustSep: {
    color: '#3a3a5e',
  },
  footerSep: {
    color: '#3a3a5e',
    margin: '0 8px',
  },

  // ── Editor ──────────────────────────────────────────────────────────────
  header: {
    marginBottom: 24,
    textAlign: 'center',
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 700,
    color: '#ffffff',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 14,
    color: '#8888aa',
  },
  info: {
    padding: '12px 16px',
    backgroundColor: '#16213e',
    borderRadius: 8,
    marginBottom: 16,
    fontSize: 13,
    lineHeight: '1.8',
  },
  infoRow: {
    display: 'flex',
    gap: 8,
  },
  label: {
    fontWeight: 600,
    color: '#8888aa',
    minWidth: 80,
  },
  code: {
    fontFamily: '"Fira Code", "Consolas", monospace',
    backgroundColor: '#0f3460',
    padding: '1px 6px',
    borderRadius: 4,
    fontSize: 12,
  },
  secure: {
    color: '#4ecca3',
    fontWeight: 600,
  },
  nameRow: {
    display: 'flex',
    gap: 8,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  nameInput: {
    flex: 1,
    padding: '8px 12px',
    fontSize: 14,         // overridden to 16 on mobile via inline style
    minHeight: 44,
    color: '#e0e0e0',
    backgroundColor: '#16213e',
    border: '1px solid #1a3a6e',
    borderRadius: 6,
    outline: 'none',
    boxSizing: 'border-box',
  },
  shareButton: {
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    color: '#e0e0e0',
    backgroundColor: '#0f3460',
    border: '1px solid #1a3a6e',
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },

  // ── Onboarding hints ────────────────────────────────────────────────────
  onboardingBox: {
    padding: '14px 16px',
    backgroundColor: '#16213e',
    borderRadius: 8,
    border: '1px solid #4ecca3',
    marginBottom: 12,
  },
  onboardingHint: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '5px 0',
    fontSize: 13,
    color: '#c0c0cc',
  },
  onboardingNum: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 20,
    height: 20,
    borderRadius: '50%',
    backgroundColor: '#4ecca3',
    color: '#1a1a2e',
    fontSize: 11,
    fontWeight: 700,
    flexShrink: 0,
  },
  onboardingDismiss: {
    marginTop: 10,
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    color: '#1a1a2e',
    backgroundColor: '#4ecca3',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },

  editorContainer: {
    marginBottom: 8,
  },
  editor: {
    width: '100%',
    minHeight: 300,
    padding: 16,
    fontFamily: '"Fira Code", "Consolas", monospace',
    fontSize: 14,
    lineHeight: '1.6',
    color: '#e0e0e0',
    backgroundColor: '#0f3460',
    border: '1px solid #1a3a6e',
    borderRadius: 8,
    resize: 'vertical',
    outline: 'none',
    boxSizing: 'border-box',
  },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  button: {
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: 600,
    minHeight: 44,
    color: '#e0e0e0',
    backgroundColor: '#e94560',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  charCount: {
    fontSize: 12,
    color: '#666680',
  },

  // ── Connection quality indicator ────────────────────────────────────────
  connBanner: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    backgroundColor: '#16213e',
    borderRadius: 6,
    border: '1px solid',
    marginBottom: 12,
  },
  connDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  connDesc: {
    flex: 1,
    fontSize: 13,
    color: '#c0c0cc',
    fontWeight: 500,
  },
  connBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 3,
    border: '1px solid',
    letterSpacing: '0.05em',
  },
  connPeerCount: {
    fontSize: 11,
    color: '#555570',
  },

  // ── Encryption proof panel ───────────────────────────────────────────────
  proofPanel: {
    marginBottom: 24,
    backgroundColor: '#16213e',
    borderRadius: 8,
    border: '1px solid #1a3a6e',
    overflow: 'hidden',
  },
  proofToggle: {
    width: '100%',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 14px',
    fontSize: 13,
    fontWeight: 600,
    color: '#8888aa',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
  },
  proofArrow: {
    fontSize: 10,
    color: '#555570',
  },
  proofBody: {
    padding: '0 14px 14px',
    borderTop: '1px solid #1a3a6e',
  },
  proofLabel: {
    margin: '12px 0 10px',
    fontSize: 11,
    fontWeight: 700,
    color: '#4ecca3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  proofRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    marginBottom: 6,
    fontSize: 12,
  },
  proofKey: {
    color: '#8888aa',
    minWidth: 80,
    flexShrink: 0,
  },
  proofVal: {
    fontFamily: '"Fira Code", "Consolas", monospace',
    fontSize: 11,
    color: '#c0c0cc',
    backgroundColor: '#0f3460',
    padding: '1px 6px',
    borderRadius: 3,
  },
  proofHex: {
    display: 'block',
    fontFamily: '"Fira Code", "Consolas", monospace',
    fontSize: 11,
    lineHeight: '1.8',
    color: '#4ecca3',
    backgroundColor: '#0f3460',
    padding: '10px 12px',
    borderRadius: 6,
    wordBreak: 'break-all',
    marginTop: 4,
  },
  proofSpinner: {
    fontSize: 12,
    color: '#555570',
    fontStyle: 'italic',
    margin: '10px 0 0',
  },
}
