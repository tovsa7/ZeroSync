/**
 * @zerosync/client — public API re-exports.
 */

export { Room, RoomJoinError } from './room.js'
export type {
  RoomOptions,
  RoomStatus,
  StatusCallback,
  RoomJoinRejectReason,
} from './room.js'

export { deriveRoomKey, derivePersistKey } from './crypto.js'

export { EncryptedPersistence } from './persistence.js'
export type { EncryptedPersistenceOptions } from './persistence.js'

export type { PresenceState, PresenceCallback } from './presence.js'

export { MessageType } from './transport.js'
