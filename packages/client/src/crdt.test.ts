import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import * as Y from 'yjs'
import { CRDTSync } from './crdt.js'
import { MessageType } from './transport.js'

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
