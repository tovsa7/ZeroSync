/**
 * Tests for usePresence + useMyPresence.
 *
 * Strategy: render probes inside ZeroSyncContext.Provider with a mock
 * Room exposing getPresence / onPresence / updatePresence. This isolates
 * the hook contract from the real async Room lifecycle.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useCallback, type ReactElement } from 'react'

import { ZeroSyncContext } from '../context.js'
import { usePresence, useMyPresence } from '../presence.js'
import type { Room, PresenceState, PresenceCallback } from '@tovsa7/zerosync-client'

// ── helpers ─────────────────────────────────────────────────────────────────

interface MockRoom {
  room:                 Room
  drivePresence:        (peers: ReadonlyMap<string, PresenceState>) => void
  updatePresenceCalls:  () => PresenceState[]
  onPresenceSubCount:   () => number
  onPresenceUnsubCount: () => number
}

/**
 * Builds a Room stand-in with a controllable presence stream.
 */
function createMockRoom(initial: ReadonlyMap<string, PresenceState> = new Map()): MockRoom {
  let presence: ReadonlyMap<string, PresenceState> = initial
  const callbacks = new Set<PresenceCallback>()
  let subCount   = 0
  let unsubCount = 0
  const updatePresenceCalls: PresenceState[] = []

  const room = {
    getPresence:          () => presence,
    updatePresence:       (s: PresenceState) => { updatePresenceCalls.push(s) },
    onPresence:           (cb: PresenceCallback) => {
      callbacks.add(cb)
      subCount++
      return () => { callbacks.delete(cb); unsubCount++ }
    },
    getConnectionSummary: () => ({ total: 0, p2p: 0 }),
    getDoc:               () => ({}),
    onStatus:             () => () => {},
    leave:                () => {},
  } as unknown as Room

  return {
    room,
    drivePresence: (peers) => {
      presence = peers
      for (const cb of callbacks) cb(peers)
    },
    updatePresenceCalls:  () => updatePresenceCalls.slice(),
    onPresenceSubCount:   () => subCount,
    onPresenceUnsubCount: () => unsubCount,
  }
}

function withRoom(room: Room | null, child: ReactElement): ReactElement {
  return (
    <ZeroSyncContext.Provider value={{ room, status: room ? 'connected' : 'connecting' }}>
      {child}
    </ZeroSyncContext.Provider>
  )
}

// ── usePresence ─────────────────────────────────────────────────────────────

function PresenceProbe(): ReactElement {
  const peers = usePresence()
  const entries = Array.from(peers.entries())
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
    .join('|')
  return <span data-testid="peers">{entries || 'empty'}</span>
}

describe('usePresence', () => {
  afterEach(() => cleanup())

  it('returns empty Map outside a provider', () => {
    render(<PresenceProbe />)
    expect(screen.getByTestId('peers').textContent).toBe('empty')
  })

  it('returns empty Map when room is null', () => {
    render(withRoom(null, <PresenceProbe />))
    expect(screen.getByTestId('peers').textContent).toBe('empty')
  })

  it('seeds from room.getPresence() on mount', () => {
    const seed = new Map<string, PresenceState>([
      ['peer-a', { name: 'Alice' }],
    ])
    const mock = createMockRoom(seed)

    render(withRoom(mock.room, <PresenceProbe />))
    expect(screen.getByTestId('peers').textContent).toBe('peer-a:{"name":"Alice"}')
  })

  it('re-renders when room.onPresence fires new snapshot', () => {
    const mock = createMockRoom()
    render(withRoom(mock.room, <PresenceProbe />))
    expect(screen.getByTestId('peers').textContent).toBe('empty')

    act(() => {
      mock.drivePresence(new Map([['peer-b', { cursor: 5 }]]))
    })
    expect(screen.getByTestId('peers').textContent).toBe('peer-b:{"cursor":5}')

    act(() => {
      mock.drivePresence(
        new Map([
          ['peer-b', { cursor: 7 }],
          ['peer-c', { name: 'Charlie' }],
        ]),
      )
    })
    expect(screen.getByTestId('peers').textContent).toBe(
      'peer-b:{"cursor":7}|peer-c:{"name":"Charlie"}',
    )
  })

  it('unsubscribes on unmount', () => {
    const mock = createMockRoom()
    const { unmount } = render(withRoom(mock.room, <PresenceProbe />))
    expect(mock.onPresenceSubCount()).toBe(1)
    expect(mock.onPresenceUnsubCount()).toBe(0)

    unmount()
    expect(mock.onPresenceUnsubCount()).toBe(1)
  })

  it('resubscribes when room changes', () => {
    const mockA = createMockRoom(new Map([['a', { n: 1 }]]))
    const mockB = createMockRoom(new Map([['b', { n: 2 }]]))

    const probe = <PresenceProbe />
    const { rerender } = render(withRoom(mockA.room, probe))
    expect(screen.getByTestId('peers').textContent).toBe('a:{"n":1}')
    expect(mockA.onPresenceSubCount()).toBe(1)

    rerender(withRoom(mockB.room, probe))
    expect(screen.getByTestId('peers').textContent).toBe('b:{"n":2}')
    expect(mockA.onPresenceUnsubCount()).toBe(1)   // old room unsubscribed
    expect(mockB.onPresenceSubCount()).toBe(1)     // new room subscribed
  })
})

// ── useMyPresence ───────────────────────────────────────────────────────────

interface MyShape extends PresenceState { name: string; color?: string }

function MyPresenceProbe({ onReady }: { onReady: (setFn: (s: MyShape) => void) => void }): ReactElement {
  const [state, setMyPresence] = useMyPresence<MyShape>()
  // Expose setter to the test via a stable ref so we can trigger updates.
  const stableSetter = useCallback(
    (s: MyShape) => setMyPresence(s),
    [setMyPresence],
  )
  onReady(stableSetter)
  return <span data-testid="my">{state ? JSON.stringify(state) : 'null'}</span>
}

describe('useMyPresence', () => {
  afterEach(() => cleanup())

  it('initial state is null', () => {
    const mock = createMockRoom()
    render(withRoom(mock.room, <MyPresenceProbe onReady={() => {}} />))
    expect(screen.getByTestId('my').textContent).toBe('null')
  })

  it('setState updates local state and broadcasts via updatePresence', () => {
    const mock = createMockRoom()
    let setPresence: (s: MyShape) => void = () => {}
    render(
      withRoom(
        mock.room,
        <MyPresenceProbe onReady={(fn) => { setPresence = fn }} />,
      ),
    )
    expect(screen.getByTestId('my').textContent).toBe('null')

    act(() => {
      setPresence({ name: 'Alice', color: '#f00' })
    })
    expect(screen.getByTestId('my').textContent).toBe('{"name":"Alice","color":"#f00"}')
    expect(mock.updatePresenceCalls()).toEqual([{ name: 'Alice', color: '#f00' }])
  })

  it('setState does not throw when room is null, and does not broadcast', () => {
    let setPresence: (s: MyShape) => void = () => {}
    render(
      withRoom(null, <MyPresenceProbe onReady={(fn) => { setPresence = fn }} />),
    )

    act(() => {
      setPresence({ name: 'Alice' })
    })
    // Local state still updates — broadcast is skipped (no room).
    expect(screen.getByTestId('my').textContent).toBe('{"name":"Alice"}')
  })

  it('setState identity is stable for a fixed room', () => {
    const mock = createMockRoom()
    let firstSetter: ((s: MyShape) => void) | null = null
    let secondSetter: ((s: MyShape) => void) | null = null

    function CaptureProbe(): ReactElement {
      const [, set] = useMyPresence<MyShape>()
      if (firstSetter === null) firstSetter = set
      else secondSetter = set
      return <span data-testid="captured" />
    }

    const { rerender } = render(withRoom(mock.room, <CaptureProbe />))
    rerender(withRoom(mock.room, <CaptureProbe />))
    expect(firstSetter).toBe(secondSetter)
  })

  it('setState identity changes when room changes', () => {
    const mockA = createMockRoom()
    const mockB = createMockRoom()
    const captured: Array<(s: MyShape) => void> = []

    function CaptureProbe(): ReactElement {
      const [, set] = useMyPresence<MyShape>()
      captured.push(set)
      return <span data-testid="captured" />
    }

    const { rerender } = render(withRoom(mockA.room, <CaptureProbe />))
    rerender(withRoom(mockB.room, <CaptureProbe />))
    const firstForA  = captured[0]
    const latestForB = captured[captured.length - 1]
    expect(firstForA).not.toBe(latestForB)
  })
})
