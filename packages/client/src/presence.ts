/**
 * presence.ts — ZeroSync awareness/presence via y-protocols.
 *
 * Spec:
 * - PresenceManager wraps a y-protocols Awareness instance tied to the Y.Doc.
 * - updatePresence(state) sets the local awareness state to { peerId, ...state },
 *   triggering the 'change' event with origin='local', which broadcasts a
 *   y-protocols binary awareness update via transport.broadcast(PRESENCE, bytes).
 *   Callers must NOT include 'peerId' in state — it is injected internally as a
 *   routing field so remote peers can map awareness clientID → peerId string.
 * - handleMessage(_fromPeerId, data) applies an incoming y-protocols binary awareness
 *   update via applyAwarenessUpdate with origin='remote'.
 *   - The 'change' event fires with origin='remote'; local state is NOT re-broadcast.
 *   - peerClientIds is updated: for each added/updated clientID, the 'peerId' field
 *     from the awareness state is stored in the clientID → peerId reverse map.
 *   - Invalid/malformed updates are discarded silently (invariant #4 spirit).
 * - removePeer(peerId) looks up the clientID from peerClientIds and calls
 *   removeAwarenessStates to evict the peer. No-op if peerId is unknown.
 *   Fires onPresence callbacks via the 'change' event handler.
 * - onPresence(cb) registers a callback fired on any awareness state change.
 *   Returns an unsubscribe function.
 * - getPresence() returns ReadonlyMap<string, PresenceState> of all remote peer
 *   states, keyed by peerId string. The internal 'peerId' routing field is stripped
 *   from the returned state values. The local peer is excluded.
 * - destroy() broadcasts a null "peer left" awareness update to all connected peers,
 *   then destroys the Awareness instance. Must be called BEFORE transport.close()
 *   to ensure the broadcast reaches peers. No onPresence callbacks fire after destroy().
 * - Decryption is handled by Transport; presence receives plaintext bytes.
 */

import * as Y from 'yjs'
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { Transport, MessageType } from './transport.js'

export type PresenceState = Record<string, unknown>

export type PresenceCallback = (peers: ReadonlyMap<string, PresenceState>) => void

export interface PresenceManagerOptions {
  peerId:    string
  doc:       Y.Doc
  transport: Transport
}

export class PresenceManager {
  private readonly peerId:       string
  private readonly transport:    Transport
  private readonly awareness:    Awareness
  private readonly callbacks     = new Set<PresenceCallback>()
  /** Maps peerId (UUID string) → awareness clientID (uint32) for remote peers. */
  private readonly peerClientIds = new Map<string, number>()
  private destroyed              = false

  constructor(opts: PresenceManagerOptions) {
    this.peerId    = opts.peerId
    this.transport = opts.transport
    this.awareness = new Awareness(opts.doc)

    this.awareness.on(
      'change',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        if (origin === 'local') {
          // Broadcast local state change to all peers as a binary awareness update.
          const update = encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])
          this.transport.broadcast(MessageType.PRESENCE, update)
        } else {
          // Update peerClientIds from newly added/updated remote states.
          const states = this.awareness.getStates()
          for (const clientID of [...added, ...updated]) {
            const state = states.get(clientID)
            if (state && typeof state['peerId'] === 'string') {
              this.peerClientIds.set(state['peerId'] as string, clientID)
            }
          }
          // Clean up evicted clients from the reverse map.
          for (const clientID of removed) {
            for (const [peerId, id] of this.peerClientIds) {
              if (id === clientID) {
                this.peerClientIds.delete(peerId)
                break
              }
            }
          }
        }
        // Suppress callbacks after destroy() to prevent stale notifications.
        if (!this.destroyed) this.notify()
      },
    )
  }

  /**
   * Updates local presence and broadcasts to all peers.
   * Do NOT include 'peerId' in state — it is injected internally.
   */
  updatePresence(state: PresenceState): void {
    // Inject peerId so remote peers can map awareness clientID → peerId string.
    this.awareness.setLocalState({ peerId: this.peerId, ...state })
  }

  /**
   * Applies an incoming y-protocols binary awareness update from transport.
   * Called by the room layer when transport.onMessage fires with type=PRESENCE.
   * _fromPeerId is kept for API compatibility; peerId is read from the state.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  handleMessage(_fromPeerId: string, data: Uint8Array): void {
    try {
      applyAwarenessUpdate(this.awareness, data, 'remote')
    } catch {
      // Invalid awareness update — discard silently (invariant #4 spirit).
    }
  }

  /**
   * Removes a peer's presence (called on PEER_LEFT from signaling).
   * Looks up the awareness clientID from peerClientIds; no-op if unknown.
   */
  removePeer(peerId: string): void {
    const clientID = this.peerClientIds.get(peerId)
    if (clientID === undefined) return
    // removeAwarenessStates triggers the 'change' event, which cleans
    // peerClientIds and fires onPresence callbacks.
    removeAwarenessStates(this.awareness, [clientID], 'remote')
  }

  /** Registers a callback for presence changes. Returns an unsubscribe function. */
  onPresence(cb: PresenceCallback): () => void {
    this.callbacks.add(cb)
    return () => { this.callbacks.delete(cb) }
  }

  /**
   * Returns a snapshot of remote peer presence states keyed by peerId.
   * The internal 'peerId' routing field is stripped from state values.
   * The local peer is excluded.
   */
  getPresence(): ReadonlyMap<string, PresenceState> {
    const result = new Map<string, PresenceState>()
    for (const [clientID, state] of this.awareness.getStates()) {
      if (clientID === this.awareness.clientID) continue  // skip local
      if (!state || typeof state['peerId'] !== 'string') continue
      const peerIdStr: string = state['peerId'] as string
      // Strip the internal routing field before exposing state to callers.
      const { peerId: _routing, ...publicState } = state as Record<string, unknown> & { peerId: string }
      result.set(peerIdStr, publicState)
    }
    return result
  }

  /**
   * Broadcasts a null "peer left" awareness update to connected peers, then
   * destroys the Awareness instance. Call before transport.close().
   */
  destroy(): void {
    this.destroyed = true
    // awareness.destroy() calls setLocalState(null) → fires 'change' with
    // origin='local' → our handler broadcasts the null state to peers.
    this.awareness.destroy()
  }

  private notify(): void {
    const snapshot = this.getPresence()
    for (const cb of this.callbacks) cb(snapshot)
  }
}
