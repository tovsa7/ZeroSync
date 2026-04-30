import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { encrypt, decrypt, deriveRoomKey, derivePersistKey } from './crypto.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const arbBytes = (min = 0, max = 256) =>
  fc.uint8Array({ minLength: min, maxLength: max })

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('encrypt / decrypt', () => {
  it('roundtrip: decrypt(encrypt(plaintext)) === plaintext', async () => {
    const key = await makeKey()
    const plaintext = new Uint8Array([1, 2, 3, 4, 5])
    const ciphertext = await encrypt(key, plaintext)
    const recovered = await decrypt(key, ciphertext)
    expect(recovered).toEqual(plaintext)
  })

  it('roundtrip: empty plaintext', async () => {
    const key = await makeKey()
    const plaintext = new Uint8Array(0)
    const ciphertext = await encrypt(key, plaintext)
    const recovered = await decrypt(key, ciphertext)
    expect(recovered).toEqual(plaintext)
  })

  it('wire format: len(encrypt(N)) === 12 + N + 16', async () => {
    const key = await makeKey()
    const N = 100
    const ciphertext = await encrypt(key, new Uint8Array(N))
    expect(ciphertext.byteLength).toBe(12 + N + 16)
  })

  it('tamper detection: flipping any bit causes decrypt to throw', async () => {
    const key = await makeKey()
    const plaintext = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const ciphertext = new Uint8Array(await encrypt(key, plaintext))
    // Flip a byte in the ciphertext+tag region (after the 12-byte IV).
    const idx = 20
    ciphertext[idx] = (ciphertext[idx] ?? 0) ^ 0xff
    await expect(decrypt(key, ciphertext)).rejects.toThrow()
  })

  it('IV uniqueness: two encryptions of same plaintext differ', async () => {
    const key = await makeKey()
    const plaintext = new Uint8Array([1, 2, 3])
    const c1 = await encrypt(key, plaintext)
    const c2 = await encrypt(key, plaintext)
    expect(bytesEqual(c1, c2)).toBe(false)
  })

  it('callers cannot provide IV — encrypt takes only key + data', async () => {
    // Verified structurally: encrypt(key, data) has exactly 2 parameters.
    expect(encrypt.length).toBe(2)
  })

  it('throws if key is wrong algorithm', async () => {
    const hmacKey = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    )
    await expect(encrypt(hmacKey as unknown as CryptoKey, new Uint8Array([1]))).rejects.toThrow()
  })

  it('throws if key is AES-128 (not AES-256)', async () => {
    const aes128 = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']
    )
    await expect(encrypt(aes128, new Uint8Array([1]))).rejects.toThrow()
  })

  // ── decrypt input validation ──────────────────────────────────────────────

  it('decrypt: throws immediately if data is shorter than 28 bytes', async () => {
    const key = await makeKey()
    // 27 = 12 (IV) + 15 (less than minimum 16-byte tag)
    await expect(decrypt(key, new Uint8Array(27))).rejects.toThrow()
  })

  it('decrypt: throws immediately on empty input', async () => {
    const key = await makeKey()
    await expect(decrypt(key, new Uint8Array(0))).rejects.toThrow()
  })

  it('decrypt: throws if key algorithm is not AES-GCM', async () => {
    const hmacKey = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    )
    const ct = new Uint8Array(12 + 16)
    await expect(decrypt(hmacKey as unknown as CryptoKey, ct)).rejects.toThrow()
  })

  it('decrypt: throws if key is AES-128 (not AES-256)', async () => {
    const aes128 = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']
    )
    const ct = new Uint8Array(12 + 16)
    await expect(decrypt(aes128, ct)).rejects.toThrow()
  })
})

// ── Property-based tests ──────────────────────────────────────────────────────

describe('PBT: encrypt / decrypt', () => {
  it('∀ plaintext: decrypt(encrypt(plaintext)) == plaintext', async () => {
    const key = await makeKey()
    await fc.assert(
      fc.asyncProperty(arbBytes(), async (plaintext) => {
        const ciphertext = await encrypt(key, plaintext)
        const recovered = await decrypt(key, ciphertext)
        expect(recovered).toEqual(plaintext)
      }),
      { numRuns: 100 }
    )
  })

  it('∀ plaintext of length N: len(encrypt(N)) == 12 + N + 16', async () => {
    const key = await makeKey()
    await fc.assert(
      fc.asyncProperty(arbBytes(), async (plaintext) => {
        const ciphertext = await encrypt(key, plaintext)
        expect(ciphertext.byteLength).toBe(12 + plaintext.length + 16)
      }),
      { numRuns: 100 }
    )
  })

  it('∀ plaintext: two encryptions produce different ciphertext (IV randomness)', async () => {
    const key = await makeKey()
    await fc.assert(
      fc.asyncProperty(arbBytes(1), async (plaintext) => {
        const c1 = await encrypt(key, plaintext)
        const c2 = await encrypt(key, plaintext)
        expect(bytesEqual(c1, c2)).toBe(false)
      }),
      { numRuns: 100 }
    )
  })

  it('∀ ciphertext: flip any bit → decrypt rejects', async () => {
    const key = await makeKey()
    await fc.assert(
      fc.asyncProperty(
        arbBytes(1, 64),
        fc.integer({ min: 0, max: 7 }),
        async (plaintext, bitOffset) => {
          const ct = new Uint8Array(await encrypt(key, plaintext))
          // Flip a byte in the ciphertext+tag region (after the 12-byte IV).
          const byteIndex = 12 + (bitOffset % (ct.length - 12))
          ct[byteIndex] = (ct[byteIndex] ?? 0) ^ 0x01
          await expect(decrypt(key, ct)).rejects.toThrow()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ── deriveRoomKey ─────────────────────────────────────────────────────────────

describe('deriveRoomKey', () => {
  it('returns a CryptoKey usable for encrypt/decrypt', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const roomId = 'test-room-1'
    const key = await deriveRoomKey(secret, roomId)
    const plaintext = new Uint8Array([1, 2, 3])
    const ciphertext = await encrypt(key, plaintext)
    const recovered = await decrypt(key, ciphertext)
    expect(recovered).toEqual(plaintext)
  })

  it('same inputs produce keys that decrypt each other output', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const roomId = 'room-abc'
    const key1 = await deriveRoomKey(secret, roomId)
    const key2 = await deriveRoomKey(secret, roomId)
    const ciphertext = await encrypt(key1, new Uint8Array([9, 8, 7]))
    const recovered = await decrypt(key2, ciphertext)
    expect(recovered).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('different roomId produces different key material (cross-decrypt fails)', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const key1 = await deriveRoomKey(secret, 'room-A')
    const key2 = await deriveRoomKey(secret, 'room-B')
    const ciphertext = await encrypt(key1, new Uint8Array([1, 2, 3]))
    await expect(decrypt(key2, ciphertext)).rejects.toThrow()
  })

  it('key is not extractable (roomKey never leaves client memory)', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const key = await deriveRoomKey(secret, 'room-x')
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })
})

// ── derivePersistKey ──────────────────────────────────────────────────────────

describe('derivePersistKey', () => {
  it('returns a CryptoKey usable for encrypt/decrypt', async () => {
    const secret    = crypto.getRandomValues(new Uint8Array(32))
    const key       = await derivePersistKey(secret, 'test-room-1')
    const plaintext = new Uint8Array([1, 2, 3])
    const ct        = await encrypt(key, plaintext)
    expect(await decrypt(key, ct)).toEqual(plaintext)
  })

  it('same inputs produce interchangeable keys', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const k1     = await derivePersistKey(secret, 'room-abc')
    const k2     = await derivePersistKey(secret, 'room-abc')
    const ct     = await encrypt(k1, new Uint8Array([9, 8, 7]))
    expect(await decrypt(k2, ct)).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('different roomId produces different key material', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const k1     = await derivePersistKey(secret, 'room-A')
    const k2     = await derivePersistKey(secret, 'room-B')
    const ct     = await encrypt(k1, new Uint8Array([1, 2, 3]))
    await expect(decrypt(k2, ct)).rejects.toThrow()
  })

  it('persistKey is non-extractable', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const key    = await derivePersistKey(secret, 'room-x')
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  // ── Domain separation between roomKey and persistKey ──────────────────────

  it('roomKey and persistKey are domain-separated for the same secret + roomId', async () => {
    const secret     = crypto.getRandomValues(new Uint8Array(32))
    const roomId     = 'room-shared'
    const roomKey    = await deriveRoomKey(secret, roomId)
    const persistKey = await derivePersistKey(secret, roomId)
    const ct         = await encrypt(roomKey, new Uint8Array([1, 2, 3]))
    // Cross-decrypt MUST fail — proves the keys are independent.
    await expect(decrypt(persistKey, ct)).rejects.toThrow()
  })

  it('domain separation: ciphertext encrypted with persistKey is opaque to roomKey', async () => {
    const secret     = crypto.getRandomValues(new Uint8Array(32))
    const roomId     = 'room-shared'
    const roomKey    = await deriveRoomKey(secret, roomId)
    const persistKey = await derivePersistKey(secret, roomId)
    const ct         = await encrypt(persistKey, new Uint8Array([4, 5, 6]))
    await expect(decrypt(roomKey, ct)).rejects.toThrow()
  })
})
