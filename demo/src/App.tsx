/**
 * ZeroSync Demo — collaborative text editor.
 *
 * Connects to a ZeroSync server via <ZeroSyncProvider> for real-time
 * E2E-encrypted CRDT sync. All sync state (Room, status, Yjs text, presence)
 * is accessed through @zerosync/react hooks — no manual Room.join / observe
 * wiring.
 *
 * The landing page that used to live here has moved to a standalone Astro
 * site at tovsa7.github.io/ZeroSync/. This demo is served at /ZeroSync/demo/.
 *
 * If the URL hash has no `room=` parameter, a fresh room + encryption key
 * is generated automatically and the hash is updated so the URL can be
 * shared as an invite link.
 */

import { useCallback, useEffect, useMemo, useState, type FC, type ReactElement } from 'react'
import {
  ZeroSyncProvider,
  derivePersistKey,
  useConnectionStatus,
  useMyPresence,
  usePresence,
  useRoom,
  useYText,
} from '@zerosync/react'

// ── Config ──────────────────────────────────────────────────────────────────

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8080/ws'

/** localStorage key used to suppress onboarding hints after first dismiss. */
const ONBOARDING_KEY = 'zerosync_onboarding_done'

interface RoomConfig {
  roomId:     string
  rawKey:     Uint8Array
  roomKey:    CryptoKey
  /**
   * Domain-separated key for at-rest IndexedDB persistence. Derived via
   * HKDF from the same userSecret as roomKey but with different `info`,
   * so wire-encryption and storage-encryption are cryptographically
   * independent.
   */
  persistKey: CryptoKey
  peerId:     string
  nonce:      string
}

// ── Hooks ───────────────────────────────────────────────────────────────────

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
 * Parses room ID and raw key from the URL hash.
 * Format: #room={roomId}&key={base64url(rawKey)}
 */
function parseHash(): { roomId: string; rawKey: Uint8Array } | null {
  if (!window.location.hash.includes('room=')) return null
  const params = new URLSearchParams(window.location.hash.slice(1))
  const roomId = params.get('room')
  const keyStr = params.get('key')
  if (!roomId || !keyStr) return null
  return { roomId, rawKey: base64urlDecode(keyStr) }
}

/**
 * Encrypts the given text with AES-256-GCM and returns display metadata.
 * Used only for the encryption proof panel — not part of the sync protocol.
 * Wire format matches the SDK: IV (12 bytes) || ciphertext+tag.
 */
async function encryptForPreview(key: CryptoKey, text: string): Promise<{
  ivHex:          string
  totalBytes:     number
  hexPreview:     string
  plaintextBytes: number
}> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(text.length > 0 ? text : '\0')
  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)
  const ciphertext = new Uint8Array(ciphertextBuf)

  const blob = new Uint8Array(12 + ciphertext.length)
  blob.set(iv, 0)
  blob.set(ciphertext, 12)

  const ivHex = Array.from(iv)
    .map(b => b.toString(16).padStart(2, '0'))
    .reduce((s, h, i) => s + (i > 0 && i % 4 === 0 ? ' ' : '') + h, '')

  const previewLen = Math.min(blob.length, 32)
  const hexPreview = Array.from(blob.slice(0, previewLen), b => b.toString(16).padStart(2, '0')).join(' ')
    + (blob.length > previewLen ? ' …' : '')

  return { ivHex, totalBytes: blob.length, hexPreview, plaintextBytes: plaintext.length }
}

// ── App — sets up config + Provider ─────────────────────────────────────────

export function App(): ReactElement {
  const [config, setConfig] = useState<RoomConfig | null>(null)

  // On first mount: parse URL hash, or auto-generate a fresh room + key and
  // update the hash so the URL is immediately shareable as an invite link.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const existing = parseHash()
      const roomId = existing?.roomId ?? generateId()
      const rawKey = existing?.rawKey ?? crypto.getRandomValues(new Uint8Array(32))

      // Always keep the full invite link in the hash so creators can share
      // at any time and joiners get a stable URL on reload.
      window.location.hash = `room=${roomId}&key=${base64urlEncode(rawKey)}`

      // Derive both keys from the same userSecret (rawKey). HKDF with
      // different `info` strings yields cryptographically independent keys
      // so a leak of the on-disk persistKey cannot decrypt wire traffic and
      // vice versa.
      const [roomKey, persistKey] = await Promise.all([
        buildRoomKey(rawKey),
        derivePersistKey(rawKey, roomId),
      ])
      if (cancelled) return

      setConfig({
        roomId,
        rawKey,
        roomKey,
        persistKey,
        peerId: crypto.randomUUID(),
        nonce:  generateNonce(),
      })
    })()
    return () => { cancelled = true }
  }, [])

  if (!config) {
    return (
      <div style={styles.container}>
        <p style={styles.loadingText}>Initialising…</p>
      </div>
    )
  }

  return (
    <ZeroSyncProvider
      serverUrl={SERVER_URL}
      roomId={config.roomId}
      roomKey={config.roomKey}
      persistKey={config.persistKey}
      peerId={config.peerId}
      nonce={config.nonce}
      hmac="demo"
      iceServers={[{ urls: 'stun:stun.l.google.com:19302' }]}
    >
      <Editor
        roomId={config.roomId}
        rawKey={config.rawKey}
        roomKey={config.roomKey}
      />
    </ZeroSyncProvider>
  )
}

// ── Editor — hook-driven UI ─────────────────────────────────────────────────

interface EditorProps {
  roomId:  string
  rawKey:  Uint8Array
  roomKey: CryptoKey
}

const Editor: FC<EditorProps> = ({ roomId, roomKey }) => {
  const isMobile = useIsMobile()
  const status   = useConnectionStatus()
  const room     = useRoom()
  const text     = useYText('editor')                               // re-renders on Y.Text mutation
  const peers    = usePresence<{ name: string }>()
  const [, setMyPresence] = useMyPresence<{ name: string }>()

  // Textarea controlled value — derived from Y.Text on every render.
  // useYText handles the observer wiring and triggers re-renders on updates.
  const textValue = text?.toString() ?? ''

  // ── Local UI state ────────────────────────────────────────────────────────

  const [name,           setName]           = useState('')
  const [copied,         setCopied]         = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const [connSummary,    setConnSummary]    = useState({ total: 0, p2p: 0 })
  const [proofOpen,      setProofOpen]      = useState(false)
  const [cryptoProof,    setCryptoProof]    = useState<{
    ivHex:          string
    totalBytes:     number
    hexPreview:     string
    plaintextBytes: number
  } | null>(null)

  // ── Effects ───────────────────────────────────────────────────────────────

  // Onboarding hints on first visit — suppressed after first dismissal.
  useEffect(() => {
    if (!localStorage.getItem(ONBOARDING_KEY)) setShowOnboarding(true)
  }, [])

  // Poll transport summary (P2P vs relay breakdown) while connected.
  useEffect(() => {
    if (!room || status !== 'connected') return
    const id = setInterval(() => setConnSummary(room.getConnectionSummary()), 2000)
    return () => clearInterval(id)
  }, [room, status])

  // Broadcast presence when user types a name and we have an active connection.
  useEffect(() => {
    if (name && status === 'connected') setMyPresence({ name })
  }, [name, status, setMyPresence])

  // Re-encrypt current text when the proof panel is open. 400 ms debounce
  // avoids encrypting on every keystroke.
  useEffect(() => {
    if (!proofOpen) return
    const timer = setTimeout(() => {
      encryptForPreview(roomKey, textValue).then(setCryptoProof)
    }, 400)
    return () => clearTimeout(timer)
  }, [textValue, proofOpen, roomKey])

  // ── Handlers ──────────────────────────────────────────────────────────────

  /**
   * Textarea onChange — compute the smallest diff (common prefix + common
   * suffix) and apply it to Y.Text as incremental insert/delete ops. This
   * preserves CRDT merge semantics and cursor positions during concurrent
   * edits by other peers.
   */
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!text) return
    const newVal = e.target.value
    const oldVal = text.toString()
    if (newVal === oldVal) return

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

    const doc = text.doc
    if (!doc) return
    doc.transact(() => {
      const deleteCount = oldEnd - start
      const insertStr   = newVal.slice(start, newEnd)
      if (deleteCount > 0) text.delete(start, deleteCount)
      if (insertStr)       text.insert(start, insertStr)
    })
  }, [text])

  const handleClear = useCallback(() => {
    if (!text) return
    const doc = text.doc
    if (!doc) return
    doc.transact(() => { text.delete(0, text.length) })
  }, [text])

  const handleCopyLink = useCallback(async () => {
    // Use the native share sheet on devices that support it (iOS/Android).
    // Falls back to clipboard copy on desktop.
    if (navigator.share) {
      try {
        await navigator.share({ url: window.location.href, title: 'Join ZeroSync room' })
        return
      } catch {
        /* user cancelled or share unavailable — fall through */
      }
    }
    await navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [])

  const handleDismissOnboarding = useCallback(() => {
    localStorage.setItem(ONBOARDING_KEY, '1')
    setShowOnboarding(false)
  }, [])

  // ── Derived display values ────────────────────────────────────────────────

  const statusColor =
    status === 'connected'    ? '#5EEAD4' :
    status === 'reconnecting' ? '#f0a030' :
    status === 'closed'       ? '#f0a030' :
                                '#888'
  const statusLabel =
    status === 'connected'    ? 'Connected' :
    status === 'reconnecting' ? 'Reconnecting…' :
    status === 'closed'       ? 'Offline (server unreachable)' :
                                'Connecting…'

  const connIsP2P = connSummary.total > 0 && connSummary.p2p === connSummary.total
  const connIsMix = connSummary.total > 0 && connSummary.p2p > 0 && !connIsP2P
  const connColor = connIsP2P ? '#5EEAD4' : '#f0a030'
  const connLabel = connIsP2P ? 'Direct encrypted connection'
                  : connIsMix ? 'Partially direct connection'
                  : 'Encrypted via relay'
  const connBadge = connIsP2P ? 'P2P' : connIsMix ? 'MIXED' : 'RELAY'

  const peerNames = useMemo(() => {
    if (peers.size === 0) return null
    return Array.from(peers.values())
      .map((p, i) => p.name ?? `peer-${i}`)
      .join(', ')
  }, [peers])

  // ── Render ────────────────────────────────────────────────────────────────

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
          <span>{peerNames ?? '(you are alone)'}</span>
        </div>
        <div style={styles.infoRow}>
          <span style={styles.label}>Transport:</span>
          <span style={
            connSummary.total === 0 ? undefined
            : connIsP2P              ? styles.secure
            :                          { color: '#f0a030', fontWeight: 600 }
          }>
            {connSummary.total === 0
              ? '—'
              : connIsP2P
                ? `P2P (${connSummary.total} peer${connSummary.total !== 1 ? 's' : ''})`
                : connIsMix
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
          value={textValue}
          onChange={handleInput}
          placeholder={
            status === 'closed'
              ? 'Server unreachable. Start it with `docker compose up` — changes will sync once connected.'
              : 'Start typing… all content is encrypted before sync.'
          }
          spellCheck={false}
          disabled={!text}
        />
      </div>

      <div style={styles.toolbar}>
        <button style={styles.button} onClick={handleClear} disabled={!text}>
          Clear
        </button>
        <span style={styles.charCount}>
          {textValue.length} chars | {new TextEncoder().encode(textValue).length} bytes
        </span>
      </div>

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

      <footer style={styles.footer}>
        <p style={styles.footerDetail}>
          roomKey never leaves this browser. Server sees only encrypted blobs.
        </p>
        <p style={styles.footerLinks}>
          <a href="https://tovsa7.github.io/ZeroSync/" style={styles.footerLink}>
            ← Back to landing
          </a>
          {' · '}
          <a href="https://github.com/tovsa7/ZeroSync" style={styles.footerLink}>GitHub</a>
        </p>
      </footer>
    </div>
  )
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth:        720,
    margin:          '0 auto',
    padding:         '24px 16px',
    fontFamily:      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color:           '#e0e0e0',
    backgroundColor: '#0a0a0b',
    minHeight:       '100vh',
    boxSizing:       'border-box',
    overflowX:       'hidden',
  },
  loadingText: {
    textAlign: 'center',
    color:     '#8888aa',
    fontSize:  14,
    padding:   '40px 0',
  },
  header: {
    marginBottom: 24,
    textAlign:    'center',
  },
  title: {
    margin:   0,
    fontSize: 28,
    fontWeight: 700,
    color:    '#ffffff',
  },
  subtitle: {
    margin:   '4px 0 0',
    fontSize: 14,
    color:    '#8888aa',
  },
  info: {
    padding:         '12px 16px',
    backgroundColor: '#171717',
    borderRadius:    8,
    marginBottom:    16,
    fontSize:        13,
    lineHeight:      '1.8',
  },
  infoRow: {
    display: 'flex',
    gap:     8,
  },
  label: {
    fontWeight: 600,
    color:      '#8888aa',
    minWidth:   80,
  },
  code: {
    fontFamily:      '"Fira Code", "Consolas", monospace',
    backgroundColor: '#262626',
    padding:         '1px 6px',
    borderRadius:    4,
    fontSize:        12,
  },
  secure: {
    color:      '#5EEAD4',
    fontWeight: 600,
  },
  nameRow: {
    display:     'flex',
    gap:         8,
    marginBottom: 12,
    flexWrap:    'wrap',
  },
  nameInput: {
    flex:            1,
    padding:         '8px 12px',
    fontSize:        14,
    minHeight:       44,
    color:           '#e0e0e0',
    backgroundColor: '#171717',
    border:          '1px solid #1c1c1f',
    borderRadius:    6,
    outline:         'none',
    boxSizing:       'border-box',
  },
  shareButton: {
    padding:         '8px 16px',
    fontSize:        13,
    fontWeight:      600,
    minHeight:       44,
    color:           '#e0e0e0',
    backgroundColor: '#262626',
    border:          '1px solid #1c1c1f',
    borderRadius:    6,
    cursor:          'pointer',
    whiteSpace:      'nowrap',
  },
  onboardingBox: {
    padding:         '14px 16px',
    backgroundColor: '#171717',
    borderRadius:    8,
    border:          '1px solid #5EEAD4',
    marginBottom:    12,
  },
  onboardingHint: {
    display:    'flex',
    alignItems: 'flex-start',
    gap:        10,
    padding:    '5px 0',
    fontSize:   13,
    color:      '#c0c0cc',
  },
  onboardingNum: {
    display:         'inline-flex',
    alignItems:      'center',
    justifyContent:  'center',
    width:           20,
    height:          20,
    borderRadius:    '50%',
    backgroundColor: '#5EEAD4',
    color:           '#0a0a0b',
    fontSize:        11,
    fontWeight:      700,
    flexShrink:      0,
  },
  onboardingDismiss: {
    marginTop:       10,
    padding:         '6px 16px',
    fontSize:        13,
    fontWeight:      600,
    minHeight:       44,
    color:           '#0a0a0b',
    backgroundColor: '#5EEAD4',
    border:          'none',
    borderRadius:    6,
    cursor:          'pointer',
  },
  editorContainer: {
    marginBottom: 8,
  },
  editor: {
    width:           '100%',
    minHeight:       300,
    padding:         16,
    fontFamily:      '"Fira Code", "Consolas", monospace',
    fontSize:        14,
    lineHeight:      '1.6',
    color:           '#e0e0e0',
    backgroundColor: '#262626',
    border:          '1px solid #1c1c1f',
    borderRadius:    8,
    resize:          'vertical',
    outline:         'none',
    boxSizing:       'border-box',
  },
  toolbar: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginBottom:   24,
  },
  button: {
    padding:         '6px 16px',
    fontSize:        13,
    fontWeight:      600,
    minHeight:       44,
    color:           '#0a0a0b',
    backgroundColor: '#5EEAD4',
    border:          'none',
    borderRadius:    6,
    cursor:          'pointer',
  },
  charCount: {
    fontSize: 12,
    color:    '#666680',
  },
  connBanner: {
    display:         'flex',
    alignItems:      'center',
    gap:             8,
    padding:         '8px 12px',
    backgroundColor: '#171717',
    borderRadius:    6,
    border:          '1px solid',
    marginBottom:    12,
  },
  connDot: {
    width:        8,
    height:       8,
    borderRadius: '50%',
    flexShrink:   0,
  },
  connDesc: {
    flex:       1,
    fontSize:   13,
    color:      '#c0c0cc',
    fontWeight: 500,
  },
  connBadge: {
    fontSize:      10,
    fontWeight:    700,
    padding:       '2px 6px',
    borderRadius:  3,
    border:        '1px solid',
    letterSpacing: '0.05em',
  },
  connPeerCount: {
    fontSize: 11,
    color:    '#555570',
  },
  proofPanel: {
    marginBottom:    24,
    backgroundColor: '#171717',
    borderRadius:    8,
    border:          '1px solid #1c1c1f',
    overflow:        'hidden',
  },
  proofToggle: {
    width:          '100%',
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    padding:        '10px 14px',
    fontSize:       13,
    fontWeight:     600,
    color:          '#8888aa',
    background:     'none',
    border:         'none',
    cursor:         'pointer',
    textAlign:      'left',
  },
  proofArrow: {
    fontSize: 10,
    color:    '#555570',
  },
  proofBody: {
    padding:   '0 14px 14px',
    borderTop: '1px solid #1c1c1f',
  },
  proofLabel: {
    margin:        '12px 0 10px',
    fontSize:      11,
    fontWeight:    700,
    color:         '#5EEAD4',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  proofRow: {
    display:      'flex',
    alignItems:   'baseline',
    gap:          10,
    marginBottom: 6,
    fontSize:     12,
  },
  proofKey: {
    color:      '#8888aa',
    minWidth:   80,
    flexShrink: 0,
  },
  proofVal: {
    fontFamily:      '"Fira Code", "Consolas", monospace',
    fontSize:        11,
    color:           '#c0c0cc',
    backgroundColor: '#262626',
    padding:         '1px 6px',
    borderRadius:    3,
  },
  proofHex: {
    display:         'block',
    fontFamily:      '"Fira Code", "Consolas", monospace',
    fontSize:        11,
    lineHeight:      '1.8',
    color:           '#5EEAD4',
    backgroundColor: '#262626',
    padding:         '10px 12px',
    borderRadius:    6,
    wordBreak:       'break-all',
    marginTop:       4,
  },
  proofSpinner: {
    fontSize:  12,
    color:     '#555570',
    fontStyle: 'italic',
    margin:    '10px 0 0',
  },
  footer: {
    textAlign:  'center',
    fontSize:   12,
    color:      '#555570',
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
    color:          '#8888aa',
    fontSize:       13,
    textDecoration: 'none',
  },
}
