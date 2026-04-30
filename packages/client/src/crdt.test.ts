import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fc from 'fast-check'
import * as Y from 'yjs'
import { CRDTSync } from './crdt.js'
import { MessageType } from './transport.js'
import type { EncryptedPersistence } from './persistence.js'

// ── Transport mock ───────────────────────────────────────────────────────────

function makeTransportMock() {
  return {
    broadcast:  vi.fn(),
    sendDC:     vi.fn(),
    sendRelay:  vi.fn(),
    send:       vi.fn(),
    addPeer:    vi.fn(),
    removePeer: vi.fn(),
    close:      vi.fn(),
  }
}

function makeFakeKey(): CryptoKey {
  // CRDTSync does not call encrypt/decrypt directly — transport does.
  // So a fake key is sufficient for unit-testing crdt logic.
  return {} as CryptoKey
}

// ── Unit tests ───────────────────────────────────────────────────────────────

describe('CRDTSync', () => {
  it('broadcasts local doc updates as UPDATE messages', () => {
    const doc = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })
    sync.start()

    // Make a local edit.
    doc.getMap('test').set('key', 'value')

    expect(transport.broadcast).toHaveBeenCalledWith(
      MessageType.UPDATE,
      expect.any(Uint8Array),
    )

    sync.stop()
  })

  it('does not broadcast remote updates (origin === "remote")', () => {
    const doc = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })
    sync.start()

    // Simulate a remote update by applying with origin='remote'.
    const remoteDoc = new Y.Doc()
    remoteDoc.getMap('test').set('remote-key', 'remote-value')
    const update = Y.encodeStateAsUpdate(remoteDoc)
    Y.applyUpdate(doc, update, 'remote')

    expect(transport.broadcast).not.toHaveBeenCalled()

    sync.stop()
  })

  it('does not broadcast after stop()', () => {
    const doc = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })
    sync.start()
    sync.stop()

    doc.getMap('test').set('key', 'value')

    expect(transport.broadcast).not.toHaveBeenCalled()
  })

  it('start() is idempotent', () => {
    const doc = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })
    sync.start()
    sync.start() // second call should be no-op

    doc.getMap('test').set('k', 'v')

    // Should only see one broadcast call (not doubled).
    expect(transport.broadcast).toHaveBeenCalledTimes(1)

    sync.stop()
  })
})

describe('CRDTSync.handleMessage', () => {
  it('UPDATE: applies incoming update to doc', () => {
    const doc = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })
    sync.start()

    // Create an update from a "remote" doc.
    const remoteDoc = new Y.Doc()
    remoteDoc.getMap('data').set('hello', 'world')
    const update = Y.encodeStateAsUpdate(remoteDoc)

    sync.handleMessage('peer-1', MessageType.UPDATE, update)

    expect(doc.getMap('data').get('hello')).toBe('world')
    // The applied update should NOT trigger a re-broadcast (origin='remote').
    expect(transport.broadcast).not.toHaveBeenCalled()

    sync.stop()
  })

  it('SYNC_RES: applies full state to doc', () => {
    const doc = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })
    sync.start()

    // Simulate full state from a remote peer.
    const remoteDoc = new Y.Doc()
    remoteDoc.getArray('list').push([1, 2, 3])
    const fullState = Y.encodeStateAsUpdate(remoteDoc)

    sync.handleMessage('peer-2', MessageType.SYNC_RES, fullState)

    expect(doc.getArray('list').toArray()).toEqual([1, 2, 3])
    expect(transport.broadcast).not.toHaveBeenCalled()

    sync.stop()
  })

  it('SYNC_REQ: responds with full state via send (DC or relay fallback)', () => {
    const doc = new Y.Doc()
    doc.getMap('data').set('existing', 'value')

    const transport = makeTransportMock()
    const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })
    sync.start()

    sync.handleMessage('peer-3', MessageType.SYNC_REQ, new Uint8Array(0))

    expect(transport.send).toHaveBeenCalledWith(
      'peer-3',
      MessageType.SYNC_RES,
      expect.any(Uint8Array),
    )

    // Verify the sent state is valid Yjs state.
    const sentState = transport.send.mock.calls[0]![2] as Uint8Array
    const verifyDoc = new Y.Doc()
    Y.applyUpdate(verifyDoc, sentState)
    expect(verifyDoc.getMap('data').get('existing')).toBe('value')

    sync.stop()
  })
})

describe('CRDTSync.requestFullState', () => {
  it('sends SYNC_REQ to specific peer via send (DC or relay fallback)', () => {
    const doc = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })

    sync.requestFullState('peer-5')

    expect(transport.send).toHaveBeenCalledWith(
      'peer-5',
      MessageType.SYNC_REQ,
      expect.any(Uint8Array),
    )
  })
})

// ── PBT: Yjs update serialization roundtrip ──────────────────────────────────

describe('PBT: Yjs update serialization', () => {
  it('∀ key-value pairs: update from doc A applied to doc B preserves data', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }),
        fc.string({ minLength: 0, maxLength: 128 }),
        (key, value) => {
          const docA = new Y.Doc()
          const docB = new Y.Doc()
          const transportA = makeTransportMock()

          const syncA = new CRDTSync({ doc: docA, transport: transportA as never, roomKey: makeFakeKey() })
          const syncB = new CRDTSync({ doc: docB, transport: transportA as never, roomKey: makeFakeKey() })
          syncA.start()
          syncB.start()

          // Edit on A.
          docA.getMap('data').set(key, value)

          // Route the broadcast update to B.
          const update = transportA.broadcast.mock.calls[0]![1] as Uint8Array
          syncB.handleMessage('peer-a', MessageType.UPDATE, update)

          expect(docB.getMap('data').get(key)).toBe(value)

          syncA.stop()
          syncB.stop()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('∀ sequence of edits: SYNC_RES roundtrip preserves full state', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 16 }),
            fc.integer({ min: -1000, max: 1000 })
          ),
          { minLength: 1, maxLength: 20 }
        ),
        (edits) => {
          const doc = new Y.Doc()
          const transport = makeTransportMock()
          const sync = new CRDTSync({ doc, transport: transport as never, roomKey: makeFakeKey() })
          sync.start()

          // Apply a sequence of edits.
          for (const [key, val] of edits) {
            doc.getMap('props').set(key, val)
          }

          // Request full state (simulated SYNC_REQ).
          sync.handleMessage('peer-x', MessageType.SYNC_REQ, new Uint8Array(0))
          const sentState = transport.send.mock.calls[0]![2] as Uint8Array

          // Apply full state to a fresh doc.
          const freshDoc = new Y.Doc()
          Y.applyUpdate(freshDoc, sentState)

          // The last value for each key should match.
          const expected = new Map<string, number>()
          for (const [key, val] of edits) expected.set(key, val)

          for (const [key, val] of expected) {
            expect(freshDoc.getMap('props').get(key)).toBe(val)
          }

          sync.stop()
        }
      ),
      { numRuns: 100 }
    )
  })

  it('∀ update: handleMessage(UPDATE) does not re-broadcast (no echo loop)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }),
        fc.string({ minLength: 0, maxLength: 64 }),
        (key, value) => {
          const docA = new Y.Doc()
          const docB = new Y.Doc()
          const transportA = makeTransportMock()
          const transportB = makeTransportMock()

          const syncA = new CRDTSync({ doc: docA, transport: transportA as never, roomKey: makeFakeKey() })
          const syncB = new CRDTSync({ doc: docB, transport: transportB as never, roomKey: makeFakeKey() })
          syncA.start()
          syncB.start()

          // A makes an edit, B receives it.
          docA.getMap('m').set(key, value)
          const update = transportA.broadcast.mock.calls[0]![1] as Uint8Array
          syncB.handleMessage('peer-a', MessageType.UPDATE, update)

          // B should NOT have re-broadcast the update (origin='remote').
          expect(transportB.broadcast).not.toHaveBeenCalled()

          syncA.stop()
          syncB.stop()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ── Persistence integration ──────────────────────────────────────────────────

/**
 * In-memory mock persistence — exposes the surface CRDTSync needs (load,
 * save, close) without touching IndexedDB. The actual IDB roundtrip is
 * covered in persistence.test.ts.
 */
function makeMemoryPersistence(initial: Uint8Array | null = null) {
  let state:  Uint8Array | null = initial
  let closed = false
  return {
    load:  vi.fn(async (): Promise<Uint8Array | null> => {
      if (closed) throw new Error('closed')
      return state
    }),
    save:  vi.fn(async (s: Uint8Array): Promise<void> => {
      if (closed) throw new Error('closed')
      state = s
    }),
    clear: vi.fn(async (): Promise<void> => { state = null }),
    close: vi.fn((): void => { closed = true }),
    getStoredState: () => state,
  }
}

type MockPersistence = ReturnType<typeof makeMemoryPersistence>

function asPersistence(mock: MockPersistence): EncryptedPersistence {
  return mock as unknown as EncryptedPersistence
}

describe('CRDTSync persistence', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(()  => { vi.useRealTimers() })

  it('start() loads stored state and applies it to the doc', async () => {
    // Build a stored state from a "previous session" doc.
    const prevDoc = new Y.Doc()
    prevDoc.getMap('data').set('persisted', 'value')
    const stored = Y.encodeStateAsUpdate(prevDoc)

    const persistence = makeMemoryPersistence(stored)
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc,
      transport:   transport as never,
      roomKey:     makeFakeKey(),
      persistence: asPersistence(persistence),
    })

    await sync.start()

    expect(persistence.load).toHaveBeenCalledTimes(1)
    expect(doc.getMap('data').get('persisted')).toBe('value')
    sync.stop()
  })

  it('restore-applied update does NOT trigger broadcast (no echo to peers)', async () => {
    const prevDoc = new Y.Doc()
    prevDoc.getMap('m').set('k', 'v')
    const stored = Y.encodeStateAsUpdate(prevDoc)

    const persistence = makeMemoryPersistence(stored)
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
    })

    await sync.start()

    expect(transport.broadcast).not.toHaveBeenCalled()
    sync.stop()
  })

  it('restore-applied update does NOT schedule a save (would be redundant)', async () => {
    const prevDoc = new Y.Doc()
    prevDoc.getMap('m').set('k', 'v')
    const stored = Y.encodeStateAsUpdate(prevDoc)

    const persistence = makeMemoryPersistence(stored)
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
    })
    await sync.start()
    persistence.save.mockClear()

    // Advance past the debounce window — no save should fire from the restore.
    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    expect(persistence.save).not.toHaveBeenCalled()
    sync.stop()
  })

  it('start() returns null-load gracefully (empty doc, no error)', async () => {
    const persistence = makeMemoryPersistence(null)
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
    })

    await expect(sync.start()).resolves.toBeUndefined()
    expect(doc.getMap('data').size).toBe(0)
    sync.stop()
  })

  it('start() swallows load failures so sync continues', async () => {
    const persistence = makeMemoryPersistence(null)
    persistence.load.mockRejectedValueOnce(new Error('decrypt failed'))

    const doc       = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
    })

    // Should NOT throw — load failure is logged, not propagated.
    await expect(sync.start()).resolves.toBeUndefined()
    sync.stop()
  })

  it('local update schedules a save after debounce window', async () => {
    const persistence = makeMemoryPersistence()
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
      saveDebounceMs: 100,
    })

    await sync.start()
    doc.getMap('data').set('k', 'v')

    // Before debounce expires: no save yet.
    expect(persistence.save).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    await vi.runAllTimersAsync()

    expect(persistence.save).toHaveBeenCalledTimes(1)
    sync.stop()
  })

  it('multiple rapid updates coalesce into a single debounced save', async () => {
    const persistence = makeMemoryPersistence()
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
      saveDebounceMs: 100,
    })

    await sync.start()
    doc.getMap('data').set('a', 1)
    doc.getMap('data').set('b', 2)
    doc.getMap('data').set('c', 3)

    vi.advanceTimersByTime(100)
    await vi.runAllTimersAsync()

    // All three edits were coalesced into one save.
    expect(persistence.save).toHaveBeenCalledTimes(1)

    // The saved state contains all three values.
    const saved = persistence.save.mock.calls[0]![0] as Uint8Array
    const verifyDoc = new Y.Doc()
    Y.applyUpdate(verifyDoc, saved)
    expect(verifyDoc.getMap('data').get('a')).toBe(1)
    expect(verifyDoc.getMap('data').get('b')).toBe(2)
    expect(verifyDoc.getMap('data').get('c')).toBe(3)
    sync.stop()
  })

  it('remote update schedules a save (at-rest tracks merged doc)', async () => {
    const persistence = makeMemoryPersistence()
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
      saveDebounceMs: 100,
    })

    await sync.start()

    const remoteDoc = new Y.Doc()
    remoteDoc.getMap('data').set('from-remote', 'hello')
    const update = Y.encodeStateAsUpdate(remoteDoc)
    sync.handleMessage('peer-1', MessageType.UPDATE, update)

    vi.advanceTimersByTime(100)
    await vi.runAllTimersAsync()

    expect(persistence.save).toHaveBeenCalledTimes(1)
    sync.stop()
  })

  it('stop() flushes pending debounced save', async () => {
    const persistence = makeMemoryPersistence()
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
      saveDebounceMs: 1000,
    })

    await sync.start()
    doc.getMap('data').set('k', 'v')

    // Stop before the debounce window expires — flush should still fire.
    sync.stop()
    await vi.runAllTimersAsync()

    expect(persistence.save).toHaveBeenCalledTimes(1)
  })

  it('stop() does NOT close the persistence (caller owns lifecycle)', async () => {
    const persistence = makeMemoryPersistence()
    const doc         = new Y.Doc()
    const transport   = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
    })
    await sync.start()
    sync.stop()
    expect(persistence.close).not.toHaveBeenCalled()
  })

  it('save failure does not throw (logged and swallowed)', async () => {
    const persistence = makeMemoryPersistence()
    persistence.save.mockRejectedValue(new Error('quota exceeded'))

    const doc       = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
      persistence: asPersistence(persistence),
      saveDebounceMs: 50,
    })
    await sync.start()
    doc.getMap('data').set('k', 'v')

    // Should not throw despite save failure (logged + swallowed inside flushSave).
    vi.advanceTimersByTime(50)
    await vi.runAllTimersAsync()
    expect(persistence.save).toHaveBeenCalledTimes(1)
    sync.stop()
  })

  it('without persistence: behavior unchanged (no save, no load)', async () => {
    const doc       = new Y.Doc()
    const transport = makeTransportMock()
    const sync = new CRDTSync({
      doc, transport: transport as never, roomKey: makeFakeKey(),
    })

    await sync.start()
    doc.getMap('data').set('k', 'v')

    // No persistence → no debounced timer → broadcast still fires synchronously.
    expect(transport.broadcast).toHaveBeenCalledTimes(1)
    sync.stop()
  })
})

// ── Integration: two docs syncing via CRDTSync ───────────────────────────────

describe('CRDTSync integration: two docs', () => {
  it('edits on doc A appear on doc B when updates are routed', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const transportA = makeTransportMock()
    const transportB = makeTransportMock()

    const syncA = new CRDTSync({ doc: docA, transport: transportA as never, roomKey: makeFakeKey() })
    const syncB = new CRDTSync({ doc: docB, transport: transportB as never, roomKey: makeFakeKey() })
    syncA.start()
    syncB.start()

    // Edit on A.
    docA.getMap('shared').set('color', 'blue')

    // Route the broadcast update to B.
    const broadcastCall = transportA.broadcast.mock.calls[0]!
    const updateData = broadcastCall[1] as Uint8Array
    syncB.handleMessage('peer-a', MessageType.UPDATE, updateData)

    expect(docB.getMap('shared').get('color')).toBe('blue')

    // Edit on B.
    docB.getMap('shared').set('size', 42)

    const broadcastCallB = transportB.broadcast.mock.calls[0]!
    const updateDataB = broadcastCallB[1] as Uint8Array
    syncA.handleMessage('peer-b', MessageType.UPDATE, updateDataB)

    expect(docA.getMap('shared').get('size')).toBe(42)

    syncA.stop()
    syncB.stop()
  })
})
