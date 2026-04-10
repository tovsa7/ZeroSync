/**
 * @zerosync/client — public API re-exports.
 */

export { Room } from './room.js'
export type { RoomOptions, RoomStatus, StatusCallback } from './room.js'

export { deriveRoomKey } from './crypto.js'

export type { PresenceState, PresenceCallback } from './presence.js'

export { MessageType } from './transport.js'
