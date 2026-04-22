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

// Mock the client SDK. The Provider only uses Room.join; other SDK exports
// are not touched here.
vi.mock('@tovsa7/zerosync-client', () => ({
  Room: {
    join: vi.fn(),
  },
}))

import { Room, type RoomStatus, type StatusCallback } from '@tovsa7/zerosync-client'

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

  it('invokes onError and sets status=closed when Room.join rejects', async () => {
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
    expect(screen.getByTestId('status').textContent).toBe('closed')
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
