/**
 * crypto.ts — ZeroSync client cryptography.
 *
 * Spec:
 * - encrypt(key, data): IV is 12 random bytes from crypto.getRandomValues,
 *   generated per call. Wire format: IV (12 bytes) || ciphertext+tag (N+16 bytes).
 *   Callers cannot provide IV. Throws if key is not AES-256-GCM CryptoKey.
 * - decrypt(key, data): wire[0:12] = IV, wire[12:] = ciphertext+tag.
 *   Throws early if data.length < 28 (12 IV + 16 min tag).
 *   Throws early if key is not AES-256-GCM CryptoKey.
 *   Throws on authentication failure (tampered / wrong key).
 *   Callers must catch and discard silently — oracle attack prevention.
 * - deriveRoomKey(userSecret, roomId): HKDF-SHA-256,
 *   info="zerosync-room:{roomId}", salt=empty, len=32.
 *   Key is non-extractable. Callers cannot provide raw key bytes.
 */

const AES_GCM = 'AES-GCM'
const IV_BYTES = 12
const MIN_CIPHERTEXT_BYTES = IV_BYTES + 16 // IV + AES-GCM tag

function assertAes256GcmKey(key: CryptoKey): void {
  const algo = key.algorithm as AesKeyAlgorithm
  if (algo.name !== AES_GCM || algo.length !== 256) {
    throw new TypeError(
      `Expected AES-256-GCM key, got ${algo.name}${algo.length != null ? `-${algo.length}` : ''}`
    )
  }
}

/**
 * Encrypts data using AES-256-GCM.
 *
 * Spec:
 * - IV is 12 random bytes from crypto.getRandomValues, generated per call.
 * - Wire format: IV (12 bytes) || ciphertext+tag (N+16 bytes).
 * - Callers cannot provide IV — it is always generated internally.
 * - Throws if key is not an AES-256-GCM CryptoKey.
 */
export async function encrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  assertAes256GcmKey(key)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt({ name: AES_GCM, iv }, key, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
  const result = new Uint8Array(IV_BYTES + ciphertext.byteLength)
  result.set(iv, 0)
  result.set(new Uint8Array(ciphertext), IV_BYTES)
  return result
}

/**
 * Decrypts AES-256-GCM ciphertext produced by encrypt().
 *
 * Spec:
 * - wire[0:12] = IV, wire[12:] = ciphertext+tag.
 * - Throws RangeError if data.length < 28.
 * - Throws TypeError if key is not AES-256-GCM.
 * - Throws DOMException on authentication failure (tampered / wrong key).
 * - Callers MUST catch and discard silently — never surface to UI.
 */
export async function decrypt(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  assertAes256GcmKey(key)
  if (data.length < MIN_CIPHERTEXT_BYTES) {
    throw new RangeError(
      `Ciphertext too short: ${data.length} < ${MIN_CIPHERTEXT_BYTES}`
    )
  }
  const iv = data.slice(0, IV_BYTES)
  const ciphertext = data.slice(IV_BYTES)
  const plaintext = await crypto.subtle.decrypt({ name: AES_GCM, iv }, key, ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer)
  return new Uint8Array(plaintext)
}

/**
 * Derives a non-extractable AES-256-GCM roomKey via HKDF-SHA-256.
 *
 * Spec:
 * - ikm  = userSecret (32 random bytes, stored in localStorage)
 * - salt = empty
 * - info = "zerosync-room:" + roomId
 * - len  = 32 bytes
 * - Key is non-extractable — never leaves client memory.
 */
export async function deriveRoomKey(
  userSecret: Uint8Array,
  roomId: string
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', userSecret.buffer.slice(userSecret.byteOffset, userSecret.byteOffset + userSecret.byteLength) as ArrayBuffer, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('zerosync-room:' + roomId),
    },
    ikm,
    { name: AES_GCM, length: 256 },
    false, // non-extractable — invariant: roomKey never leaves client memory
    ['encrypt', 'decrypt'],
  )
}
