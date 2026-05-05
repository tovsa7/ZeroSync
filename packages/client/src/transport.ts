/**
 * transport.ts — ZeroSync peer-to-peer transport with relay fallback.
 *
 * Spec:
 * - Transport manages one RTCPeerConnection per remote peer.
 * - Initiator creates an offer and sends it via ICE_OFFER signaling.
 * - Responder waits for ICE_OFFER, creates an answer, sends ICE_ANSWER.
 * - ICE candidates are exchanged via signaling until DataChannel opens.
 * - If DataChannel does not open within iceTimeoutMs (default 5000ms),
 *   the peer connection is considered relay-only for that session.
 * - When DataChannel opens, a mutual authentication handshake runs BEFORE
 *   any application messages are dispatched or dcReady is set:
 *   1. Both sides independently send HANDSHAKE_CHALLENGE (0x05): 16 random bytes.
 *   2. On receiving a CHALLENGE: compute encrypt(roomKey, challenge) and send
 *      HANDSHAKE_RESPONSE (0x06). A valid AES-GCM encryption proves knowledge
 *      of roomKey without exposing it.
 *   3. On receiving a RESPONSE: decrypt(roomKey, response) and compare to the
 *      original challenge. Mismatch or decryption failure → close DC, mark
 *      peer relay-only, log a warning. Invariant: peer never gains dcReady
 *      unless they prove they share roomKey.
 *   4. Handshake completes when both: (a) we responded to remote's challenge,
 *      and (b) we verified remote's response to our challenge. Only then is
 *      dcReady set to true and onPeerConnected called.
 *   5. If handshake is not complete within handshakeTimeoutMs (default 5000ms),
 *      the DC is closed and the peer falls back to relay.
 *   Application messages received before handshake completes are discarded.
 * - When DataChannel opens, it is used for all subsequent sends to that peer.
 * - Relay path: encrypt(frame(type, data)) → base64 → RELAY signaling message.
 * - DataChannel path: frame(type, encrypt(data)) → binary ArrayBuffer.
 * - All incoming application messages (DC or relay) are decrypted and dispatched
 *   via onMessage. Decryption failures are discarded silently (invariant #4).
 *
 * Wire framing (DataChannel):
 *   [type_byte (1)] [payload (N)]
 *   For 0x01–0x04: payload = encrypted blob (AES-GCM).
 *   For 0x05:      payload = 16 raw bytes (challenge, not encrypted).
 *   For 0x06:      payload = AES-GCM encrypt(roomKey, challenge) (28+ bytes).
 *
 * Wire framing (Relay payload, encrypted):
 *   encrypt([type_byte (1)] [raw_data (N)]) → base64
 */

import type { SignalingClient, IceType, SignalingEventMap } from './signaling.js'
import { encrypt, decrypt } from './crypto.js'

// ── Message types (PROTOCOL.md) ───────────────────────────────────────────────

export const MessageType = {
  UPDATE:               0x01,
  PRESENCE:             0x02,
  SYNC_REQ:             0x03,
  SYNC_RES:             0x04,
  /** DataChannel-only. Payload: 16 raw random bytes. Not encrypted. */
  HANDSHAKE_CHALLENGE:  0x05,
  /** DataChannel-only. Payload: AES-GCM encrypt(roomKey, challenge). */
  HANDSHAKE_RESPONSE:   0x06,
} as const

export type MessageType = typeof MessageType[keyof typeof MessageType]

// ── Pure framing ──────────────────────────────────────────────────────────────

/**
 * Frames a message for DataChannel transmission.
 *
 * Spec:
 * - Format: [type_byte (1)] [payload (N)]
 * - Does not encrypt — caller is responsible for encrypting payload first
 *   (DataChannel path) or encrypting the full frame (relay path).
 * - Returns a new Uint8Array; does not mutate inputs.
 */
export function frame(type: MessageType, payload: Uint8Array): Uint8Array {
  const wire = new Uint8Array(1 + payload.length)
  wire[0] = type
  wire.set(payload, 1)
  return wire
}

/**
 * Parses a framed message.
 *
 * Spec:
 * - Returns null if wire is empty.
 * - Returns { type, payload } for any non-empty wire — type byte is passed
 *   through as-is; unknown types are caller's concern.
 * - Does not decrypt.
 */
export function parse(wire: Uint8Array): { type: number; payload: Uint8Array } | null {
  if (wire.length === 0) return null
  return { type: wire[0]!, payload: wire.slice(1) }
}

// ── Transport options ─────────────────────────────────────────────────────────

export interface TransportOptions {
  peerId:               string
  roomId:               string
  roomKey:              CryptoKey
  signaling:            SignalingClient
  /**
   * ICE servers for WebRTC peer connections.
   * Pass [] to disable STUN (P2P will only work on the same network).
   * See README for recommended public STUN server configuration.
   */
  iceServers:           RTCIceServer[]
  onMessage:            (fromPeerId: string, type: MessageType, data: Uint8Array) => void
  /** Called when DataChannel to remotePeerId is open AND handshake is verified. */
  onPeerConnected?:     (remotePeerId: string) => void
  /** Called when ICE timeout fires and peer falls back to relay-only. */
  onPeerRelayReady?: (remotePeerId: string) => void
  iceTimeoutMs?:        number
  /** Max time to complete mutual auth handshake after DC opens. Default 5000ms. */
  handshakeTimeoutMs?:  number
}

// ── Per-peer connection state ─────────────────────────────────────────────────

interface HandshakeState {
  /** 16 random bytes we sent as HANDSHAKE_CHALLENGE. */
  readonly challenge:   Uint8Array
  /** True once we have sent HANDSHAKE_RESPONSE to the remote's challenge. */
  challengeResponded:   boolean
  /** True once we have verified the remote's HANDSHAKE_RESPONSE to our challenge. */
  responseVerified:     boolean
  /** Timeout handle — cleared on completion or failure. */
  readonly timer:       ReturnType<typeof setTimeout>
}

interface PeerConn {
  pc:        RTCPeerConnection
  dc:        RTCDataChannel | null
  dcReady:   boolean
  relayOnly: boolean
  /** ICE timeout handle — cleared when DC opens. */
  timer:     ReturnType<typeof setTimeout> | null
  /** Populated from DC open until handshake completes or fails. */
  handshake: HandshakeState | null
}

const ICE_TIMEOUT_MS        = 5_000
const HANDSHAKE_TIMEOUT_MS  = 5_000
const CHALLENGE_BYTES       = 16

// ── Transport ─────────────────────────────────────────────────────────────────

export class Transport {
  private readonly peerId:              string
  private readonly roomId:              string
  private readonly roomKey:             CryptoKey
  private readonly signaling:           SignalingClient
  private readonly iceServers:          RTCIceServer[]
  private readonly onMessage:           TransportOptions['onMessage']
  private readonly iceTimeoutMs:        number
  private readonly handshakeTimeoutMs:  number
  private readonly onPeerConnected:     TransportOptions['onPeerConnected']
  private readonly onPeerRelayReady?: TransportOptions['onPeerRelayReady']
  private readonly conns = new Map<string, PeerConn>()
  private _relayPeerIds = new Set<string>()

  // Bound handler references kept so off() removes the exact same function
  // objects that on() registered. Arrow functions create a new reference each
  // time, so storing them here is required for correct listener removal.
  private readonly boundOnIce:          SignalingEventMap['ice']          = e => this.onIce(e)
  private readonly boundOnRelayDeliver: SignalingEventMap['relayDeliver'] = e => this.onRelayDeliver(e)

  constructor(opts: TransportOptions) {
    this.peerId             = opts.peerId
    this.roomId             = opts.roomId
    this.roomKey            = opts.roomKey
    this.signaling          = opts.signaling
    this.iceServers         = opts.iceServers
    this.onMessage          = opts.onMessage
    this.onPeerConnected    = opts.onPeerConnected
    this.onPeerRelayReady    = opts.onPeerRelayReady
    this.iceTimeoutMs       = opts.iceTimeoutMs       ?? ICE_TIMEOUT_MS
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS

    this.signaling
      .on('ice',          this.boundOnIce)
      .on('relayDeliver', this.boundOnRelayDeliver)
  }

  // ── Peer lifecycle ──────────────────────────────────────────────────────────

  /**
   * Adds a remote peer. If initiator=true, creates an offer and sends it.
   * If initiator=false, waits for an incoming ICE_OFFER.
   */
  addPeer(remotePeerId: string, initiator: boolean): void {
    if (this.conns.has(remotePeerId)) return

    const pc = new RTCPeerConnection({ iceServers: this.iceServers })

    const conn: PeerConn = { pc, dc: null, dcReady: false, relayOnly: false, timer: null, handshake: null }
    this.conns.set(remotePeerId, conn)

    // ICE timeout → mark as relay-only for this session.
    conn.timer = setTimeout(() => {
      if (!conn.dcReady) {
        conn.relayOnly = true
        this.onPeerRelayReady?.(remotePeerId)
      }
    }, this.iceTimeoutMs)

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.signaling.sendICE(
          'ICE_CANDIDATE',
          this.roomId,
          remotePeerId,
          JSON.stringify(candidate),
        )
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        conn.relayOnly = true
      }
    }

    if (initiator) {
      const dc = pc.createDataChannel('zerosync', { ordered: true })
      conn.dc = dc
      this.setupDC(dc, remotePeerId, conn)

      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer).then(() => offer))
        .then(offer => {
          this.signaling.sendICE('ICE_OFFER', this.roomId, remotePeerId, offer.sdp ?? '')
        })
        .catch(() => { conn.relayOnly = true })
    } else {
      pc.ondatachannel = ({ channel }) => {
        conn.dc = channel
        this.setupDC(channel, remotePeerId, conn)
      }
    }
  }

  /** Removes a peer and closes its connection. */
  removePeer(remotePeerId: string): void {
    const conn = this.conns.get(remotePeerId)
    if (!conn) return
    if (conn.timer) clearTimeout(conn.timer)
    if (conn.handshake) clearTimeout(conn.handshake.timer)
    conn.dc?.close()
    conn.pc.close()
    this.conns.delete(remotePeerId)
  }

  /**
   * Close every peer connection without tearing down signaling subscriptions.
   *
   * Called by the room layer after a WebSocket reconnect: the original
   * RTCPeerConnections were negotiated against a now-stale signaling session,
   * and their ICE candidates may reference network paths that no longer work.
   * Without this reset, peers stay stuck on the relay path until each PC
   * eventually times out (30 s+) — observed in pre-launch testing as N1.
   *
   * The room layer immediately re-adds peers from the refreshed PEER_LIST,
   * which restarts ICE gathering and SDP negotiation from a clean slate.
   */
  closeAllPeers(): void {
    for (const peerId of Array.from(this.conns.keys())) {
      this.removePeer(peerId)
    }
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  /**
   * Sends via relay (signaling WebSocket).
   * Wire: encrypt(frame(type, data)) → base64 → RELAY.payload
   *
   * NOTE: The server broadcasts RELAY_DELIVER to all peers in the room.
   * `remotePeerId` is accepted for API symmetry with sendDC but is not used —
   * targeted relay is not supported by the protocol.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sendRelay(_remotePeerId: string, type: MessageType, data: Uint8Array): void {
    void encrypt(this.roomKey, frame(type, data)).then(ciphertext => {
      if (ciphertext.length > 65536) {
        console.warn('[zerosync] relay payload exceeds 64 KB limit, dropping')
        return
      }
      this.signaling.sendRelay(this.roomId, toBase64(ciphertext))
    })
  }

  /**
   * Sends to a specific peer: uses DataChannel if ready, relay otherwise.
   * Use for messages that must reach the peer regardless of DC state (e.g. SYNC_REQ/RES).
   */
  send(remotePeerId: string, type: MessageType, rawData: Uint8Array): void {
    const conn = this.conns.get(remotePeerId)
    if (conn?.dcReady && conn.dc) {
      this.sendDC(remotePeerId, type, rawData)
    } else {
      this.sendRelay(remotePeerId, type, rawData)
    }
  }

  /**
   * Sends to a specific peer via DataChannel.
   *
   * Spec:
   * - rawData is unencrypted; encryption is handled internally.
   * - Wire: frame(type, encrypt(rawData)) → binary ArrayBuffer.
   * - No-op if DataChannel is not open and verified for that peer.
   */
  sendDC(remotePeerId: string, type: MessageType, rawData: Uint8Array): void {
    const conn = this.conns.get(remotePeerId)
    if (!conn?.dcReady || !conn.dc) return
    const dc = conn.dc
    void encrypt(this.roomKey, rawData).then(encryptedBlob => {
      const wire = frame(type, encryptedBlob)
      dc.send(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength) as ArrayBuffer)
    })
  }

  /**
   * Broadcasts to all peers, using DataChannel when available, relay otherwise.
   *
   * Spec:
   * - rawData is unencrypted; encryption is handled per-channel.
   * - DC wire:    frame(type, encrypt(rawData))
   * - Relay wire: encrypt(frame(type, rawData)) → base64
   * - Encrypts once for all DC peers, once for relay (different wire formats).
   */
  broadcast(type: MessageType, rawData: Uint8Array): void {
    const dcChannels: RTCDataChannel[] = []
    let needsRelay = false

    for (const [, conn] of this.conns) {
      if (conn.dcReady && conn.dc) {
        dcChannels.push(conn.dc)
      } else {
        needsRelay = true
      }
    }

    if (dcChannels.length > 0) {
      void encrypt(this.roomKey, rawData).then(encryptedBlob => {
        const wire = frame(type, encryptedBlob).buffer as ArrayBuffer
        for (const dc of dcChannels) dc.send(wire)
      })
    }

    if (needsRelay) {
      void encrypt(this.roomKey, frame(type, rawData)).then(ciphertext => {
        this.signaling.sendRelay(this.roomId, toBase64(ciphertext))
      })
    }
  }

  /**
   * Returns a snapshot of the current connection state across all peers.
   *
   * Spec:
   * - total: number of known peers (with or without open DataChannel).
   * - p2p: number of peers whose DataChannel is open and handshake verified.
   * - Peers in relay-only mode are counted in total but not in p2p.
   */
  getConnectionSummary(): { total: number; p2p: number } {
    let p2p = 0
    for (const [, conn] of this.conns) {
      if (conn.dcReady) p2p++
    }
    return { total: this.conns.size, p2p }
  }

  /**
   * Updates the set of relay peer IDs. Called when the signaling client
   * emits a relayNodes event. Relay peers skip the mutual auth handshake
   * because they do not possess roomKey.
   */
  updateRelayPeerIds(ids: Set<string>): void {
    this._relayPeerIds = ids
  }

  /** Closes all peer connections and detaches signaling listeners. */
  close(): void {
    for (const [peerId] of this.conns) this.removePeer(peerId)
    this.signaling.off('ice', this.boundOnIce)
    this.signaling.off('relayDeliver', this.boundOnRelayDeliver)
  }

  // ── DataChannel setup ───────────────────────────────────────────────────────

  private setupDC(dc: RTCDataChannel, remotePeerId: string, conn: PeerConn): void {
    dc.binaryType = 'arraybuffer'

    dc.onopen = () => {
      if (conn.timer) { clearTimeout(conn.timer); conn.timer = null }
      conn.relayOnly = false

      // Relay peers have no roomKey — skip mutual auth handshake entirely.
      if (this._relayPeerIds.has(remotePeerId)) {
        conn.dcReady = true
        this.onPeerConnected?.(remotePeerId)
        return
      }

      // Do NOT set dcReady yet — wait for mutual auth handshake to complete.
      this.startHandshake(dc, remotePeerId, conn)
    }

    dc.onclose = () => {
      conn.dcReady = false
      conn.relayOnly = true
    }

    dc.onmessage = ({ data }) => {
      const wire = new Uint8Array(data as ArrayBuffer)
      const parsed = parse(wire)
      if (!parsed) return

      // Intercept handshake messages before the application decrypt path.
      if (parsed.type === MessageType.HANDSHAKE_CHALLENGE) {
        void this.handleChallenge(dc, remotePeerId, conn, parsed.payload)
        return
      }
      if (parsed.type === MessageType.HANDSHAKE_RESPONSE) {
        void this.handleResponse(dc, remotePeerId, conn, parsed.payload)
        return
      }

      // Discard application messages until mutual auth is complete.
      if (!conn.dcReady) {
        console.warn('[zerosync] DC message before handshake, discarding')
        return
      }

      const type = parsed.type as MessageType
      void decrypt(this.roomKey, parsed.payload)
        .then(plaintext => {
          this.onMessage(remotePeerId, type, plaintext)
        })
        .catch(() => {
          // Invariant #4: decryption failures are silent.
          console.warn('[zerosync] DC decryption failed, discarding message')
        })
    }
  }

  // ── Handshake ─────────────────────────────────────────────────────────────────

  /**
   * Starts the mutual auth handshake immediately after DC opens.
   * Sends a 16-byte random challenge unencrypted.
   * The challenge is not secret — security comes from the encrypted response.
   */
  private startHandshake(dc: RTCDataChannel, remotePeerId: string, conn: PeerConn): void {
    const challenge = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES))

    const timer = setTimeout(() => {
      console.warn('[zerosync] handshake timeout for peer', remotePeerId)
      conn.handshake = null
      conn.relayOnly = true
      dc.close()
    }, this.handshakeTimeoutMs)

    conn.handshake = { challenge, challengeResponded: false, responseVerified: false, timer }

    // Send CHALLENGE unencrypted — the random bytes carry no secret.
    const wire = frame(MessageType.HANDSHAKE_CHALLENGE, challenge)
    dc.send(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength) as ArrayBuffer)
  }

  /**
   * Handles an incoming HANDSHAKE_CHALLENGE from the remote peer.
   * Responds with encrypt(roomKey, challenge) — proves we know roomKey.
   */
  private handleChallenge(
    dc: RTCDataChannel,
    remotePeerId: string,
    conn: PeerConn,
    challenge: Uint8Array,
  ): Promise<void> {
    if (!conn.handshake) return Promise.resolve()
    return encrypt(this.roomKey, challenge)
      .then(encryptedChallenge => {
        if (!conn.handshake) return  // peer was removed while we were encrypting
        const wire = frame(MessageType.HANDSHAKE_RESPONSE, encryptedChallenge)
        dc.send(wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength) as ArrayBuffer)
        conn.handshake.challengeResponded = true
        this.maybeCompleteHandshake(remotePeerId, conn)
      })
      .catch(() => {
        // Encryption failure is unexpected (key is valid) — treat as relay-only.
        if (conn.handshake) clearTimeout(conn.handshake.timer)
        conn.handshake = null
        conn.relayOnly = true
      })
  }

  /**
   * Handles an incoming HANDSHAKE_RESPONSE from the remote peer.
   * Verifies decrypt(roomKey, response) === our_challenge.
   * Mismatch or decryption failure = peer does not know roomKey → DC closed.
   */
  private handleResponse(
    dc: RTCDataChannel,
    remotePeerId: string,
    conn: PeerConn,
    response: Uint8Array,
  ): Promise<void> {
    if (!conn.handshake) return Promise.resolve()
    const expectedChallenge = conn.handshake.challenge
    return decrypt(this.roomKey, response)
      .then(plaintext => {
        if (!conn.handshake) return  // removed while decrypting
        if (!bytesEqual(plaintext, expectedChallenge)) {
          console.warn('[zerosync] handshake RESPONSE mismatch — peer does not know roomKey')
          clearTimeout(conn.handshake.timer)
          conn.handshake = null
          conn.relayOnly = true
          dc.close()
          return
        }
        conn.handshake.responseVerified = true
        this.maybeCompleteHandshake(remotePeerId, conn)
      })
      .catch(() => {
        // Decryption failure = peer used the wrong key.
        console.warn('[zerosync] handshake RESPONSE decryption failed — peer does not know roomKey')
        if (conn.handshake) clearTimeout(conn.handshake.timer)
        conn.handshake = null
        conn.relayOnly = true
        dc.close()
      })
  }

  /**
   * Checks if both halves of the mutual handshake are complete.
   * Sets dcReady and fires onPeerConnected when both are satisfied.
   */
  private maybeCompleteHandshake(remotePeerId: string, conn: PeerConn): void {
    if (!conn.handshake) return
    if (!conn.handshake.challengeResponded || !conn.handshake.responseVerified) return
    clearTimeout(conn.handshake.timer)
    conn.handshake = null
    conn.dcReady = true
    this.onPeerConnected?.(remotePeerId)
  }

  // ── Incoming ICE signaling ──────────────────────────────────────────────────

  private onIce(e: { type: IceType; fromPeerId: string; payload: string }): void {
    const conn = this.conns.get(e.fromPeerId)

    switch (e.type) {
      case 'ICE_OFFER':
        if (!conn) {
          // We're the responder — peer wasn't added yet.
          this.addPeer(e.fromPeerId, false)
        }
        this.handleOffer(e.fromPeerId, e.payload)
        break

      case 'ICE_ANSWER':
        if (conn) this.handleAnswer(e.fromPeerId, e.payload)
        break

      case 'ICE_CANDIDATE':
        if (conn) {
          void conn.pc.addIceCandidate(
            JSON.parse(e.payload) as RTCIceCandidateInit
          ).catch(() => {})
        }
        break
    }
  }

  private handleOffer(remotePeerId: string, sdp: string): void {
    const conn = this.conns.get(remotePeerId)
    if (!conn) return
    void conn.pc.setRemoteDescription({ type: 'offer', sdp })
      .then(() => conn.pc.createAnswer())
      .then(answer => conn.pc.setLocalDescription(answer).then(() => answer))
      .then(answer => {
        this.signaling.sendICE('ICE_ANSWER', this.roomId, remotePeerId, answer.sdp ?? '')
      })
      .catch(() => { conn.relayOnly = true })
  }

  private handleAnswer(remotePeerId: string, sdp: string): void {
    const conn = this.conns.get(remotePeerId)
    if (!conn) return
    void conn.pc.setRemoteDescription({ type: 'answer', sdp })
      .catch(() => { conn.relayOnly = true })
  }

  // ── Incoming relay messages ─────────────────────────────────────────────────

  private onRelayDeliver(e: { fromPeerId: string; payload: string }): void {
    const ciphertext = fromBase64(e.payload)
    if (!ciphertext) return

    void decrypt(this.roomKey, ciphertext)
      .then(plaintext => {
        const parsed = parse(plaintext)
        if (!parsed) return
        this.onMessage(e.fromPeerId, parsed.type as MessageType, parsed.payload)
      })
      .catch(() => {
        // Invariant #4: decryption failures are silent.
        console.warn('[zerosync] relay decryption failed, discarding message')
      })
  }
}

// ── Base64 helpers ────────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/**
 * Constant-time byte comparison.
 * Returns true iff a and b have the same length and identical bytes.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
