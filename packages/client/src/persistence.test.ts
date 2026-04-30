import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { EncryptedPersistence } from './persistence.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

const arbBytes = (min = 0, max = 256) =>
  fc.uint8Array({ minLength: min, maxLength: max })

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Reads the raw stored row directly via IndexedDB, bypassing
 * EncryptedPersistence — used to verify the row on disk is ciphertext.
 */
function readRawRow(roomId: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('zerosync-persistence-' + roomId, 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('state', 'readonly')
      const get = tx.objectStore('state').get('doc')
      get.onsuccess = () => { db.close(); resolve(get.result as Uint8Array | undefined) }
      get.onerror   = () => { db.close(); reject(get.error) }
    }
  })
}

/** Each test gets a unique roomId to avoid cross-test interference. */
let roomCounter = 0
function freshRoomId(): string {
  return `test-room-${++roomCounter}-${Date.now()}`
}

// fake-indexeddb persists across tests within the same module run.
// Reset the in-memory IDB between tests for hermeticity.
beforeEach(async () => {
  const { IDBFactory } = await import('fake-indexeddb')
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
})

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('EncryptedPersistence', () => {
  it('load() returns null when no row has been stored', async () => {
    const key = await makeKey()
    const p   = await EncryptedPersistence.open({ roomId: freshRoomId(), key })
    expect(await p.load()).toBeNull()
    p.close()
  })

  it('roundtrip: load(save(state)) === state', async () => {
    const key = await makeKey()
    const p   = await EncryptedPersistence.open({ roomId: freshRoomId(), key })
    const state = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    await p.save(state)
    const recovered = await p.load()
    expect(recovered).toEqual(state)
    p.close()
  })

  it('roundtrip: empty state', async () => {
    const key = await makeKey()
    const p   = await EncryptedPersistence.open({ roomId: freshRoomId(), key })
    const state = new Uint8Array(0)
    await p.save(state)
    const recovered = await p.load()
    expect(recovered).toEqual(state)
    p.close()
  })

  it('save() overwrites the previous value', async () => {
    const key = await makeKey()
    const p   = await EncryptedPersistence.open({ roomId: freshRoomId(), key })
    await p.save(new Uint8Array([1, 2, 3]))
    await p.save(new Uint8Array([9, 9, 9, 9]))
    expect(await p.load()).toEqual(new Uint8Array([9, 9, 9, 9]))
    p.close()
  })

  it('clear() removes the stored row', async () => {
    const key = await makeKey()
    const p   = await EncryptedPersistence.open({ roomId: freshRoomId(), key })
    await p.save(new Uint8Array([1, 2, 3]))
    await p.clear()
    expect(await p.load()).toBeNull()
    p.close()
  })

  it('persists across close + reopen', async () => {
    const key    = await makeKey()
    const roomId = freshRoomId()
    const p1 = await EncryptedPersistence.open({ roomId, key })
    await p1.save(new Uint8Array([42, 42, 42]))
    p1.close()

    const p2 = await EncryptedPersistence.open({ roomId, key })
    expect(await p2.load()).toEqual(new Uint8Array([42, 42, 42]))
    p2.close()
  })

  it('close() makes subsequent operations throw', async () => {
    const key = await makeKey()
    const p   = await EncryptedPersistence.open({ roomId: freshRoomId(), key })
    p.close()
    await expect(p.load()).rejects.toThrow(/closed/)
    await expect(p.save(new Uint8Array([1]))).rejects.toThrow(/closed/)
    await expect(p.clear()).rejects.toThrow(/closed/)
  })

  it('close() is idempotent', async () => {
    const key = await makeKey()
    const p   = await EncryptedPersistence.open({ roomId: freshRoomId(), key })
    p.close()
    expect(() => p.close()).not.toThrow()
  })

  // ── Crypto invariants ──────────────────────────────────────────────────────

  it('different rooms have isolated storage', async () => {
    const key = await makeKey()
    const r1  = freshRoomId()
    const r2  = freshRoomId()
    const p1 = await EncryptedPersistence.open({ roomId: r1, key })
    const p2 = await EncryptedPersistence.open({ roomId: r2, key })
    await p1.save(new Uint8Array([1, 2, 3]))
    expect(await p2.load()).toBeNull()
    p1.close()
    p2.close()
  })

  it('wrong key on load throws (AES-GCM auth failure)', async () => {
    const k1     = await makeKey()
    const k2     = await makeKey()
    const roomId = freshRoomId()

    const p1 = await EncryptedPersistence.open({ roomId, key: k1 })
    await p1.save(new Uint8Array([1, 2, 3]))
    p1.close()

    const p2 = await EncryptedPersistence.open({ roomId, key: k2 })
    await expect(p2.load()).rejects.toThrow()
    p2.close()
  })

  it('tampered ciphertext on disk causes load to throw', async () => {
    const key    = await makeKey()
    const roomId = freshRoomId()
    const p      = await EncryptedPersistence.open({ roomId, key })
    await p.save(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    p.close()

    // Mutate the on-disk row.
    const raw = await readRawRow(roomId)
    expect(raw).toBeInstanceOf(Uint8Array)
    const tampered = new Uint8Array(raw!)
    tampered[20] = (tampered[20] ?? 0) ^ 0xff
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('zerosync-persistence-' + roomId, 1)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('state', 'readwrite')
        tx.objectStore('state').put(tampered, 'doc')
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror    = () => { db.close(); reject(tx.error) }
      }
      req.onerror = () => reject(req.error)
    })

    const p2 = await EncryptedPersistence.open({ roomId, key })
    await expect(p2.load()).rejects.toThrow()
    p2.close()
  })

  it('on-disk row is ciphertext, not plaintext', async () => {
    const key      = await makeKey()
    const roomId   = freshRoomId()
    const plaintext = new Uint8Array([0x68, 0x69, 0x21]) // "hi!"
    const p = await EncryptedPersistence.open({ roomId, key })
    await p.save(plaintext)
    p.close()

    const raw = await readRawRow(roomId)
    expect(raw).toBeInstanceOf(Uint8Array)
    // Ciphertext format: IV (12) || ct+tag (N+16). For 3-byte plaintext: 12+3+16 = 31 bytes.
    expect(raw!.byteLength).toBe(12 + plaintext.length + 16)
    // Sanity: the plaintext bytes do NOT appear consecutively in the ciphertext.
    expect(bytesEqual(raw!.slice(12, 12 + plaintext.length), plaintext)).toBe(false)
  })
})

// ── Property-based tests ──────────────────────────────────────────────────────

describe('PBT: EncryptedPersistence', () => {
  it('∀ state: load(save(state)) === state', async () => {
    const key = await makeKey()
    await fc.assert(
      fc.asyncProperty(arbBytes(0, 512), async (state) => {
        const p = await EncryptedPersistence.open({ roomId: freshRoomId(), key })
        await p.save(state)
        const recovered = await p.load()
        expect(recovered).toEqual(state)
        p.close()
      }),
      { numRuns: 30 }, // numRuns kept modest — IDB ops are slower than pure crypto
    )
  })

  it('∀ state: two saves of same plaintext produce different ciphertext on disk (IV randomness)', async () => {
    const key = await makeKey()
    await fc.assert(
      fc.asyncProperty(arbBytes(1, 64), async (state) => {
        const r1 = freshRoomId()
        const r2 = freshRoomId()
        const p1 = await EncryptedPersistence.open({ roomId: r1, key })
        const p2 = await EncryptedPersistence.open({ roomId: r2, key })
        await p1.save(state)
        await p2.save(state)
        p1.close()
        p2.close()
        const ct1 = await readRawRow(r1)
        const ct2 = await readRawRow(r2)
        expect(bytesEqual(ct1!, ct2!)).toBe(false)
      }),
      { numRuns: 20 },
    )
  })
})
