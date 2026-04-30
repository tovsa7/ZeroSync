/**
 * persistence.ts — encrypted-at-rest IndexedDB storage for ZeroSync rooms.
 *
 * Spec:
 * - EncryptedPersistence.open({ roomId, key }) opens (or creates) a per-room
 *   IndexedDB database named "zerosync-persistence-{roomId}". Each room gets
 *   its own database so a single-room wipe is `indexedDB.deleteDatabase(name)`.
 * - load(): reads the encrypted blob, decrypts via AES-256-GCM, returns the
 *   plaintext Uint8Array. Returns null if no row has been stored yet.
 *   Throws on decrypt failure (tampered / wrong key) — caller decides whether
 *   to clear() and start fresh, or surface the error.
 * - save(state): encrypts the state with AES-256-GCM (same wire format as
 *   crypto.ts: IV (12) || ciphertext+tag (N+16)) and writes it to IndexedDB.
 *   Resolves when the IDB transaction commits.
 * - clear(): removes the stored row so subsequent load() returns null.
 * - close(): closes the IDB connection. Subsequent operations throw.
 * - All methods after close() throw — closed instances are dead.
 * - Concurrent save() calls are NOT serialized internally. Callers should
 *   debounce or sequence writes; IndexedDB transactions themselves are atomic.
 *
 * Wire format (IndexedDB row):
 *   key:   "doc" (string)
 *   value: Uint8Array — IV (12) || ciphertext+tag (N+16)
 *
 * Provider boundary: this class encapsulates encrypt + storage. Callers see
 * only plaintext on load/save. Anyone reading the IDB row directly (devtools,
 * disk forensics) sees only ciphertext.
 */

import { encrypt, decrypt } from './crypto.js'

const DB_PREFIX  = 'zerosync-persistence-'
const STORE_NAME = 'state'
const ROW_KEY    = 'doc'

export interface EncryptedPersistenceOptions {
  /** Room identifier. Used to scope the IndexedDB database name. */
  roomId: string
  /** AES-256-GCM CryptoKey. Recommend deriving via `derivePersistKey`. */
  key: CryptoKey
}

export class EncryptedPersistence {
  private readonly db:     IDBDatabase
  private readonly key:    CryptoKey
  private readonly dbName: string
  private closed = false

  private constructor(db: IDBDatabase, key: CryptoKey, dbName: string) {
    this.db     = db
    this.key    = key
    this.dbName = dbName
  }

  /**
   * Opens (or creates) the per-room IndexedDB database.
   *
   * Spec:
   * - DB name: `zerosync-persistence-{roomId}`.
   * - One object store: `state`, out-of-line keys.
   * - Key validation is deferred to encrypt/decrypt — passing a non-AES-256
   *   key surfaces on first load/save, not at open(), to keep open() cheap.
   */
  static async open(opts: EncryptedPersistenceOptions): Promise<EncryptedPersistence> {
    const dbName = DB_PREFIX + opts.roomId
    const db     = await openDB(dbName)
    return new EncryptedPersistence(db, opts.key, dbName)
  }

  /**
   * Reads and decrypts the stored state. Returns null if no row exists.
   *
   * Spec:
   * - Throws if the instance is closed.
   * - Throws if the row is not a Uint8Array (corruption / wrong shape).
   * - Throws on AES-GCM authentication failure (tampered / wrong key).
   *   Callers may catch and clear() to recover, or surface to UI.
   */
  async load(): Promise<Uint8Array | null> {
    this.assertOpen()
    const stored = await this.runReadTx<Uint8Array | undefined>((store) => store.get(ROW_KEY))
    if (stored == null) return null
    if (!(stored instanceof Uint8Array)) {
      throw new TypeError('EncryptedPersistence: stored row is not a Uint8Array')
    }
    return decrypt(this.key, stored)
  }

  /**
   * Encrypts the state with AES-256-GCM and writes it to IndexedDB.
   *
   * Spec:
   * - Throws if the instance is closed.
   * - Resolves when the IDB transaction commits.
   * - Caller is responsible for not racing concurrent save() calls; debounce
   *   in higher-level code (see CRDTSync).
   */
  async save(state: Uint8Array): Promise<void> {
    this.assertOpen()
    const ciphertext = await encrypt(this.key, state)
    await this.runWriteTx((store) => store.put(ciphertext, ROW_KEY))
  }

  /** Removes the stored row so subsequent load() returns null. */
  async clear(): Promise<void> {
    this.assertOpen()
    await this.runWriteTx((store) => store.delete(ROW_KEY))
  }

  /** Closes the IDB connection. Idempotent. Subsequent ops throw. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('EncryptedPersistence: instance is closed')
    }
  }

  // IDBObjectStore methods return IDBRequest with various concrete generics
  // (IDBValidKey for put, undefined for delete, etc.). Subtypes don't satisfy
  // IDBRequest<T> covariantly under strict TS, so the op signature uses the
  // unparameterised IDBRequest and the result is cast at the call site.
  private runReadTx<T>(op: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx    = this.db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const req   = op(store)
      req.onsuccess = () => resolve(req.result as T)
      req.onerror   = () => reject(req.error)
      tx.onerror    = () => reject(tx.error)
      tx.onabort    = () => reject(tx.error ?? new Error('IDB transaction aborted'))
    })
  }

  private runWriteTx(op: (store: IDBObjectStore) => IDBRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx    = this.db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      op(store)
      tx.oncomplete = () => resolve()
      tx.onerror    = () => reject(tx.error)
      tx.onabort    = () => reject(tx.error ?? new Error('IDB transaction aborted'))
    })
  }
}

// ── Internal IDB helper ───────────────────────────────────────────────────────

function openDB(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onblocked = () => reject(new Error(`IndexedDB.open(${name}) blocked`))
  })
}
