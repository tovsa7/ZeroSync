/**
 * context.ts — ZeroSync React Context definition.
 *
 * Spec:
 * - ZeroSyncContext carries the current Room + status + rejectedReason through
 *   the React tree.
 * - Default value is { room: null, status: 'connecting', rejectedReason: null }
 *   — applies outside any ZeroSyncProvider (e.g. Storybook, tests rendering
 *   consumers directly) and during a ZeroSyncProvider's initial async
 *   Room.join() window.
 * - ConnectionStatus extends the client's RoomStatus ('connected' |
 *   'reconnecting' | 'closed') with two React-lifecycle states:
 *     - 'connecting' — pre-join window (Room.join in flight). Not exposed by
 *       the client SDK because Room.join() is either pending or resolved.
 *     - 'rejected'   — Room.join() rejected. The client SDK throws (it does
 *       not expose this as a status), but in the declarative React API a
 *       rejected join is a long-lived state that consumers gate UI on.
 * - When status is 'rejected', `rejectedReason` carries the diagnostic from
 *   RoomJoinError when available, or 'unknown' for non-signaling failures
 *   (e.g. EncryptedPersistence.open() failed).
 */

import { createContext } from 'react'
import type { Room, RoomStatus, RoomJoinRejectReason } from '@tovsa7/zerosync-client'

/**
 * ConnectionStatus — extends client's RoomStatus with React-lifecycle states.
 *
 * - 'connecting'   — ZeroSyncProvider mounted, Room.join() in flight
 * - 'connected'    — Room.join() resolved, signaling WS is up
 * - 'reconnecting' — signaling WS dropped unexpectedly, retrying
 * - 'closed'       — leave() called (Provider unmounted)
 * - 'rejected'     — Room.join() rejected; see `rejectedReason` for cause
 */
export type ConnectionStatus = 'connecting' | 'rejected' | RoomStatus

/**
 * Reason for a 'rejected' connection state. Mirrors the client SDK's
 * RoomJoinRejectReason; null when status is not 'rejected'.
 */
export type RejectedReason = RoomJoinRejectReason

/** Value carried by ZeroSyncContext. */
export interface ZeroSyncContextValue {
  readonly room:           Room | null
  readonly status:         ConnectionStatus
  readonly rejectedReason: RejectedReason | null
}

/** React Context carrying the current Room + status + rejectedReason. */
export const ZeroSyncContext = createContext<ZeroSyncContextValue>({
  room:           null,
  status:         'connecting',
  rejectedReason: null,
})
