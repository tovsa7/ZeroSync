/**
 * @tovsa7/zerosync-react — React hooks for ZeroSync.
 *
 * Provides declarative React integration for ZeroSync's E2E-encrypted
 * real-time collaboration SDK (@tovsa7/zerosync-client).
 *
 * Current API surface (v0.2.0):
 * - ZeroSyncProvider — Context provider managing Room lifecycle (and
 *   optional EncryptedPersistence lifecycle when persistKey is set)
 * - useRoom — access the Room instance (null while connecting)
 * - useConnectionStatus — reactive connection status
 * - usePresence — peer presence map
 * - useMyPresence — local presence state (useState-like + broadcast)
 * - useYText / useYMap / useYArray — reactive Yjs wrappers (re-render on update)
 * - derivePersistKey — helper re-exported from the client SDK so consumers
 *   only need to import from one package
 */

export { ZeroSyncProvider }                                     from './provider.js'
export type { ZeroSyncProviderProps }                           from './provider.js'
export { ZeroSyncContext }                                      from './context.js'
export type { ConnectionStatus, RejectedReason, ZeroSyncContextValue } from './context.js'
export { useRoom, useConnectionStatus, useRejectedReason }      from './room.js'
export { usePresence, useMyPresence }                           from './presence.js'
export { useYText, useYMap, useYArray }                         from './yjs.js'

// Re-export crypto helper so consumers can derive persistKey without taking
// an additional dependency on @tovsa7/zerosync-client directly.
export { derivePersistKey }                      from '@tovsa7/zerosync-client'
