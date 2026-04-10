/**
 * signaling.ts — ZeroSync signaling protocol client.
 *
 * Spec:
 * - SignalingClient.connect(opts) sends HELLO on WebSocket open, resolves
 *   with the client instance when PEER_LIST is received.
 * - Rejects if WebSocket fires onerror before PEER_LIST arrives.
 * - Incoming server messages are dispatched to typed event handlers via .on().
 * - Malformed JSON and unknown message types are silently ignored.
 * - Server does NOT verify HMAC — hmac field is sent but not relied upon.
 * - roomKey is never included in any outgoing message (invariant #2).
 * - On unexpected close, reconnects with exponential backoff (1s, 2s, 4s … 30s).
 * - On client.close(), marks intentional close — no retry.
 */

// ── Message types (PROTOCOL.md) ───────────────────────────────────────────────

export type IceType = 'ICE_OFFER' | 'ICE_ANSWER' | 'ICE_CANDIDATE'

export interface RelayPeerInfo {
  peerId: string
  region: string
}

export type ServerMessage =
  | { type: 'PEER_LIST';     peers: string[] }
  | { type: 'PEER_JOINED';   peerId: string }
  | { type: 'PEER_LEFT';     peerId: string }
  | { type: 'RELAY_NODES';   peers: RelayPeerInfo[] }
  | { type: 'RELAY_DELIVER'; fromPeerId: string; payload: string }
  | { type: IceType;         fromPeerId: string; roomId: string; payload: string }
  | { type: 'ERROR';         code: string; message: string }
  | { type: 'PONG' }

// ── Event map ─────────────────────────────────────────────────────────────────

export interface SignalingEventMap {
  peerJoined:   (e: { peerId: string }) => void
  peerLeft:     (e: { peerId: string }) => void
  relayNodes:   (e: { relayPeerIds: Set<string> }) => void
  relayDeliver: (e: { fromPeerId: string; payload: string }) => void
  ice:          (e: { type: IceType; fromPeerId: string; payload: string }) => void
  error:        (e: { code: string; message: string }) => void
  pong:         () => void
  /** Fired when the WS drops unexpectedly and a reconnect has been scheduled. */
  disconnected: () => void
  /** Fired when the WS is re-established and PEER_LIST received. */
  reconnect:    (e: { peers: string[] }) => void
  /** Fired only when close() is called intentionally. */
  close:        () => void
}

export type SignalingEventName = keyof SignalingEventMap

// ── Connect options ───────────────────────────────────────────────────────────

export interface SignalingConnectOptions {
  serverUrl: string
  roomId:    string
  peerId:    string
  nonce:     string
  hmac:      string
}

// ── SignalingClient ───────────────────────────────────────────────────────────

const PING_INTERVAL_MS = 25_000
const MAX_RECONNECT_MS = 30_000

export class SignalingClient {
  private ws: WebSocket
  private readonly connectOpts: SignalingConnectOptions
  private readonly _peers: string[]
  private _relayPeerIds = new Set<string>()
  private readonly handlers = new Map<SignalingEventName, Set<(...args: unknown[]) => void>>()
  private pingTimer: ReturnType<typeof setInterval> | null = null

  private _intentionallyClosed = false
  private _reconnectAttempt    = 0
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null

  private constructor(ws: WebSocket, initialPeers: string[], opts: SignalingConnectOptions) {
    this.ws          = ws
    this._peers      = initialPeers
    this.connectOpts = opts
    this.pingTimer   = setInterval(() => this.sendPing(), PING_INTERVAL_MS)
    ws.onmessage     = (e: MessageEvent<string>) => this.dispatch(e.data)
    ws.onclose       = () => this.handleClose()
  }

  /**
   * Connects to the signaling server and resolves when PEER_LIST is received.
   * Rejects on WebSocket error before the handshake completes.
   */
  static connect(opts: SignalingConnectOptions): Promise<SignalingClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(opts.serverUrl)
      let settled = false

      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        if (err) {
          reject(err)
        }
      }

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type:   'HELLO',
          roomId: opts.roomId,
          peerId: opts.peerId,
          nonce:  opts.nonce,
          hmac:   opts.hmac,
        }))
      }

      ws.onerror = () => {
        settle(new Error('WebSocket error during signaling connect'))
      }

      ws.onmessage = (event: MessageEvent<string>) => {
        const msg = parseMessage(event.data)
        if (!msg) return

        if (!settled && msg.type === 'PEER_LIST') {
          settled = true
          resolve(new SignalingClient(ws, msg.peers, opts))
          return
        }

        if (!settled && msg.type === 'ERROR') {
          settle(new Error(`Signaling error ${msg.code}: ${msg.message}`))
        }
      }

      ws.onclose = () => {
        settle(new Error('WebSocket closed before PEER_LIST'))
      }
    })
  }

  // ── Event emitter ───────────────────────────────────────────────────────────

  on<K extends SignalingEventName>(event: K, handler: SignalingEventMap[K]): this {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler as (...args: unknown[]) => void)
    return this
  }

  off<K extends SignalingEventName>(event: K, handler: SignalingEventMap[K]): this {
    this.handlers.get(event)?.delete(handler as (...args: unknown[]) => void)
    return this
  }

  private emit<K extends SignalingEventName>(
    event: K,
    ...args: Parameters<SignalingEventMap[K]>
  ): void {
    this.handlers.get(event)?.forEach(h => (h as (...a: unknown[]) => void)(...args))
  }

  // ── Incoming dispatch ───────────────────────────────────────────────────────

  private dispatch(data: string): void {
    const msg = parseMessage(data)
    if (!msg) return

    switch (msg.type) {
      case 'PEER_JOINED':
        this._peers.push(msg.peerId)
        this.emit('peerJoined', { peerId: msg.peerId })
        break
      case 'PEER_LEFT': {
        const idx = this._peers.indexOf(msg.peerId)
        if (idx !== -1) this._peers.splice(idx, 1)
        this.emit('peerLeft', { peerId: msg.peerId })
        break
      }
      case 'RELAY_NODES': {
        this._relayPeerIds = new Set(msg.peers.map(p => p.peerId))
        this.emit('relayNodes', { relayPeerIds: new Set(this._relayPeerIds) })
        break
      }
      case 'RELAY_DELIVER':
        this.emit('relayDeliver', { fromPeerId: msg.fromPeerId, payload: msg.payload })
        break
      case 'ICE_OFFER':
      case 'ICE_ANSWER':
      case 'ICE_CANDIDATE':
        this.emit('ice', { type: msg.type, fromPeerId: msg.fromPeerId, payload: msg.payload })
        break
      case 'ERROR':
        this.emit('error', { code: msg.code, message: msg.message })
        break
      case 'PONG':
        this.emit('pong')
        break
      // PEER_LIST after connect is ignored — only expected once during handshake.
    }
  }

  // ── Reconnect logic ─────────────────────────────────────────────────────────

  private handleClose(): void {
    if (this._intentionallyClosed) {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
      this.emit('close')
      return
    }
    // Unexpected drop — notify callers before scheduling the reconnect attempt.
    this.emit('disconnected')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this._reconnectAttempt, MAX_RECONNECT_MS)
    this._reconnectAttempt++
    this._reconnectTimer = setTimeout(() => this.doReconnect(), delay)
  }

  private doReconnect(): void {
    if (this._intentionallyClosed) return
    // Generate a fresh nonce on every reconnect attempt.
    // Reusing connectOpts.nonce would trigger NONCE_REPLAY on the server
    // (30s replay-protection window) and cause an infinite reconnect loop.
    // The server does not verify HMAC so the original hmac is reused as-is.
    const freshNonce = btoa(String.fromCharCode(
      ...crypto.getRandomValues(new Uint8Array(16))
    ))
    const ws = new WebSocket(this.connectOpts.serverUrl)

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type:   'HELLO',
        roomId: this.connectOpts.roomId,
        peerId: this.connectOpts.peerId,
        nonce:  freshNonce,
        hmac:   this.connectOpts.hmac,
      }))
    }

    ws.onerror = () => {
      if (!this._intentionallyClosed) this.scheduleReconnect()
    }

    ws.onmessage = (e: MessageEvent<string>) => {
      const msg = parseMessage(e.data)
      if (!msg) return
      if (msg.type === 'PEER_LIST') {
        this.ws = ws
        this._reconnectAttempt = 0
        this._peers.length = 0
        this._peers.push(...msg.peers)
        ws.onmessage = (ev: MessageEvent<string>) => this.dispatch(ev.data)
        ws.onclose   = () => this.handleClose()
        this.emit('reconnect', { peers: msg.peers })
        // Re-emit last known relay node set so transport can re-apply.
        this.emit('relayNodes', { relayPeerIds: new Set(this._relayPeerIds) })
      } else if (msg.type === 'ERROR') {
        if (!this._intentionallyClosed) this.scheduleReconnect()
      }
    }

    ws.onclose = () => {
      if (!this._intentionallyClosed) this.scheduleReconnect()
    }
  }

  // ── Outgoing messages ───────────────────────────────────────────────────────

  /** Sends an encrypted relay blob to all peers in the room. */
  sendRelay(roomId: string, payload: string): void {
    this.ws.send(JSON.stringify({ type: 'RELAY', roomId, payload }))
  }

  /** Forwards a WebRTC ICE signaling message to a specific peer. */
  sendICE(type: IceType, roomId: string, targetPeerId: string, payload: string): void {
    this.ws.send(JSON.stringify({ type, roomId, targetPeerId, payload }))
  }

  /** Sends a PING to keep the connection alive. */
  sendPing(): void {
    this.ws.send(JSON.stringify({ type: 'PING' }))
  }

  /** Returns a snapshot of currently known peer IDs in the room. */
  peers(): string[] {
    return [...this._peers]
  }

  /** Returns a copy of the current relay peer ID set. */
  relayPeerIds(): Set<string> {
    return new Set(this._relayPeerIds)
  }

  /** Closes the WebSocket connection, stops ping timer, and disables reconnect. */
  close(): void {
    this._intentionallyClosed = true
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    this.ws.close()
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMessage(data: string): ServerMessage | null {
  try {
    const msg = JSON.parse(data) as unknown
    if (typeof msg !== 'object' || msg === null || !('type' in msg)) return null
    return msg as ServerMessage
  } catch {
    return null
  }
}
