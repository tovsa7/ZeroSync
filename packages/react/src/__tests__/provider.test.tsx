/**
 * Tests for ZeroSyncProvider.
 *
 * Covers the spec defined in ../provider.tsx:
 *  1. Renders children unconditionally
 *  2. Initial context is { room: null, status: 'connecting' }
 *  3. Post-join context reflects the joined Room + 'connected' status
 *  4. Unmount calls room.leave()
 *  5. Join rejection invokes onError and sets status to 'closed'
 *  6. Unmount before join resolves still tears down the late-arriving Room
 *  7. Status changes from room.onStatus propagate to context
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useContext, type ReactElement } from 'react'
import * as Y from 'yjs'

import { ZeroSyncProvider } from '../provider.js'
import { ZeroSyncContext } from '../context.js'

// Mock the client SDK. The Provider uses Room.join, EncryptedPersistence.open,
// and the RoomJoinError class for `instanceof` reason routing — the mock must
// supply a real (or stand-in) class so `err instanceof RoomJoinError` doesn't
// throw at runtime. The class is defined *inside* the factory because vi.mock
// is hoisted above top-level declarations.
vi.mock('@tovsa7/zerosync-client', () => {
  class MockRoomJoinError extends Error {
    readonly reason: 'capacity' | 'unreachable' | 'unknown'
    constructor(message: string, reason: 'capacity' | 'unreachable' | 'unknown') {
      super(message)
      this.name   = 'RoomJoinError'
      this.reason = reason
    }
  }
  return {
    Room: { join: vi.fn() },
    EncryptedPersistence: { open: vi.fn() },
    RoomJoinError: MockRoomJoinError,
  }
})

import {
  Room,
  RoomJoinError,
  EncryptedPersistence,
  type RoomStatus,
  type StatusCallback,
} from '@tovsa7/zerosync-client'

// ── helpers ─────────────────────────────────────────────────────────────────

interface MockRoomHandle {
  // Typed as unknown so tests can pass it to mockResolvedValue without the
  // full Room structural type burden. The Provider only calls a subset of
  // methods which the mock implements.
  room:         unknown
  driveStatus:  (s: RoomStatus) => void
  leaveCalled: () => boolean
}

/**
 * Builds a mock Room exposing the public surface the Provider relies on.
 * Captures onStatus's callback so tests can drive status transitions.
 */
function createMockRoom(): MockRoomHandle {
  let statusCb: StatusCallback | null = null
  const leave = vi.fn()
  const room = {
    getDoc:                vi.fn(() => new Y.Doc()),
    updatePresence:        vi.fn(),
    onPresence:            vi.fn(() => () => {}),
    getPresence:           vi.fn(() => new Map()),
    getConnectionSummary:  vi.fn(() => ({ total: 0, p2p: 0 })),
    onStatus: vi.fn((cb: StatusCallback) => {
      statusCb = cb
      // Mirror real SDK: deliver current status async via queueMicrotask.
      queueMicrotask(() => cb('connected'))
      return () => { statusCb = null }
    }),
    leave,
  }
  return {
    room,
    driveStatus: (s: RoomStatus) => { statusCb?.(s) },
    leaveCalled: () => leave.mock.calls.length > 0,
  }
}

/** Renders the current ZeroSyncContext value to the DOM for assertions. */
function ContextProbe(): ReactElement {
  const ctx = useContext(ZeroSyncContext)
  return (
    <div>
      <div data-testid="room">{ctx.room ? 'room' : 'null'}</div>
      <div data-testid="status">{ctx.status}</div>
      <div data-testid="rejectedReason">{ctx.rejectedReason ?? 'null'}</div>
    </div>
  )
}

/** Base RoomOptions used across tests. Only meaningful fields are set. */
const baseOpts = {
  serverUrl:  'ws://localhost:8080/ws',
  roomId:     'test-room',
  roomKey:    {} as CryptoKey,
  peerId:     'peer-1',
  nonce:      'nonce-1',
  hmac:       '',
  iceServers: [] as RTCIceServer[],
}

/** Flush microtasks + macrotasks so async state updates settle. */
async function flush(): Promise<void> {
  await act(async () => {
    // Two microtask boundaries cover queueMicrotask + Promise.resolve chain.
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('ZeroSyncProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Explicit cleanup because vitest.config has globals: false,
    // so @testing-library/react's auto-cleanup afterEach hook cannot register.
    cleanup()
  })

  it('renders children unconditionally', async () => {
    const mock = createMockRoom()
    vi.mocked(Room.join).mockResolvedValue(mock.room as never)

    render(
      <ZeroSyncProvider {...baseOpts}>
        <div>child-marker</div>
      </ZeroSyncProvider>,
    )
    expect(screen.getByText('child-marker')).toBeDefined()
  })

  it('initial context is { room: null, status: connecting }', () => {
    // Return a never-settling promise so the provider stays in 'connecting'.
    vi.mocked(Room.join).mockReturnValue(new Promise(() => {}))

    render(
      <ZeroSyncProvider {...baseOpts}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    expect(screen.getByTestId('room').textContent).toBe('null')
    expect(screen.getByTestId('status').textContent).toBe('connecting')
  })

  it('updates context to connected after Room.join resolves', async () => {
    const mock = createMockRoom()
    vi.mocked(Room.join).mockResolvedValue(mock.room as never)

    render(
      <ZeroSyncProvider {...baseOpts}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()

    expect(screen.getByTestId('room').textContent).toBe('room')
    expect(screen.getByTestId('status').textContent).toBe('connected')
  })

  it('calls room.leave on unmount', async () => {
    const mock = createMockRoom()
    vi.mocked(Room.join).mockResolvedValue(mock.room as never)

    const { unmount } = render(
      <ZeroSyncProvider {...baseOpts}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()
    unmount()

    expect(mock.leaveCalled()).toBe(true)
  })

  it('invokes onError and sets status=rejected (reason=unknown) on generic Room.join rejection', async () => {
    const error  = new Error('connection failed')
    const onErr  = vi.fn()
    vi.mocked(Room.join).mockRejectedValue(error)

    render(
      <ZeroSyncProvider {...baseOpts} onError={onErr}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()

    expect(onErr).toHaveBeenCalledTimes(1)
    expect(onErr).toHaveBeenCalledWith(error)
    expect(screen.getByTestId('room').textContent).toBe('null')
    // Generic errors collapse to reason='unknown' (only RoomJoinError carries
    // a precise reason from the SDK's /health probe).
    expect(screen.getByTestId('status').textContent).toBe('rejected')
    expect(screen.getByTestId('rejectedReason').textContent).toBe('unknown')
  })

  it('forwards RoomJoinError.reason to context.rejectedReason', async () => {
    const error = new RoomJoinError('cap reached', 'capacity')
    vi.mocked(Room.join).mockRejectedValue(error)

    render(
      <ZeroSyncProvider {...baseOpts}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()

    expect(screen.getByTestId('status').textContent).toBe('rejected')
    expect(screen.getByTestId('rejectedReason').textContent).toBe('capacity')
  })

  it('tears down a Room that resolves after unmount', async () => {
    const mock = createMockRoom()
    let resolveJoin: (r: unknown) => void = () => {}
    const pending = new Promise<unknown>((res) => { resolveJoin = res })
    vi.mocked(Room.join).mockReturnValue(pending as Promise<never>)

    const { unmount } = render(
      <ZeroSyncProvider {...baseOpts}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    // Unmount BEFORE Room.join resolves.
    unmount()

    // Now the SDK resolves the join promise with the Room instance.
    resolveJoin(mock.room)
    await flush()

    // The late-arriving Room should be cleaned up (no leaked connection).
    expect(mock.leaveCalled()).toBe(true)
  })

  it('propagates status changes from room.onStatus into context', async () => {
    const mock = createMockRoom()
    vi.mocked(Room.join).mockResolvedValue(mock.room as never)

    render(
      <ZeroSyncProvider {...baseOpts}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()
    expect(screen.getByTestId('status').textContent).toBe('connected')

    await act(async () => {
      mock.driveStatus('reconnecting')
    })
    expect(screen.getByTestId('status').textContent).toBe('reconnecting')

    await act(async () => {
      mock.driveStatus('closed')
    })
    expect(screen.getByTestId('status').textContent).toBe('closed')
  })
})

// ── persistKey integration ──────────────────────────────────────────────────

describe('ZeroSyncProvider — persistKey', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(()  => { cleanup() })

  function makeMockPersistence() {
    return {
      load:  vi.fn(async () => null),
      save:  vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
      close: vi.fn(),
    }
  }

  it('without persistKey: EncryptedPersistence.open is NOT called', async () => {
    const mock = createMockRoom()
    vi.mocked(Room.join).mockResolvedValue(mock.room as never)

    render(
      <ZeroSyncProvider {...baseOpts}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()
    expect(EncryptedPersistence.open).not.toHaveBeenCalled()
    // Room.join called WITHOUT persistence.
    const joinArgs = vi.mocked(Room.join).mock.calls[0]![0]
    expect(joinArgs.persistence).toBeUndefined()
  })

  it('with persistKey: opens persistence and threads it into Room.join', async () => {
    const mock        = createMockRoom()
    const persistence = makeMockPersistence()
    vi.mocked(Room.join).mockResolvedValue(mock.room as never)
    vi.mocked(EncryptedPersistence.open).mockResolvedValue(persistence as never)

    const fakeKey = {} as CryptoKey
    render(
      <ZeroSyncProvider {...baseOpts} persistKey={fakeKey}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()

    expect(EncryptedPersistence.open).toHaveBeenCalledWith({
      roomId: baseOpts.roomId,
      key:    fakeKey,
    })
    const joinArgs = vi.mocked(Room.join).mock.calls[0]![0]
    expect(joinArgs.persistence).toBe(persistence)
  })

  it('with persistKey: closes persistence on unmount AFTER leave()', async () => {
    const mock        = createMockRoom()
    const persistence = makeMockPersistence()
    vi.mocked(Room.join).mockResolvedValue(mock.room as never)
    vi.mocked(EncryptedPersistence.open).mockResolvedValue(persistence as never)

    const { unmount } = render(
      <ZeroSyncProvider {...baseOpts} persistKey={{} as CryptoKey}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()
    unmount()

    expect(mock.leaveCalled()).toBe(true)
    expect(persistence.close).toHaveBeenCalledTimes(1)
  })

  it('with persistKey: closes persistence if Room.join rejects', async () => {
    const persistence = makeMockPersistence()
    const onErr       = vi.fn()
    vi.mocked(EncryptedPersistence.open).mockResolvedValue(persistence as never)
    vi.mocked(Room.join).mockRejectedValue(new Error('conn failed'))

    render(
      <ZeroSyncProvider {...baseOpts} persistKey={{} as CryptoKey} onError={onErr}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    await flush()

    expect(onErr).toHaveBeenCalled()
    expect(persistence.close).toHaveBeenCalledTimes(1)
  })

  it('with persistKey: closes persistence if unmounted before Room.join resolves', async () => {
    const mock        = createMockRoom()
    const persistence = makeMockPersistence()
    vi.mocked(EncryptedPersistence.open).mockResolvedValue(persistence as never)

    let resolveJoin: (r: unknown) => void = () => {}
    const pending = new Promise<unknown>((res) => { resolveJoin = res })
    vi.mocked(Room.join).mockReturnValue(pending as Promise<never>)

    const { unmount } = render(
      <ZeroSyncProvider {...baseOpts} persistKey={{} as CryptoKey}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    // Wait for persistence.open to resolve, then unmount before Room.join.
    await flush()
    unmount()

    // Now Room.join finally resolves with a Room instance.
    resolveJoin(mock.room)
    await flush()

    // The late-arriving Room is leaved AND persistence is closed.
    expect(mock.leaveCalled()).toBe(true)
    expect(persistence.close).toHaveBeenCalled()
  })

  it('with persistKey: closes persistence if unmounted during EncryptedPersistence.open', async () => {
    const persistence = makeMockPersistence()

    let resolveOpen: (p: unknown) => void = () => {}
    const pending = new Promise<unknown>((res) => { resolveOpen = res })
    vi.mocked(EncryptedPersistence.open).mockReturnValue(pending as Promise<never>)

    const { unmount } = render(
      <ZeroSyncProvider {...baseOpts} persistKey={{} as CryptoKey}>
        <ContextProbe />
      </ZeroSyncProvider>,
    )

    // Unmount BEFORE EncryptedPersistence.open resolves.
    unmount()
    resolveOpen(persistence)
    await flush()

    // Late-arriving persistence should still be closed.
    expect(persistence.close).toHaveBeenCalled()
    // Room.join should NOT have been called (we cancelled before it.)
    expect(Room.join).not.toHaveBeenCalled()
  })
})
