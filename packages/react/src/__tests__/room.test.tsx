/**
 * Tests for useRoom + useConnectionStatus.
 *
 * Strategy: render a probe component inside ZeroSyncContext.Provider with
 * controlled values (bypassing the async ZeroSyncProvider). This isolates
 * the hook contract from the provider's lifecycle logic (already covered
 * by provider.test.tsx).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { useContext, type ReactElement } from 'react'
import * as Y from 'yjs'

import { ZeroSyncContext, type ZeroSyncContextValue } from '../context.js'
import { useRoom, useConnectionStatus } from '../room.js'
import type { Room } from '@tovsa7/zerosync-client'

// ── helpers ─────────────────────────────────────────────────────────────────

/** Minimal Room stand-in exposing only fields the hooks touch (none — they
 *  just pass the reference through). Cast via unknown to satisfy the type. */
function fakeRoom(): Room {
  return { getDoc: () => new Y.Doc() } as unknown as Room
}

function RoomProbe(): ReactElement {
  const room = useRoom()
  return <span data-testid="room-probe">{room ? 'present' : 'null'}</span>
}

function StatusProbe(): ReactElement {
  const status = useConnectionStatus()
  return <span data-testid="status-probe">{status}</span>
}

function withContext(value: ZeroSyncContextValue, child: ReactElement): ReactElement {
  return <ZeroSyncContext.Provider value={value}>{child}</ZeroSyncContext.Provider>
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('useRoom', () => {
  afterEach(() => cleanup())

  it('returns null outside any provider (default context)', () => {
    render(<RoomProbe />)
    expect(screen.getByTestId('room-probe').textContent).toBe('null')
  })

  it('returns null when context room is null', () => {
    render(withContext({ room: null, status: 'connecting' }, <RoomProbe />))
    expect(screen.getByTestId('room-probe').textContent).toBe('null')
  })

  it('returns the Room when context has one', () => {
    render(withContext({ room: fakeRoom(), status: 'connected' }, <RoomProbe />))
    expect(screen.getByTestId('room-probe').textContent).toBe('present')
  })

  it('re-renders when the context room transitions from null to Room', () => {
    const probe = <RoomProbe />
    const { rerender } = render(withContext({ room: null, status: 'connecting' }, probe))
    expect(screen.getByTestId('room-probe').textContent).toBe('null')

    rerender(withContext({ room: fakeRoom(), status: 'connected' }, probe))
    expect(screen.getByTestId('room-probe').textContent).toBe('present')
  })
})

describe('useConnectionStatus', () => {
  afterEach(() => cleanup())

  it('returns "connecting" outside any provider (default context)', () => {
    render(<StatusProbe />)
    expect(screen.getByTestId('status-probe').textContent).toBe('connecting')
  })

  it('returns the status carried by the context', () => {
    render(withContext({ room: null, status: 'connecting' }, <StatusProbe />))
    expect(screen.getByTestId('status-probe').textContent).toBe('connecting')

    cleanup()
    render(withContext({ room: fakeRoom(), status: 'connected' }, <StatusProbe />))
    expect(screen.getByTestId('status-probe').textContent).toBe('connected')

    cleanup()
    render(withContext({ room: fakeRoom(), status: 'reconnecting' }, <StatusProbe />))
    expect(screen.getByTestId('status-probe').textContent).toBe('reconnecting')

    cleanup()
    render(withContext({ room: null, status: 'closed' }, <StatusProbe />))
    expect(screen.getByTestId('status-probe').textContent).toBe('closed')
  })

  it('re-renders on status transition', () => {
    const probe = <StatusProbe />
    const { rerender } = render(withContext({ room: null, status: 'connecting' }, probe))
    expect(screen.getByTestId('status-probe').textContent).toBe('connecting')

    rerender(withContext({ room: fakeRoom(), status: 'connected' }, probe))
    expect(screen.getByTestId('status-probe').textContent).toBe('connected')

    rerender(withContext({ room: fakeRoom(), status: 'reconnecting' }, probe))
    expect(screen.getByTestId('status-probe').textContent).toBe('reconnecting')

    rerender(withContext({ room: null, status: 'closed' }, probe))
    expect(screen.getByTestId('status-probe').textContent).toBe('closed')
  })
})

describe('Context consumer integration', () => {
  afterEach(() => cleanup())

  it('both hooks read the same context value', () => {
    const room = fakeRoom()

    function Combined(): ReactElement {
      const r = useRoom()
      const s = useConnectionStatus()
      const ctxDirect = useContext(ZeroSyncContext)
      // The two hooks and a direct useContext call must all agree.
      return (
        <div>
          <span data-testid="h-room">{r === ctxDirect.room ? 'match' : 'differ'}</span>
          <span data-testid="h-status">{s === ctxDirect.status ? 'match' : 'differ'}</span>
        </div>
      )
    }

    render(withContext({ room, status: 'connected' }, <Combined />))
    expect(screen.getByTestId('h-room').textContent).toBe('match')
    expect(screen.getByTestId('h-status').textContent).toBe('match')
  })
})
