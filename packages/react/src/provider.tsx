/**
 * provider.tsx — ZeroSyncProvider component managing Room lifecycle.
 *
 * Spec:
 * - Accepts all RoomOptions as props (serverUrl, roomId, roomKey, peerId,
 *   nonce, hmac, iceServers) plus optional onError callback and children.
 * - On mount: calls Room.join(opts) asynchronously. Until resolved, the
 *   context value is { room: null, status: 'connecting' }.
 * - After Room.join resolves successfully:
 *     - stores the Room in context,
 *     - subscribes to room.onStatus to propagate connection state changes
 *       into the context's status value.
 * - If Room.join rejects:
 *     - context becomes { room: null, status: 'closed' },
 *     - the optional onError(error) callback is invoked with the rejection
 *       reason. The error is not re-thrown — React trees do not need to
 *       unmount on connection failure; consumers decide how to react.
 * - On unmount:
 *     - unsubscribes from onStatus,
 *     - calls room.leave() if the Room was successfully joined.
 *     - If unmount happens before Room.join resolves, the late-arriving
 *       Room still has leave() called (prevents leaked connections).
 * - Props are snapshotted at mount. Changes to roomId, peerId, or any other
 *   RoomOptions props after mount do NOT trigger rejoin. To switch rooms,
 *   remount the provider (e.g. via a `key` prop).
 *   Rationale: Room.join is expensive (WebSocket + WebRTC handshake). Making
 *   it reactive to prop changes invites thrash on incidental re-renders.
 * - Renders children unconditionally. Consumers can gate UI on the
 *   connection status via useConnectionStatus().
 * - onError is read via a ref so its identity can change across renders
 *   without retriggering the effect.
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Room, type RoomOptions, type RoomStatus } from '@tovsa7/zerosync-client'
import { ZeroSyncContext, type ConnectionStatus } from './context.js'

export interface ZeroSyncProviderProps extends RoomOptions {
  children:  ReactNode
  onError?: ((error: unknown) => void) | undefined
}

export function ZeroSyncProvider(props: ZeroSyncProviderProps): ReactElement {
  const { children, onError, ...roomOpts } = props

  const [room,   setRoom]   = useState<Room | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')

  // onError may change identity across renders (e.g. inline lambda).
  // Read via ref to avoid retriggering the join effect on identity change.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Snapshot roomOpts at mount. Subsequent prop changes do NOT rejoin.
  const optsRef = useRef(roomOpts)

  useEffect(() => {
    let cancelled                                    = false
    let joinedRoom:  Room | null                     = null
    let unsubStatus: (() => void) | null             = null

    Room.join(optsRef.current)
      .then((r) => {
        if (cancelled) {
          // Unmounted before join resolved — tear down the orphan Room.
          r.leave()
          return
        }
        joinedRoom = r
        setRoom(r)
        unsubStatus = r.onStatus((s: RoomStatus) => {
          if (!cancelled) setStatus(s)
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRoom(null)
        setStatus('closed')
        onErrorRef.current?.(err)
      })

    return () => {
      cancelled = true
      unsubStatus?.()
      joinedRoom?.leave()
    }
  }, [])

  return (
    <ZeroSyncContext.Provider value={{ room, status }}>
      {children}
    </ZeroSyncContext.Provider>
  )
}
