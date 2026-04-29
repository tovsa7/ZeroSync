import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from 'y-protocols/awareness'
import fc from 'fast-check'
import { PresenceManager } from './presence.js'
import type { PresenceState } from './presence.js'

// ── Transport mock ───────────────────────────────────────────────────────────

function makeTransportMock() {
  return {
    broadcast:  vi.fn(),
    sendDC:     vi.fn(),
    sendRelay:  vi.fn(),
    addPeer:    vi.fn(),
    removePeer: vi.fn(),
    close:      vi.fn(),
  }
}

function makePresence(peerId = 'local-peer') {
  const doc       = new Y.Doc()
  const transport = makeTransportMock()
  const pm        = new PresenceManager({
    peerId,
    doc,
    transport: transport as never,
  })
  return { pm, doc, transport }
}

/**
 * Produces a binary y-protocols awareness update as if sent by a remote peer.
 * Uses a separate Y.Doc + Awareness so clientIDs don't collide with the SUT.
 */
function makeRemoteUpdate(peerId: string, state: PresenceState): Uint8Array {
  const doc = new Y.Doc()
  const aw  = new Awareness(doc)
  aw.setLocalState({ peerId, ...state })
  const update = encodeAwarenessUpdate(aw, [aw.clientID])
  aw.destroy()
  return update
}

// ── updatePresence ───────────────────────────────────────────────────────────

describe('PresenceManager.updatePresence', () => {
  it('broadcasts PRESENCE (0x02) with a Uint8Array payload — not JSON', () => {
    const { pm, transport } = makePresence()
    pm.updatePresence({ name: 'Alice' })

    expect(transport.broadcast).toHaveBeenCalledOnce()
    const [type, data] = transport.broadcast.mock.calls[0]!
    expect(type).toBe(0x02)
    expect(data).toBeInstanceOf(Uint8Array)
    // Ensure it is NOT a JSON string encoded as UTF-8.
    expect(() => {
      const text = new TextDecoder().decode(data as Uint8Array)
      JSON.parse(text)
    }).toThrow()
  })

  it('encoded update can be applied by a fresh Awareness instance', () => {
    const { pm, transport } = makePresence('peer-a')
    pm.updatePresence({ name: 'Alice', cursor: { x: 10, y: 20 } })

    const bytes      = transport.broadcast.mock.calls[0]![1] as Uint8Array
    const remoteDoc  = new Y.Doc()
    const remoteAw   = new Awareness(remoteDoc)
    applyAwarenessUpdate(remoteAw, bytes, 'test')

    const states = [...remoteAw.getStates().values()]
    const match  = states.find(s => s['peerId'] === 'peer-a')
    expect(match).toMatchObject({ name: 'Alice', cursor: { x: 10, y: 20 }, peerId: 'peer-a' })
    remoteAw.destroy()
    pm.destroy()
  })

  it('fires onPresence callback after local update', () => {
    const { pm } = makePresence('me')
    const cb = vi.fn()
    pm.onPresence(cb)
    pm.updatePresence({ name: 'Bob' })

    expect(cb).toHaveBeenCalledOnce()
    // Local peer is excluded from getPresence() — map should be empty.
    const peers = cb.mock.calls[0]![0] as ReadonlyMap<string, PresenceState>
    expect(peers.size).toBe(0)
    pm.destroy()
  })

  it('broadcasts again on subsequent calls (each call is a fresh update)', () => {
    const { pm, transport } = makePresence()
    pm.updatePresence({ x: 1 })
    pm.updatePresence({ x: 2 })
    expect(transport.broadcast).toHaveBeenCalledTimes(2)
    pm.destroy()
  })

  // Regression guard: the broadcast handler listens to y-protocols 'update'
  // (fires on every setLocalState call), NOT 'change' (only fires on diff).
  // Without this, repeated identical state calls — including the no-op clock
  // refresh that y-protocols' internal _checkInterval runs every ~15 s —
  // would not broadcast, and remote peers would age us out at the 30 s
  // outdatedTimeout. See presence.ts comment on the dual-listener design.
  it('broadcasts even when local state has not changed (refresh path)', () => {
    const { pm, transport } = makePresence()
    pm.updatePresence({ name: 'Alice' })
    pm.updatePresence({ name: 'Alice' }) // identical — no diff
    expect(transport.broadcast).toHaveBeenCalledTimes(2)
    pm.destroy()
  })
})

// ── handleMessage ─────────────────────────────────────────────────────────────

describe('PresenceManager.handleMessage', () => {
  it('stores remote peer presence in getPresence()', () => {
    const { pm } = makePresence()
    pm.handleMessage('peer-1', makeRemoteUpdate('peer-1', { name: 'Dave' }))

    const presence = pm.getPresence()
    expect(presence.get('peer-1')).toEqual({ name: 'Dave' })
    pm.destroy()
  })

  it('fires onPresence callback on remote update', () => {
    const { pm } = makePresence()
    const cb = vi.fn()
    pm.onPresence(cb)
    pm.handleMessage('peer-1', makeRemoteUpdate('peer-1', { name: 'Eve' }))

    expect(cb).toHaveBeenCalledOnce()
    pm.destroy()
  })

  it('does NOT re-broadcast the received update (no echo)', () => {
    const { pm, transport } = makePresence()
    pm.handleMessage('peer-1', makeRemoteUpdate('peer-1', { name: 'Eve' }))
    expect(transport.broadcast).not.toHaveBeenCalled()
    pm.destroy()
  })

  it('tracks multiple remote peers independently', () => {
    const { pm } = makePresence()
    pm.handleMessage('peer-a', makeRemoteUpdate('peer-a', { name: 'A' }))
    pm.handleMessage('peer-b', makeRemoteUpdate('peer-b', { name: 'B' }))

    expect(pm.getPresence().get('peer-a')).toEqual({ name: 'A' })
    expect(pm.getPresence().get('peer-b')).toEqual({ name: 'B' })
    pm.destroy()
  })

  it('updates existing peer presence on a subsequent message', () => {
    const { pm } = makePresence()
    // The same remote peer sends two updates from the SAME Awareness instance
    // so clientID is stable across both messages.
    const remoteDoc = new Y.Doc()
    const remoteAw  = new Awareness(remoteDoc)
    remoteAw.setLocalState({ peerId: 'peer-1', v: 1 })
    pm.handleMessage('peer-1', encodeAwarenessUpdate(remoteAw, [remoteAw.clientID]))

    remoteAw.setLocalState({ peerId: 'peer-1', v: 2 })
    pm.handleMessage('peer-1', encodeAwarenessUpdate(remoteAw, [remoteAw.clientID]))

    expect(pm.getPresence().get('peer-1')).toEqual({ v: 2 })
    remoteAw.destroy()
    pm.destroy()
  })

  it('discards invalid (non-awareness) bytes silently', () => {
    const { pm } = makePresence()
    const cb = vi.fn()
    pm.onPresence(cb)
    pm.handleMessage('bad-peer', new Uint8Array([0xff, 0xfe, 0x00]))

    expect(cb).not.toHaveBeenCalled()
    expect(pm.getPresence().size).toBe(0)
    pm.destroy()
  })
})

// ── removePeer ────────────────────────────────────────────────────────────────

describe('PresenceManager.removePeer', () => {
  it('removes a known peer and fires the callback', () => {
    const { pm } = makePresence()
    const remoteDoc = new Y.Doc()
    const remoteAw  = new Awareness(remoteDoc)
    remoteAw.setLocalState({ peerId: 'peer-1', name: 'Frank' })
    pm.handleMessage('peer-1', encodeAwarenessUpdate(remoteAw, [remoteAw.clientID]))

    const cb = vi.fn()
    pm.onPresence(cb)
    pm.removePeer('peer-1')

    expect(pm.getPresence().has('peer-1')).toBe(false)
    expect(cb).toHaveBeenCalledOnce()
    remoteAw.destroy()
    pm.destroy()
  })

  it('no-op and no callback when removing an unknown peer', () => {
    const { pm } = makePresence()
    const cb = vi.fn()
    pm.onPresence(cb)
    pm.removePeer('nobody')

    expect(cb).not.toHaveBeenCalled()
    pm.destroy()
  })

  it('no-op when called before any handleMessage for that peer', () => {
    const { pm } = makePresence()
    expect(() => pm.removePeer('peer-1')).not.toThrow()
    pm.destroy()
  })
})

// ── syncToPeer ────────────────────────────────────────────────────────────────

describe('PresenceManager.syncToPeer', () => {
  it('sends to the requested peerId only (per-peer addressing, not broadcast)', () => {
    const { pm, transport } = makePresence('me')
    pm.updatePresence({ name: 'Alice' })
    transport.broadcast.mockClear()
    transport.sendDC.mockClear()

    pm.syncToPeer('target-peer')
    expect(transport.sendDC).toHaveBeenCalledOnce()
    expect(transport.sendDC.mock.calls[0]![0]).toBe('target-peer')
    pm.destroy()
  })

  it('sends the local awareness snapshot to one peer over DC', () => {
    const { pm, transport } = makePresence('me')
    pm.updatePresence({ name: 'Alice' })
    transport.broadcast.mockClear() // ignore the broadcast from updatePresence

    pm.syncToPeer('new-peer')
    expect(transport.sendDC).toHaveBeenCalledOnce()
    const [target, type, data] = transport.sendDC.mock.calls[0]!
    expect(target).toBe('new-peer')
    expect(type).toBe(0x02)             // MessageType.PRESENCE
    expect(data).toBeInstanceOf(Uint8Array)
    pm.destroy()
  })

  it('snapshot includes BOTH local AND known remote awareness states', () => {
    const { pm, transport } = makePresence('me')
    pm.updatePresence({ name: 'Me' })
    pm.handleMessage('peer-1', makeRemoteUpdate('peer-1', { name: 'A' }))
    pm.handleMessage('peer-2', makeRemoteUpdate('peer-2', { name: 'B' }))
    transport.sendDC.mockClear()

    pm.syncToPeer('new-peer')
    expect(transport.sendDC).toHaveBeenCalledOnce()
    const bytes = transport.sendDC.mock.calls[0]![2] as Uint8Array

    // Decode the snapshot in a fresh Awareness — it should reconstruct all
    // three peers (the gossiped sender + two known remotes).
    const remoteDoc = new Y.Doc()
    const remoteAw  = new Awareness(remoteDoc)
    applyAwarenessUpdate(remoteAw, bytes, 'test')
    const peerIds = [...remoteAw.getStates().values()]
      .map(s => s['peerId'])
      .filter((id): id is string => typeof id === 'string')
      .sort()
    expect(peerIds).toEqual(['me', 'peer-1', 'peer-2'])

    remoteAw.destroy()
    pm.destroy()
  })

  it('does not call broadcast (per-peer send only, no fan-out)', () => {
    const { pm, transport } = makePresence('me')
    pm.updatePresence({ name: 'Alice' })
    transport.broadcast.mockClear()

    pm.syncToPeer('peer-x')
    expect(transport.broadcast).not.toHaveBeenCalled()
    pm.destroy()
  })
})

// ── getPresence ───────────────────────────────────────────────────────────────

describe('PresenceManager.getPresence', () => {
  it('excludes the local peer from the returned map', () => {
    const { pm } = makePresence('local-me')
    pm.updatePresence({ name: 'Me' })
    expect(pm.getPresence().has('local-me')).toBe(false)
    pm.destroy()
  })

  it('strips the internal peerId routing field from returned state values', () => {
    const { pm } = makePresence()
    pm.handleMessage('peer-1', makeRemoteUpdate('peer-1', { name: 'Alice', x: 5 }))

    const state = pm.getPresence().get('peer-1')!
    expect(state).toEqual({ name: 'Alice', x: 5 })
    expect('peerId' in state).toBe(false)
    pm.destroy()
  })

  it('returns an empty map when no remote peers have sent presence', () => {
    const { pm } = makePresence()
    expect(pm.getPresence().size).toBe(0)
    pm.destroy()
  })
})

// ── onPresence ────────────────────────────────────────────────────────────────

describe('PresenceManager.onPresence', () => {
  it('returns an unsubscribe function that stops future callbacks', () => {
    const { pm } = makePresence()
    const cb   = vi.fn()
    const unsub = pm.onPresence(cb)

    pm.handleMessage('p', makeRemoteUpdate('p', { a: 1 }))
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()
    pm.handleMessage('p', makeRemoteUpdate('p', { a: 2 }))
    // Note: same clientID from makeRemoteUpdate won't fire 'updated' because
    // each call creates a fresh Y.Doc — clientIDs will differ, so this is 'added'.
    expect(cb).toHaveBeenCalledTimes(1)
    pm.destroy()
  })

  it('supports multiple independent callbacks', () => {
    const { pm } = makePresence()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    pm.onPresence(cb1)
    pm.onPresence(cb2)

    pm.handleMessage('p', makeRemoteUpdate('p', { z: 3 }))
    expect(cb1).toHaveBeenCalledOnce()
    expect(cb2).toHaveBeenCalledOnce()
    pm.destroy()
  })
})

// ── destroy ───────────────────────────────────────────────────────────────────

describe('PresenceManager.destroy', () => {
  it('broadcasts a final update (null state = "peer left") via transport', () => {
    const { pm, transport } = makePresence()
    pm.updatePresence({ name: 'Alice' })
    expect(transport.broadcast).toHaveBeenCalledTimes(1)

    pm.destroy()
    // destroy() → awareness.destroy() → setLocalState(null) → 'change' (local) → broadcast
    expect(transport.broadcast).toHaveBeenCalledTimes(2)
  })

  it('suppresses onPresence callbacks after destroy()', () => {
    const { pm } = makePresence()
    const cb = vi.fn()
    pm.onPresence(cb)
    pm.destroy()

    // Any remaining awareness state changes after destroy must not fire callbacks.
    expect(cb).not.toHaveBeenCalled()
  })
})

// ── Roundtrip integration ─────────────────────────────────────────────────────

describe('PresenceManager roundtrip', () => {
  it('updatePresence → handleMessage delivers state to remote peer', () => {
    const sender   = makePresence('sender-peer')
    const receiver = makePresence('receiver-peer')

    sender.pm.updatePresence({ name: 'Grace', cursor: { x: 7, y: 3 } })
    const bytes = sender.transport.broadcast.mock.calls[0]![1] as Uint8Array

    receiver.pm.handleMessage('sender-peer', bytes)

    expect(receiver.pm.getPresence().get('sender-peer')).toEqual({
      name: 'Grace',
      cursor: { x: 7, y: 3 },
    })
    sender.pm.destroy()
    receiver.pm.destroy()
  })

  it('PBT: any JSON-compatible state survives encode → handleMessage → getPresence', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ maxLength: 32 }),
          x:    fc.integer({ min: -9999, max: 9999 }),
          y:    fc.integer({ min: -9999, max: 9999 }),
        }),
        (state) => {
          const sender   = makePresence('sender')
          const receiver = makePresence('receiver')

          sender.pm.updatePresence(state)
          const bytes = sender.transport.broadcast.mock.calls[0]![1] as Uint8Array
          receiver.pm.handleMessage('sender', bytes)

          expect(receiver.pm.getPresence().get('sender')).toEqual(state)

          sender.pm.destroy()
          receiver.pm.destroy()
        },
      ),
    )
  })
})
