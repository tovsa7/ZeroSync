/**
 * room.ts — ZeroSync public API.
 *
 * Spec:
 * - Room.join(opts) connects to the signaling server, joins the room,
 *   establishes transport, starts CRDT sync and presence.
 * - getDoc() returns the shared Y.Doc instance.
 * - updatePresence(state) broadcasts local presence to all peers.
 * - onPresence(cb) registers a callback for presence changes; returns unsubscribe.
 * - onStatus(cb) registers a callback for signaling connection status changes;
 *   returns unsubscribe.
 *     - 'connected'    — signaling WebSocket is up (initial state + after reconnect).
 *     - 'reconnecting' — WS dropped unexpectedly; client is retrying with backoff.
 *     - 'closed'       — leave() was called intentionally; no further events fired.
 *   onStatus() immediately delivers the current status via queueMicrotask
 *   (BehaviorSubject pattern). It is never called after leave().
 * - leave() disconnects from the room, stops sync/presence, closes transport.
 * - roomKey is never sent to the server (invariant #2).
 * - Incoming transport messages are dispatched to CRDTSync or PresenceManager
 *   based on message type.
 * - On PEER_JOINED: addPeer to transport, request full state (SYNC_REQ).
 * - On PEER_LEFT: removePeer from transport and presence.
 */

import * as Y from 'yjs'
import { SignalingClient } from './signaling.js'
import { Transport, MessageType } from './transport.js'
import { CRDTSync } from './crdt.js'
import { PresenceManager } from './presence.js'
import type { PresenceState, PresenceCallback } from './presence.js'

/** Signaling connection status surfaced by Room.onStatus(). */
export type RoomStatus = 'connected' | 'reconnecting' | 'closed'

export type StatusCallback = (status: RoomStatus) => void

export interface RoomOptions {
  serverUrl:  string
  roomId:     string
  roomKey:    CryptoKey
  peerId:     string
  nonce:      string
  hmac:       string
  /**
   * ICE servers for WebRTC peer connections.
   * Pass [] to disable STUN (P2P will only work on the same network).
   * See README for recommended public STUN server configuration.
   */
  iceServers: RTCIceServer[]
}

export class Room {
  private readonly doc:             Y.Doc
  private readonly signaling:       SignalingClient
  private readonly transport:       Transport
  private readonly crdt:            CRDTSync
  private readonly presence:        PresenceManager
  private readonly statusCallbacks: Set<StatusCallback> = new Set()
  private _status: RoomStatus = 'connected'

  private constructor(
    doc:       Y.Doc,
    signaling: SignalingClient,
    transport: Transport,
    crdt:      CRDTSync,
    presence:  PresenceManager,
  ) {
    this.doc       = doc
    this.signaling = signaling
    this.transport = transport
    this.crdt      = crdt
    this.presence  = presence
  }

  private setStatus(status: RoomStatus): void {
    this._status = status
    for (const cb of this.statusCallbacks) cb(status)
  }

  /**
   * Connects to the signaling server, joins the room, and starts sync.
   * Resolves when the PEER_LIST is received and the room is ready.
   */
  static async join(opts: RoomOptions): Promise<Room> {
    const doc = new Y.Doc()

    const signaling = await SignalingClient.connect({
      serverUrl: opts.serverUrl,
      roomId:    opts.roomId,
      peerId:    opts.peerId,
      nonce:     opts.nonce,
      hmac:      opts.hmac,
    })

    // Determine WebRTC initiator by peer ID lexicographic order to prevent glare:
    // exactly one side sends the offer for each pair.
    const isInitiator = (remotePeerId: string): boolean => opts.peerId > remotePeerId

    // Late-binding: crdtSync and presenceMgr are set before any messages
    // can arrive (transport onMessage fires only on wire data).
    let crdtSync: CRDTSync
    let presenceMgr: PresenceManager

    const transport = new Transport({
      peerId:     opts.peerId,
      roomId:     opts.roomId,
      roomKey:    opts.roomKey,
      iceServers: opts.iceServers,
      signaling,
      onMessage: (fromPeerId, type, data) => {
        switch (type) {
          case MessageType.UPDATE:
          case MessageType.SYNC_REQ:
          case MessageType.SYNC_RES:
            crdtSync.handleMessage(fromPeerId, type, data)
            break
          case MessageType.PRESENCE:
            presenceMgr.handleMessage(fromPeerId, data)
            break
        }
      },
      // Request full Yjs state once the DataChannel is open and ready.
      // Calling sendDC before dcReady would silently drop the message.
      onPeerConnected: (peerId) => crdtSync.requestFullState(peerId),
      onPeerRelayReady: (peerId) => crdtSync.requestFullState(peerId),
    })

    presenceMgr = new PresenceManager({
      peerId:    opts.peerId,
      doc,
      transport,
    })

    crdtSync = new CRDTSync({ doc, transport, roomKey: opts.roomKey })
    crdtSync.start()

    const room = new Room(doc, signaling, transport, crdtSync, presenceMgr)

    // Wire up peer lifecycle events.
    signaling
      .on('peerJoined', ({ peerId }) => {
        transport.addPeer(peerId, isInitiator(peerId))
        // SYNC_REQ is sent via onPeerConnected once DataChannel is open.
      })
      .on('peerLeft', ({ peerId }) => {
        transport.removePeer(peerId)
        presenceMgr.removePeer(peerId)
      })
      .on('relayNodes', ({ relayPeerIds }) => {
        transport.updateRelayPeerIds(relayPeerIds)
      })
      .on('disconnected', () => {
        room.setStatus('reconnecting')
      })
      .on('reconnect', ({ peers }) => {
        // After WS reconnect, PEER_LIST may contain peers that joined while
        // the connection was down. addPeer is idempotent — existing connections
        // are skipped; new ones are established.
        for (const peerId of peers) {
          transport.addPeer(peerId, true)
        }
        room.setStatus('connected')
      })
      .on('close', () => {
        // Intentional close (leave()) — already set in leave(), but guard here
        // in case signaling fires close before leave() updates _status.
        if (room._status !== 'closed') room.setStatus('closed')
      })

    // Connect to existing peers (initiator determined by lexicographic order).
    // SYNC_REQ will fire via onPeerConnected once each DataChannel opens.
    for (const existingPeerId of signaling.peers()) {
      transport.addPeer(existingPeerId, isInitiator(existingPeerId))
    }

    return room
  }

  /** Returns the shared Y.Doc instance. */
  getDoc(): Y.Doc {
    return this.doc
  }

  /** Broadcasts local presence state to all peers. */
  updatePresence(state: PresenceState): void {
    this.presence.updatePresence(state)
  }

  /** Registers a callback for presence changes. Returns unsubscribe function. */
  onPresence(cb: PresenceCallback): () => void {
    return this.presence.onPresence(cb)
  }

  /** Returns current presence snapshot. */
  getPresence(): ReadonlyMap<string, PresenceState> {
    return this.presence.getPresence()
  }

  /** Returns transport connection summary: total peer count and how many are P2P. */
  getConnectionSummary(): { total: number; p2p: number } {
    return this.transport.getConnectionSummary()
  }

  /**
   * Registers a callback for signaling connection status changes.
   * Returns an unsubscribe function.
   *
   * Spec:
   * - Immediately delivers the current status asynchronously (queueMicrotask)
   *   so callers registered after await Room.join() always receive a value.
   *   This is a BehaviorSubject-like pattern: subscribe → get current state.
   * - 'connected'    — signaling WS is up; fires on subscribe and after reconnect.
   * - 'reconnecting' — WS dropped unexpectedly; client is retrying.
   * - 'closed'       — leave() was called; no further events will fire.
   */
  onStatus(cb: StatusCallback): () => void {
    this.statusCallbacks.add(cb)
    // Deliver the current status asynchronously so the caller's synchronous
    // setup code after onStatus() completes before the callback fires.
    queueMicrotask(() => {
      if (this.statusCallbacks.has(cb)) cb(this._status)
    })
    return () => { this.statusCallbacks.delete(cb) }
  }

  /** Disconnects from the room, stops sync and presence. */
  leave(): void {
    // Set 'closed' before signaling.close() so that any 'close' event from
    // signaling does not race with setStatus — we want exactly one 'closed'.
    this.setStatus('closed')
    this.crdt.stop()
    // destroy() broadcasts a null awareness state ("peer left") to connected
    // peers. Must happen before transport.close() so the broadcast lands.
    this.presence.destroy()
    this.transport.close()
    this.signaling.close()
  }
}
