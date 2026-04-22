/**
 * presence.ts — usePresence + useMyPresence hooks.
 *
 * Wraps the Room's presence API (room.getPresence / room.onPresence /
 * room.updatePresence) in idiomatic React hooks.
 *
 * - usePresence subscribes to onPresence and returns a ReadonlyMap snapshot
 *   that re-renders on every awareness change.
 * - useMyPresence mirrors React's useState — [state, setState] — where
 *   setState additionally broadcasts via room.updatePresence.
 *
 * Both hooks accept a generic type parameter so consumers can narrow the
 * Record<string, unknown> default to their application's presence shape.
 */

import { useCallback, useEffect, useState } from 'react'
import type { PresenceState } from '@tovsa7/zerosync-client'
import { useRoom } from './room.js'

/**
 * usePresence — returns the current peer presence map.
 *
 * Spec:
 * - Returns ReadonlyMap<peerId, T> of all remote peers.
 *   (Local peer is excluded by the SDK — see presence.ts getPresence docs.)
 * - Returns an empty Map when outside a ZeroSyncProvider or while the
 *   Room is still joining (room === null).
 * - Subscribes to room.onPresence on first mount and on every room change;
 *   unsubscribes on unmount or when the Room changes.
 * - Initial value after room becomes available is room.getPresence() (a
 *   snapshot of state already collected by the SDK before this hook mounted).
 * - Triggers a re-render on every awareness change (peer join, peer leave,
 *   peer state update).
 *
 * The type parameter T lets consumers narrow the default
 * Record<string, unknown> to their application's presence shape. The cast
 * is trusted — the SDK does not validate the runtime shape.
 */
export function usePresence<T extends PresenceState = PresenceState>(): ReadonlyMap<string, T> {
  const room = useRoom()
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, PresenceState>>(new Map())

  useEffect(() => {
    if (!room) {
      setSnapshot(new Map())
      return
    }
    // Seed with whatever the SDK has already collected.
    setSnapshot(room.getPresence())
    // Subscribe to subsequent changes.
    return room.onPresence((peers) => {
      setSnapshot(peers)
    })
  }, [room])

  return snapshot as ReadonlyMap<string, T>
}

/**
 * useMyPresence — [state, setState] tuple; setState broadcasts to peers.
 *
 * Spec:
 * - Returns a two-element tuple [state, setState] similar to React.useState.
 * - state: the last value passed to setState, or null if setState has never
 *   been called in this mount.
 * - setState(value):
 *     - Updates local state synchronously (causes re-render).
 *     - Calls room.updatePresence(value) if a Room is currently joined.
 *     - If room is null (connecting or closed), the broadcast is skipped.
 *       The local state still updates — but there is NO automatic replay
 *       when the Room later becomes available. Consumers wanting "publish
 *       on connect" should call setState again inside a useEffect that
 *       depends on useConnectionStatus() === 'connected'.
 * - setState has a stable identity across renders for a given Room instance.
 *   When the Room changes, setState's identity changes (so dep arrays using
 *   it will re-run after reconnect/rejoin).
 * - Semantics are full-replace, matching the SDK: the value passed to
 *   setState wholly replaces the local peer's presence state. For partial
 *   updates, spread the previous state: setMyPresence({ ...prev, cursor: 10 }).
 * - Consumers MUST NOT include 'peerId' in the state — it is injected by
 *   the SDK internally as a routing field (see client presence.ts spec).
 */
export function useMyPresence<T extends PresenceState = PresenceState>(): [T | null, (state: T) => void] {
  const room = useRoom()
  const [state, setLocalState] = useState<T | null>(null)

  const setState = useCallback(
    (value: T) => {
      setLocalState(value)
      if (room) {
        room.updatePresence(value)
      }
    },
    [room],
  )

  return [state, setState]
}
