/**
 * room.ts — useRoom + useConnectionStatus hooks.
 *
 * Thin wrappers over ZeroSyncContext. Re-rendering is handled automatically
 * by React's Context subscription mechanism — when ZeroSyncProvider updates
 * its context value (on Room.join resolution or status change), every
 * component calling these hooks re-renders with the new value.
 */

import { useContext } from 'react'
import type { Room } from '@tovsa7/zerosync-client'
import { ZeroSyncContext, type ConnectionStatus } from './context.js'

/**
 * Returns the currently-joined Room, or null while the Provider's
 * Room.join() is in flight or if it rejected.
 *
 * Spec:
 * - Returns null outside any ZeroSyncProvider (default context value).
 * - Returns null while Room.join is pending (status === 'connecting').
 * - Returns null if Room.join rejected (status === 'closed', room stays null).
 * - Returns the Room instance once Room.join resolves successfully.
 * - Component re-renders on transition null → Room and vice versa.
 *
 * Consumers typically use `useConnectionStatus` to gate UI on 'connected'
 * before reading Room methods, but null-guarding the return value is also
 * valid.
 */
export function useRoom(): Room | null {
  return useContext(ZeroSyncContext).room
}

/**
 * Returns the current connection status.
 *
 * Spec:
 * - 'connecting' — Provider mounted, Room.join() in flight (default state).
 * - 'connected'  — Room.join resolved, signaling WebSocket is up.
 * - 'reconnecting' — signaling WebSocket dropped unexpectedly, client retrying.
 * - 'closed'     — Provider unmounted OR Room.join rejected.
 * - Returns 'connecting' outside any ZeroSyncProvider (default context value).
 * - Component re-renders on every status transition.
 */
export function useConnectionStatus(): ConnectionStatus {
  return useContext(ZeroSyncContext).status
}
