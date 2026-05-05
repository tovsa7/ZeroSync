/**
 * crdt.ts — ZeroSync Yjs CRDT integration with encrypt-before-send.
 *
 * Spec:
 * - CRDTSync binds a Y.Doc to a Transport, encrypting all outgoing updates.
 * - Local Y.Doc updates are encrypted and broadcast as UPDATE (0x01) messages.
 * - Incoming UPDATE messages are decrypted and applied to the local Y.Doc.
 * - SYNC_REQ (0x03): requests full Yjs state from a specific peer.
 * - SYNC_RES (0x04): responds with encrypted full Yjs state (Y.encodeStateAsUpdate).
 * - Only updates originating locally (origin !== REMOTE_ORIGIN, RESTORE_ORIGIN)
 *   are broadcast to peers.
 * - Decryption failures are discarded silently (invariant #4).
 * - start() subscribes to doc updates and, if persistence is configured,
 *   restores the encrypted state from IndexedDB before resolving. Returns a
 *   Promise so callers (Room.join) can await initial state load.
 * - stop() unsubscribes, removes visibility listeners, and flushes any
 *   pending persistence write.
 *
 * Persistence (optional):
 * - On start(): persistence.load() → if present, applyUpdate with origin
 *   RESTORE_ORIGIN. Restore-origin updates are NOT re-broadcast and do NOT
 *   re-trigger a save (the bytes came from disk — saving them back is moot).
 *   Failures are logged and ignored — sync continues with empty/peer state.
 * - Every doc update (local OR remote) schedules a debounced save (default
 *   500 ms). The full state (Y.encodeStateAsUpdate) is encoded at flush time,
 *   not at schedule time, so coalesced edits get a single write of the
 *   merged state.
 * - visibilitychange to 'hidden' and pagehide flush pending saves immediately
 *   to survive tab close / BFCache eviction.
 * - stop() flushes pending saves and detaches listeners.
 */

import * as Y from 'yjs'
import { Transport, MessageType } from './transport.js'
import type { EncryptedPersistence } from './persistence.js'

const REMOTE_ORIGIN  = 'remote'
const RESTORE_ORIGIN = 'persistence-restore'

const SAVE_DEBOUNCE_MS = 500

export interface CRDTSyncOptions {
  doc:       Y.Doc
  transport: Transport
  roomKey:   CryptoKey
  /**
   * Optional encrypted-at-rest persistence. When provided:
   * - start() awaits persistence.load() and applies any stored state.
   * - Doc updates (local + remote) trigger debounced save.
   * - stop() flushes any pending save.
   * Caller owns lifecycle: SDK does NOT call persistence.close().
   */
  persistence?: EncryptedPersistence | undefined
  /** Save debounce window, in ms. Default 500. */
  saveDebounceMs?: number | undefined
}

export class CRDTSync {
  private readonly doc:            Y.Doc
  private readonly transport:      Transport
  private readonly roomKey:        CryptoKey
  private readonly persistence:    EncryptedPersistence | null
  private readonly saveDebounceMs: number
  private started      = false
  private saveTimer:   ReturnType<typeof setTimeout> | null = null
  private savePending  = false

  // Bound listener references, kept so removeEventListener removes the same
  // function objects that addEventListener registered.
  private readonly onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      void this.flushSave()
    }
  }
  private readonly onPageHide = (): void => { void this.flushSave() }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // RESTORE_ORIGIN: bytes just came from persistence. Don't broadcast (peers
    // will SYNC_RES anyway) and don't re-save (the bytes are already on disk).
    if (origin === RESTORE_ORIGIN) return
    // Save on every state change, including remote merges, so at-rest data
    // tracks the merged doc, not just local edits.
    this.scheduleSave()
    if (origin === REMOTE_ORIGIN) return
    this.transport.broadcast(MessageType.UPDATE, update)
  }

  constructor(opts: CRDTSyncOptions) {
    this.doc            = opts.doc
    this.transport      = opts.transport
    this.roomKey        = opts.roomKey
    this.persistence    = opts.persistence ?? null
    this.saveDebounceMs = opts.saveDebounceMs ?? SAVE_DEBOUNCE_MS
  }

  /**
   * Subscribes to doc updates and, if persistence is configured, restores
   * any stored state before resolving.
   *
   * Spec:
   * - Idempotent — calling twice is a no-op after the first.
   * - When persistence is set: awaits load(), applies via Y.applyUpdate with
   *   origin RESTORE_ORIGIN. Load failures are logged and swallowed so a
   *   corrupted local row does not block sync — peers will still be able to
   *   SYNC_RES, and the next save() overwrites the bad row.
   * - Visibility/pagehide listeners are attached only when persistence is
   *   set AND a DOM is present (skipped in node, web workers, SSR).
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.doc.on('update', this.onDocUpdate)

    if (this.persistence && typeof document !== 'undefined' && typeof window !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange)
      window.addEventListener('pagehide', this.onPageHide)
    }

    if (this.persistence) {
      try {
        const stored = await this.persistence.load()
        if (stored && this.started) {
          Y.applyUpdate(this.doc, stored, RESTORE_ORIGIN)
        }
      } catch (err) {
        // Tampered / wrong-key / corrupted row. Don't block sync.
        // info-level: the fresh-start fallback is the expected, correct behavior.
        console.info('[zerosync] persistence.load() failed, starting fresh:', err)
      }
    }
  }

  /**
   * Unsubscribes from doc updates, detaches visibility listeners, and
   * flushes any pending persistence save. Idempotent.
   */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.doc.off('update', this.onDocUpdate)

    if (this.persistence && typeof document !== 'undefined' && typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
      window.removeEventListener('pagehide', this.onPageHide)
    }

    void this.flushSave()
  }

  /**
   * Handles an incoming transport message.
   * Called by the room layer when transport.onMessage fires.
   *
   * Spec:
   * - UPDATE (0x01): apply decrypted bytes to doc with origin=REMOTE_ORIGIN.
   * - SYNC_REQ (0x03): respond with full state via send.
   * - SYNC_RES (0x04): apply decrypted full state with origin=REMOTE_ORIGIN.
   * - REMOTE_ORIGIN-applied updates trigger onDocUpdate, which schedules a
   *   persistence save (if configured) so at-rest state tracks merged doc.
   */
  handleMessage(fromPeerId: string, type: MessageType, data: Uint8Array): void {
    switch (type) {
      case MessageType.UPDATE:
        Y.applyUpdate(this.doc, data, REMOTE_ORIGIN)
        break
      case MessageType.SYNC_REQ:
        this.sendFullState(fromPeerId)
        break
      case MessageType.SYNC_RES:
        Y.applyUpdate(this.doc, data, REMOTE_ORIGIN)
        break
    }
  }

  /** Sends a SYNC_REQ to a specific peer to request full state. */
  requestFullState(peerId: string): void {
    this.transport.send(peerId, MessageType.SYNC_REQ, new Uint8Array(0))
  }

  private sendFullState(toPeerId: string): void {
    const state = Y.encodeStateAsUpdate(this.doc)
    this.transport.send(toPeerId, MessageType.SYNC_RES, state)
  }

  // ── Persistence write coordination ──────────────────────────────────────────

  private scheduleSave(): void {
    if (!this.persistence) return
    this.savePending = true
    if (this.saveTimer != null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flushSave()
    }, this.saveDebounceMs)
  }

  private async flushSave(): Promise<void> {
    if (!this.persistence) return
    if (this.saveTimer != null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.savePending) return
    this.savePending = false
    // Encode state at flush time, not at schedule time — so debounced writes
    // capture the merged state of all coalesced updates in a single write.
    const state = Y.encodeStateAsUpdate(this.doc)
    try {
      await this.persistence.save(state)
    } catch (err) {
      console.warn('[zerosync] persistence.save() failed:', err)
    }
  }
}
