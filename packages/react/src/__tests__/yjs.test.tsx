/**
 * Tests for useYText / useYMap / useYArray.
 *
 * Strategy: render probes inside ZeroSyncContext.Provider with a mock Room
 * that exposes a real Y.Doc. Drive Yjs mutations directly on the doc and
 * assert components re-render with updated state.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useRef, type ReactElement } from 'react'
import * as Y from 'yjs'

import { ZeroSyncContext } from '../context.js'
import { useYText, useYMap, useYArray } from '../yjs.js'
import type { Room } from '@tovsa7/zerosync-client'

// ── helpers ─────────────────────────────────────────────────────────────────

/** Minimal Room stand-in exposing only getDoc (the hooks touch nothing else). */
function createMockRoomWithDoc(doc: Y.Doc = new Y.Doc()): Room {
  return {
    getDoc:               () => doc,
    updatePresence:       () => {},
    onPresence:           () => () => {},
    getPresence:          () => new Map(),
    getConnectionSummary: () => ({ total: 0, p2p: 0 }),
    onStatus:             () => () => {},
    leave:                () => {},
  } as unknown as Room
}

function withRoom(room: Room | null, child: ReactElement): ReactElement {
  return (
    <ZeroSyncContext.Provider value={{ room, status: room ? 'connected' : 'connecting' }}>
      {child}
    </ZeroSyncContext.Provider>
  )
}

// ── useYText ────────────────────────────────────────────────────────────────

function TextProbe({ name }: { name: string }): ReactElement {
  const text = useYText(name)
  const renderCountRef = useRef(0)
  renderCountRef.current++
  return (
    <div>
      <span data-testid="text-exists">{text ? 'yes' : 'no'}</span>
      <span data-testid="text-value">{text?.toString() ?? ''}</span>
      <span data-testid="text-renders">{renderCountRef.current}</span>
    </div>
  )
}

describe('useYText', () => {
  afterEach(() => cleanup())

  it('returns null outside a provider', () => {
    render(<TextProbe name="editor" />)
    expect(screen.getByTestId('text-exists').textContent).toBe('no')
    expect(screen.getByTestId('text-value').textContent).toBe('')
  })

  it('returns null when room is null', () => {
    render(withRoom(null, <TextProbe name="editor" />))
    expect(screen.getByTestId('text-exists').textContent).toBe('no')
  })

  it('returns the Y.Text when room is available', () => {
    const doc = new Y.Doc()
    doc.getText('editor').insert(0, 'hello')
    const room = createMockRoomWithDoc(doc)
    render(withRoom(room, <TextProbe name="editor" />))
    expect(screen.getByTestId('text-exists').textContent).toBe('yes')
    expect(screen.getByTestId('text-value').textContent).toBe('hello')
  })

  it('re-renders when Y.Text is mutated', () => {
    const doc = new Y.Doc()
    const room = createMockRoomWithDoc(doc)
    render(withRoom(room, <TextProbe name="editor" />))
    expect(screen.getByTestId('text-value').textContent).toBe('')

    act(() => {
      doc.getText('editor').insert(0, 'abc')
    })
    expect(screen.getByTestId('text-value').textContent).toBe('abc')

    act(() => {
      doc.getText('editor').insert(3, 'def')
    })
    expect(screen.getByTestId('text-value').textContent).toBe('abcdef')

    act(() => {
      doc.getText('editor').delete(0, 3)
    })
    expect(screen.getByTestId('text-value').textContent).toBe('def')
  })

  it('does not re-render when an unrelated Y type is mutated', () => {
    const doc = new Y.Doc()
    const room = createMockRoomWithDoc(doc)
    render(withRoom(room, <TextProbe name="editor" />))
    const initialRenders = Number(screen.getByTestId('text-renders').textContent)

    act(() => {
      doc.getMap('unrelated').set('k', 1)
    })

    const afterRenders = Number(screen.getByTestId('text-renders').textContent)
    expect(afterRenders).toBe(initialRenders)
  })
})

// ── useYMap ─────────────────────────────────────────────────────────────────

function MapProbe({ name }: { name: string }): ReactElement {
  const map = useYMap<number>(name)
  const entries = map
    ? Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join(',')
    : '(null)'
  return <span data-testid="map">{entries || 'empty'}</span>
}

describe('useYMap', () => {
  afterEach(() => cleanup())

  it('returns null outside provider', () => {
    render(<MapProbe name="data" />)
    expect(screen.getByTestId('map').textContent).toBe('(null)')
  })

  it('returns the Y.Map when room is available', () => {
    const doc = new Y.Doc()
    doc.getMap<number>('data').set('x', 1)
    const room = createMockRoomWithDoc(doc)
    render(withRoom(room, <MapProbe name="data" />))
    expect(screen.getByTestId('map').textContent).toBe('x=1')
  })

  it('re-renders on set / delete', () => {
    const doc = new Y.Doc()
    const room = createMockRoomWithDoc(doc)
    render(withRoom(room, <MapProbe name="data" />))
    expect(screen.getByTestId('map').textContent).toBe('empty')

    act(() => { doc.getMap<number>('data').set('a', 1) })
    expect(screen.getByTestId('map').textContent).toBe('a=1')

    act(() => { doc.getMap<number>('data').set('b', 2) })
    expect(screen.getByTestId('map').textContent).toBe('a=1,b=2')

    act(() => { doc.getMap<number>('data').delete('a') })
    expect(screen.getByTestId('map').textContent).toBe('b=2')
  })
})

// ── useYArray ───────────────────────────────────────────────────────────────

function ArrayProbe({ name }: { name: string }): ReactElement {
  const arr = useYArray<string>(name)
  const value = arr ? arr.toArray().join(',') : '(null)'
  return <span data-testid="arr">{value || 'empty'}</span>
}

describe('useYArray', () => {
  afterEach(() => cleanup())

  it('returns null outside provider', () => {
    render(<ArrayProbe name="items" />)
    expect(screen.getByTestId('arr').textContent).toBe('(null)')
  })

  it('returns the Y.Array when room is available', () => {
    const doc = new Y.Doc()
    doc.getArray<string>('items').push(['a', 'b'])
    const room = createMockRoomWithDoc(doc)
    render(withRoom(room, <ArrayProbe name="items" />))
    expect(screen.getByTestId('arr').textContent).toBe('a,b')
  })

  it('re-renders on push / insert / delete', () => {
    const doc = new Y.Doc()
    const room = createMockRoomWithDoc(doc)
    render(withRoom(room, <ArrayProbe name="items" />))
    expect(screen.getByTestId('arr').textContent).toBe('empty')

    act(() => { doc.getArray<string>('items').push(['a']) })
    expect(screen.getByTestId('arr').textContent).toBe('a')

    act(() => { doc.getArray<string>('items').insert(0, ['z']) })
    expect(screen.getByTestId('arr').textContent).toBe('z,a')

    act(() => { doc.getArray<string>('items').delete(0, 1) })
    expect(screen.getByTestId('arr').textContent).toBe('a')
  })
})

// ── cross-hook ─────────────────────────────────────────────────────────────

describe('useY* hooks — room transition', () => {
  afterEach(() => cleanup())

  it('resubscribes to a new Y.Text when room changes', () => {
    const docA = new Y.Doc(); docA.getText('e').insert(0, 'A')
    const docB = new Y.Doc(); docB.getText('e').insert(0, 'B')
    const roomA = createMockRoomWithDoc(docA)
    const roomB = createMockRoomWithDoc(docB)

    const probe = <TextProbe name="e" />
    const { rerender } = render(withRoom(roomA, probe))
    expect(screen.getByTestId('text-value').textContent).toBe('A')

    rerender(withRoom(roomB, probe))
    expect(screen.getByTestId('text-value').textContent).toBe('B')

    // Mutating docB should now re-render; mutating docA should not.
    act(() => { docB.getText('e').insert(1, 'x') })
    expect(screen.getByTestId('text-value').textContent).toBe('Bx')

    const rendersBefore = Number(screen.getByTestId('text-renders').textContent)
    act(() => { docA.getText('e').insert(1, 'ignored') })
    const rendersAfter = Number(screen.getByTestId('text-renders').textContent)
    expect(rendersAfter).toBe(rendersBefore)
  })
})
