/**
 * provider.tsx — ZeroSyncProvider component managing Room lifecycle.
 *
 * Spec:
 * - Accepts all RoomOptions (except `persistence`, which is wrapped by this
 *   provider — see `persistKey` below) plus optional onError, persistKey, and
 *   children.
 * - On mount: optionally opens EncryptedPersistence (if persistKey is set),
 *   then calls Room.join(opts) asynchronously. Until resolved, the context
 *   value is { room: null, status: 'connecting' }.
 * - After Room.join resolves successfully:
 *     - stores the Room in context,
 *     - subscribes to room.onStatus to propagate connection state changes
 *       into the context's status value.
 * - If Room.join (or EncryptedPersistence.open) rejects:
 *     - context becomes { room: null, status: 'closed' },
 *     - the optional onError(error) callback is invoked with the rejection
 *       reason. The error is not re-thrown — React trees do not need to
 *       unmount on connection failure; consumers decide how to react.
 *     - any successfully-opened persistence is closed so the IDB connection
 *       does not leak.
 * - On unmount:
 *     - unsubscribes from onStatus,
 *     - calls room.leave() if the Room was successfully joined,
 *     - closes any opened EncryptedPersistence after leave() (so the final
 *       flush in CRDTSync.stop() lands before the connection is severed).
 *     - If unmount happens before Room.join resolves, late-arriving Room and
 *       persistence are still cleaned up (prevents leaked connections).
 * - Props are snapshotted at mount. Changes to roomId, peerId, persistKey or
 *   any other RoomOptions props after mount do NOT trigger rejoin. To switch
 *   rooms, remount the provider (e.g. via a `key` prop).
 *   Rationale: Room.join is expensive (WebSocket + WebRTC handshake). Making
 *   it reactive to prop changes invites thrash on incidental re-renders.
 * - Renders children unconditionally. Consumers can gate UI on the
 *   connection status via useConnectionStatus().
 * - onError is read via a ref so its identity can change across renders
 *   without retriggering the effect.
 *
 * persistKey:
 * - When provided, the provider opens an EncryptedPersistence keyed by
 *   `roomId` + `persistKey` and threads it through Room.join. This enables
 *   encrypted-at-rest storage of the Yjs doc — state survives page reloads.
 * - Use derivePersistKey(userSecret, roomId) to derive a domain-separated
 *   key. Never reuse the wire roomKey for at-rest encryption.
 * - Lifecycle is fully managed by the provider: open on mount, close on
 *   unmount. No external cleanup needed.
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  Room,
  RoomJoinError,
  EncryptedPersistence,
  type RoomOptions,
  type RoomStatus,
} from '@tovsa7/zerosync-client'
import { ZeroSyncContext, type ConnectionStatus, type RejectedReason } from './context.js'

/**
 * Props for ZeroSyncProvider. Mirrors RoomOptions but replaces the SDK's
 * `persistence: EncryptedPersistence` with `persistKey: CryptoKey` for a
 * declarative React UX — the provider owns the persistence lifecycle.
 */
export interface ZeroSyncProviderProps extends Omit<RoomOptions, 'persistence'> {
  children:    ReactNode
  onError?:    ((error: unknown) => void) | undefined
  /**
   * Optional AES-256-GCM key for at-rest persistence. When set, the provider
   * opens an EncryptedPersistence keyed by roomId + persistKey and passes it
   * to Room.join, enabling restore-on-reload.
   *
   * Derive via `derivePersistKey(userSecret, roomId)` from the SDK to keep
   * domain separation between wire roomKey and at-rest persistKey.
   */
  persistKey?: CryptoKey
}

export function ZeroSyncProvider(props: ZeroSyncProviderProps): ReactElement {
  const { children, onError, persistKey, ...roomOpts } = props

  const [room,           setRoom]           = useState<Room | null>(null)
  const [status,         setStatus]         = useState<ConnectionStatus>('connecting')
  const [rejectedReason, setRejectedReason] = useState<RejectedReason | null>(null)

  // onError may change identity across renders (e.g. inline lambda).
  // Read via ref to avoid retriggering the join effect on identity change.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Snapshot opts + persistKey at mount. Subsequent prop changes do NOT rejoin.
  const optsRef       = useRef(roomOpts)
  const persistKeyRef = useRef(persistKey)

  useEffect(() => {
    let cancelled                                     = false
    let persistence: EncryptedPersistence | null     = null
    let joinedRoom:  Room | null                     = null
    let unsubStatus: (() => void) | null             = null

    const opts = optsRef.current
    const key  = persistKeyRef.current

    ;(async () => {
      try {
        if (key) {
          persistence = await EncryptedPersistence.open({
            roomId: opts.roomId,
            key,
          })
          if (cancelled) {
            persistence.close()
            return
          }
        }

        const r = await Room.join({
          ...opts,
          persistence: persistence ?? undefined,
        })

        if (cancelled) {
          // Unmounted during join — clean up the orphan Room and persistence.
          r.leave()
          persistence?.close()
          return
        }

        joinedRoom = r
        setRoom(r)
        unsubStatus = r.onStatus((s: RoomStatus) => {
          if (!cancelled) setStatus(s)
        })
      } catch (err) {
        if (cancelled) return
        setRoom(null)
        // RoomJoinError carries the precise rejection cause from the SDK's
        // /health probe (capacity / unreachable / unknown). Other errors
        // (e.g. EncryptedPersistence.open failure) collapse to 'unknown'.
        setStatus('rejected')
        setRejectedReason(err instanceof RoomJoinError ? err.reason : 'unknown')
        onErrorRef.current?.(err)
        // If persistence opened but Room.join rejected, close it now.
        persistence?.close()
      }
    })()

    return () => {
      cancelled = true
      unsubStatus?.()
      // leave() flushes pending persistence saves (CRDTSync.stop). Close
      // the IDB connection AFTER leave() so the final flush completes first.
      joinedRoom?.leave()
      persistence?.close()
    }
  }, [])

  return (
    <ZeroSyncContext.Provider value={{ room, status, rejectedReason }}>
      {children}
    </ZeroSyncContext.Provider>
  )
}
