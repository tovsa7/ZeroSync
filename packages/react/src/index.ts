/**
 * @tovsa7/zerosync-react — React hooks for ZeroSync.
 *
 * Provides declarative React integration for ZeroSync's E2E-encrypted
 * real-time collaboration SDK (@tovsa7/zerosync-client).
 *
 * Current API surface (v0.1.0):
 * - ZeroSyncProvider — Context provider managing Room lifecycle
 * - useRoom — access the Room instance (null while connecting)
 * - useConnectionStatus — reactive connection status
 * - usePresence — peer presence map
 * - useMyPresence — local presence state (useState-like + broadcast)
 * - useYText / useYMap / useYArray — reactive Yjs wrappers (re-render on update)
 */

export { ZeroSyncProvider }                      from './provider.js'
export type { ZeroSyncProviderProps }            from './provider.js'
export { ZeroSyncContext }                       from './context.js'
export type { ConnectionStatus, ZeroSyncContextValue } from './context.js'
export { useRoom, useConnectionStatus }          from './room.js'
export { usePresence, useMyPresence }            from './presence.js'
export { useYText, useYMap, useYArray }          from './yjs.js'
