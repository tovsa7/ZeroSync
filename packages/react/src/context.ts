/**
 * context.ts — ZeroSync React Context definition.
 *
 * Spec:
 * - ZeroSyncContext carries the current Room + status through the React tree.
 * - Default value is { room: null, status: 'connecting' } — applies outside
 *   any ZeroSyncProvider (e.g. Storybook, tests rendering consumers directly)
 *   and during a ZeroSyncProvider's initial async Room.join() window.
 * - ConnectionStatus extends the client's RoomStatus ('connected' |
 *   'reconnecting' | 'closed') with an additional 'connecting' state that
 *   represents the pre-join window that exists only in React's component
 *   lifecycle (the client SDK does not expose this state — Room.join() is
 *   either pending or resolved).
 */

import { createContext } from 'react'
import type { Room, RoomStatus } from '@tovsa7/zerosync-client'

/**
 * ConnectionStatus — extends client's RoomStatus with React-lifecycle state.
 *
 * - 'connecting'   — ZeroSyncProvider mounted, Room.join() in flight
 * - 'connected'    — Room.join() resolved, signaling WS is up
 * - 'reconnecting' — signaling WS dropped unexpectedly, retrying
 * - 'closed'       — leave() called OR Room.join() rejected
 */
export type ConnectionStatus = 'connecting' | RoomStatus

/** Value carried by ZeroSyncContext. */
export interface ZeroSyncContextValue {
  readonly room:   Room | null
  readonly status: ConnectionStatus
}

/** React Context carrying the current Room + status. */
export const ZeroSyncContext = createContext<ZeroSyncContextValue>({
  room:   null,
  status: 'connecting',
})
