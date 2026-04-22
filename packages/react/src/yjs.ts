/**
 * yjs.ts — useYText / useYMap / useYArray hooks.
 *
 * Problem: Yjs types (Y.Text, Y.Map, Y.Array) are reference types whose
 * internal state mutates in place (insert, delete, update). Their object
 * identity is stable — React's default re-render mechanism (identity
 * comparison) would therefore miss these internal changes.
 *
 * Solution: subscribe to the Yjs `observe` event via React 18's
 * useSyncExternalStore and drive re-renders from a monotonically
 * incremented version counter. The hook returns the stable Y-type
 * reference; consumers may call `.toString()`, `.toJSON()`, `.insert()`,
 * `.delete()`, etc. on it as with vanilla Yjs. Every time the component
 * re-renders, those reads reflect the latest internal state.
 *
 * All three hooks share a private useYReactive helper.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import { useRoom } from './room.js'

/**
 * Internal: subscribes to a Yjs shared type's observe event, returns the
 * stable reference and triggers re-renders on every update.
 *
 * Spec:
 * - Returns null when no Room is available (outside Provider or connecting).
 * - Returns the Y-type reference obtained via getType(doc) when a Room exists.
 *   The reference is stable for a given (room, getType) pair: Y.Doc.getText
 *   / getMap / getArray are idempotent — calling them with the same name
 *   returns the same instance.
 * - Registers a listener on observe; increments an internal version counter
 *   on every event; triggers useSyncExternalStore re-check.
 * - Unregisters the listener when room changes or on unmount.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function useYReactive<T extends Y.AbstractType<any>>(
  getType: (doc: Y.Doc) => T,
): T | null {
  const room = useRoom()
  const yType = room ? getType(room.getDoc()) : null

  // Version counter drives useSyncExternalStore re-renders. Stored in a ref
  // so it persists across renders without triggering useState updates.
  const versionRef = useRef(0)

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!yType) return () => {}
      // Y.AbstractType.observe accepts a listener with (event, txn) args;
      // our callback discards them (we only need the "something changed"
      // signal).
      const listener = () => {
        versionRef.current++
        onChange()
      }
      yType.observe(listener)
      return () => yType.unobserve(listener)
    },
    [yType],
  )

  const getSnapshot = useCallback(() => versionRef.current, [])
  const getServerSnapshot = useCallback(() => 0, [])

  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  return yType
}

/**
 * useYText — reactive binding to a named Y.Text on the room's document.
 *
 * Spec:
 * - Returns the Y.Text instance for the given name, or null if no Room.
 * - Y.Doc.getText(name) is idempotent: first call creates the Y.Text,
 *   subsequent calls with the same name return the same reference.
 * - Component re-renders on every Y.Text mutation (insert, delete, format).
 *
 * @param name  Y.Doc key identifying the shared Y.Text.
 */
export function useYText(name: string): Y.Text | null {
  return useYReactive((doc) => doc.getText(name))
}

/**
 * useYMap — reactive binding to a named Y.Map on the room's document.
 *
 * Spec:
 * - Returns the Y.Map<V> instance for the given name, or null if no Room.
 * - Y.Doc.getMap(name) is idempotent.
 * - Component re-renders on every Y.Map mutation (set, delete, nested update).
 *
 * @param name  Y.Doc key identifying the shared Y.Map.
 *
 * @template V  Value type stored in the map. Consumers should narrow this
 *              to their application's data shape — Yjs does not validate
 *              runtime values.
 */
export function useYMap<V = unknown>(name: string): Y.Map<V> | null {
  return useYReactive((doc) => doc.getMap<V>(name))
}

/**
 * useYArray — reactive binding to a named Y.Array on the room's document.
 *
 * Spec:
 * - Returns the Y.Array<V> instance for the given name, or null if no Room.
 * - Y.Doc.getArray(name) is idempotent.
 * - Component re-renders on every Y.Array mutation (push, insert, delete).
 *
 * @param name  Y.Doc key identifying the shared Y.Array.
 *
 * @template V  Element type stored in the array. Consumers should narrow
 *              this to their application's data shape — Yjs does not
 *              validate runtime values.
 */
export function useYArray<V = unknown>(name: string): Y.Array<V> | null {
  return useYReactive((doc) => doc.getArray<V>(name))
}
