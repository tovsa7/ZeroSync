import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { SignalingClient } from './signaling.js'
import type { ServerMessage } from './signaling.js'

// ── MockWebSocket ─────────────────────────────────────────────────────────────
//
// Controls both sides of a WebSocket connection. Gives tests the ability to:
//   - Inspect messages sent by SignalingClient (via .sent)
//   - Push messages from the "server" (via .push())
//   - Trigger close / error events

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readyState = 1 // OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: ((e: Event) => void) | null = null

  constructor() {
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.onclose?.({ code: 1000, reason: '' })
  }

  // Test helper: simulate a message arriving from the server.
  push(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  // Test helper: simulate server closing the connection.
  serverClose(code = 1001): void {
    this.onclose?.({ code, reason: '' })
  }

  // Trigger onopen asynchronously so SignalingClient can register handlers first.
  open(): void {
    this.onopen?.()
  }
}

// Replace global WebSocket with mock before each test.
beforeEach(() => {
  MockWebSocket.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
  return () => vi.unstubAllGlobals()
})

function lastWS(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1)
  if (!ws) throw new Error('No MockWebSocket created')
  return ws
}

// Creates a connected SignalingClient and returns it + the mock WS.
async function connect(opts?: Partial<Parameters<typeof SignalingClient.connect>[0]>) {
  const promise = SignalingClient.connect({
    serverUrl: 'wss://test.local/ws',
    roomId: 'room-1',
    peerId: '00000000-0000-4000-8000-000000000001',
    nonce: 'dGVzdC1ub25jZQ==',
    hmac: 'stub',
    ...opts,
  })

  const ws = lastWS()
  ws.open()
  ws.push({ type: 'PEER_LIST', peers: ['peer-a', 'peer-b'] })

  const client = await promise
  return { client, ws }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe('SignalingClient.connect', () => {
  it('sends HELLO immediately after WebSocket open', async () => {
    const { ws } = await connect()
    const hello = JSON.parse(ws.sent[0] ?? '{}')
    expect(hello.type).toBe('HELLO')
    expect(hello.roomId).toBe('room-1')
    expect(hello.peerId).toBe('00000000-0000-4000-8000-000000000001')
    expect(hello.nonce).toBe('dGVzdC1ub25jZQ==')
    expect(hello.hmac).toBe('stub')
  })

  it('resolves with initial peer list from PEER_LIST message', async () => {
    const { client } = await connect()
    expect(client.peers()).toEqual(['peer-a', 'peer-b'])
  })

  it('rejects if WebSocket error fires before PEER_LIST', async () => {
    const promise = SignalingClient.connect({
      serverUrl: 'wss://test.local/ws',
      roomId: 'r', peerId: '00000000-0000-4000-8000-000000000001',
      nonce: 'n', hmac: 'h',
    })
    const ws = lastWS()
    ws.onerror?.(new Event('error'))
    await expect(promise).rejects.toThrow()
  })
})

describe('incoming server messages', () => {
  it('emits peerJoined when PEER_JOINED arrives', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('peerJoined', cb)
    ws.push({ type: 'PEER_JOINED', peerId: 'peer-new' })
    expect(cb).toHaveBeenCalledWith({ peerId: 'peer-new' })
  })

  it('emits peerLeft when PEER_LEFT arrives', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('peerLeft', cb)
    ws.push({ type: 'PEER_LEFT', peerId: 'peer-a' })
    expect(cb).toHaveBeenCalledWith({ peerId: 'peer-a' })
  })

  it('emits relayDeliver when RELAY_DELIVER arrives', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('relayDeliver', cb)
    ws.push({ type: 'RELAY_DELIVER', fromPeerId: 'peer-a', payload: 'abc123' })
    expect(cb).toHaveBeenCalledWith({ fromPeerId: 'peer-a', payload: 'abc123' })
  })

  it('emits ice for ICE_OFFER', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('ice', cb)
    ws.push({ type: 'ICE_OFFER', fromPeerId: 'peer-a', roomId: 'room-1', payload: 'sdp...' })
    expect(cb).toHaveBeenCalledWith({ type: 'ICE_OFFER', fromPeerId: 'peer-a', payload: 'sdp...' })
  })

  it('emits ice for ICE_ANSWER', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('ice', cb)
    ws.push({ type: 'ICE_ANSWER', fromPeerId: 'peer-b', roomId: 'room-1', payload: 'ans...' })
    expect(cb).toHaveBeenCalledWith({ type: 'ICE_ANSWER', fromPeerId: 'peer-b', payload: 'ans...' })
  })

  it('emits ice for ICE_CANDIDATE', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('ice', cb)
    ws.push({ type: 'ICE_CANDIDATE', fromPeerId: 'peer-b', roomId: 'room-1', payload: 'cand...' })
    expect(cb).toHaveBeenCalledWith({ type: 'ICE_CANDIDATE', fromPeerId: 'peer-b', payload: 'cand...' })
  })

  it('emits error when ERROR arrives', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('error', cb)
    ws.push({ type: 'ERROR', code: 'ROOM_FULL', message: 'room is full' })
    expect(cb).toHaveBeenCalledWith({ code: 'ROOM_FULL', message: 'room is full' })
  })

  it('does NOT emit close on unexpected server disconnect (reconnects instead)', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    const closeCb = vi.fn()
    client.on('close', closeCb)
    ws.serverClose(1001)
    vi.advanceTimersByTime(60_000)
    expect(closeCb).not.toHaveBeenCalled()
    client.close()
    vi.useRealTimers()
  })

  it('emits close when client.close() is called', async () => {
    const { client } = await connect()
    const cb = vi.fn()
    client.on('close', cb)
    client.close()
    expect(cb).toHaveBeenCalled()
  })

  it('silently ignores malformed JSON', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('error', cb)
    ws.onmessage?.({ data: 'not-json{{{' })
    expect(cb).not.toHaveBeenCalled()
  })

  it('silently ignores unknown message type', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('error', cb)
    ws.onmessage?.({ data: JSON.stringify({ type: 'UNKNOWN_MSG' }) })
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('outgoing messages', () => {
  it('sendRelay sends correctly formatted RELAY message', async () => {
    const { client, ws } = await connect()
    client.sendRelay('room-1', 'base64payload==')
    const msg = JSON.parse(ws.sent.at(-1) ?? '{}')
    expect(msg.type).toBe('RELAY')
    expect(msg.roomId).toBe('room-1')
    expect(msg.payload).toBe('base64payload==')
  })

  it('sendICE sends correctly formatted ICE message', async () => {
    const { client, ws } = await connect()
    client.sendICE('ICE_OFFER', 'room-1', 'peer-target', 'sdp-data')
    const msg = JSON.parse(ws.sent.at(-1) ?? '{}')
    expect(msg.type).toBe('ICE_OFFER')
    expect(msg.roomId).toBe('room-1')
    expect(msg.targetPeerId).toBe('peer-target')
    expect(msg.payload).toBe('sdp-data')
  })

  it('sendPing sends PING message', async () => {
    const { client, ws } = await connect()
    client.sendPing()
    const msg = JSON.parse(ws.sent.at(-1) ?? '{}')
    expect(msg.type).toBe('PING')
  })

  it('close() closes the WebSocket', async () => {
    const { client, ws } = await connect()
    const closeSpy = vi.spyOn(ws, 'close')
    client.close()
    expect(closeSpy).toHaveBeenCalled()
  })
})

describe('ping heartbeat', () => {
  it('sends PING automatically every 25s', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()

    // No PING sent yet (only HELLO).
    const pingSent = () => ws.sent.filter(s => JSON.parse(s).type === 'PING').length
    expect(pingSent()).toBe(0)

    // Advance 25s — first PING should fire.
    vi.advanceTimersByTime(25_000)
    expect(pingSent()).toBe(1)

    // Advance another 25s — second PING.
    vi.advanceTimersByTime(25_000)
    expect(pingSent()).toBe(2)

    client.close()
    vi.useRealTimers()
  })

  it('stops sending PING after close()', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()

    vi.advanceTimersByTime(25_000)
    const countBefore = ws.sent.filter(s => JSON.parse(s).type === 'PING').length
    expect(countBefore).toBe(1)

    client.close()

    vi.advanceTimersByTime(50_000)
    const countAfter = ws.sent.filter(s => JSON.parse(s).type === 'PING').length
    expect(countAfter).toBe(1) // no more PINGs after close

    vi.useRealTimers()
  })
})

// ── Disconnected event ────────────────────────────────────────────────────────

describe('disconnected event', () => {
  it('fires disconnected on unexpected server close', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('disconnected', cb)

    ws.serverClose(1001)

    expect(cb).toHaveBeenCalledOnce()
    client.close()
  })

  it('does NOT fire disconnected on intentional client.close()', async () => {
    const { client } = await connect()
    const cb = vi.fn()
    client.on('disconnected', cb)

    client.close()

    expect(cb).not.toHaveBeenCalled()
  })

  it('fires disconnected on each subsequent unexpected drop', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('disconnected', cb)

    // First drop.
    ws.serverClose(1001)
    expect(cb).toHaveBeenCalledTimes(1)

    // Reconnect succeeds.
    vi.advanceTimersByTime(1000)
    const ws2 = lastWS()
    ws2.open()
    ws2.push({ type: 'PEER_LIST', peers: [] })

    // Second drop.
    ws2.serverClose(1001)
    expect(cb).toHaveBeenCalledTimes(2)

    client.close()
    vi.useRealTimers()
  })

  it('disconnected fires before reconnect (ordering guarantee)', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    const events: string[] = []
    client.on('disconnected', () => events.push('disconnected'))
    client.on('reconnect',    () => events.push('reconnect'))

    ws.serverClose(1001)
    vi.advanceTimersByTime(1000)
    const ws2 = lastWS()
    ws2.open()
    ws2.push({ type: 'PEER_LIST', peers: [] })

    expect(events).toEqual(['disconnected', 'reconnect'])

    client.close()
    vi.useRealTimers()
  })
})

// ── Reconnect tests ───────────────────────────────────────────────────────────

describe('reconnect', () => {
  it('schedules reconnect after unexpected server close', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    client.on('reconnect', vi.fn())

    ws.serverClose(1001)
    expect(MockWebSocket.instances.length).toBe(1) // no immediate reconnect

    vi.advanceTimersByTime(1000)
    expect(MockWebSocket.instances.length).toBe(2) // new WS created

    client.close()
    vi.useRealTimers()
  })

  it('does NOT reconnect after client.close()', async () => {
    vi.useFakeTimers()
    const { client } = await connect()
    client.close()
    vi.advanceTimersByTime(60_000)
    expect(MockWebSocket.instances.length).toBe(1) // no extra WS
    vi.useRealTimers()
  })

  it('emits reconnect event with new peer list after successful reconnect', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('reconnect', cb)

    ws.serverClose(1001)
    vi.advanceTimersByTime(1000)

    const ws2 = lastWS()
    ws2.open()
    ws2.push({ type: 'PEER_LIST', peers: ['peer-x'] })

    expect(cb).toHaveBeenCalledWith({ peers: ['peer-x'] })
    client.close()
    vi.useRealTimers()
  })

  it('updates peers() after reconnect', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()

    ws.serverClose(1001)
    vi.advanceTimersByTime(1000)
    const ws2 = lastWS()
    ws2.open()
    ws2.push({ type: 'PEER_LIST', peers: ['new-peer'] })

    expect(client.peers()).toEqual(['new-peer'])
    client.close()
    vi.useRealTimers()
  })

  it('uses exponential backoff: 1s, 2s, 4s', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    ws.serverClose(1001)

    // attempt 1: 1s
    vi.advanceTimersByTime(999)
    expect(MockWebSocket.instances.length).toBe(1)
    vi.advanceTimersByTime(1)
    expect(MockWebSocket.instances.length).toBe(2)
    lastWS().onerror?.(new Event('error'))

    // attempt 2: 2s
    vi.advanceTimersByTime(1999)
    expect(MockWebSocket.instances.length).toBe(2)
    vi.advanceTimersByTime(1)
    expect(MockWebSocket.instances.length).toBe(3)
    lastWS().onerror?.(new Event('error'))

    // attempt 3: 4s
    vi.advanceTimersByTime(3999)
    expect(MockWebSocket.instances.length).toBe(3)
    vi.advanceTimersByTime(1)
    expect(MockWebSocket.instances.length).toBe(4)

    client.close()
    vi.useRealTimers()
  })

  it('uses a fresh nonce on reconnect (prevents NONCE_REPLAY on server)', async () => {
    // Regression test for: doReconnect() was reusing connectOpts.nonce, causing
    // the server's 30s replay-protection window to reject the reconnect HELLO
    // with NONCE_REPLAY — producing an infinite reconnect loop.
    vi.useFakeTimers()
    const { client, ws } = await connect()

    // Capture the nonce from the original HELLO.
    const originalNonce = (JSON.parse(ws.sent[0]!) as { nonce: string }).nonce
    expect(originalNonce).toBeTruthy()

    // Simulate unexpected server close → schedules reconnect after 1s.
    ws.serverClose(1001)
    vi.advanceTimersByTime(1000)

    // A second WebSocket must have been created.
    const ws2 = lastWS()
    ws2.open() // trigger onopen → HELLO sent

    // The reconnect HELLO must be present.
    expect(ws2.sent.length).toBeGreaterThan(0)
    const reconnectHello = JSON.parse(ws2.sent[0]!) as {
      type: string; nonce: string; roomId: string; peerId: string
    }
    expect(reconnectHello.type).toBe('HELLO')

    // Core assertion: nonce must be different from the original.
    // If it were the same, the server would reply NONCE_REPLAY and the client
    // would never successfully reconnect within the 30s TTL window.
    expect(reconnectHello.nonce).not.toBe(originalNonce)

    // Other identity fields must be preserved across reconnects.
    expect(reconnectHello.roomId).toBe('room-1')
    expect(reconnectHello.peerId).toBe('00000000-0000-4000-8000-000000000001')

    ws2.push({ type: 'PEER_LIST', peers: [] })
    client.close()
    vi.useRealTimers()
  })

  it('resets backoff counter after successful reconnect', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    ws.serverClose(1001)

    vi.advanceTimersByTime(1000)
    const ws2 = lastWS()
    ws2.open()
    ws2.push({ type: 'PEER_LIST', peers: [] })
    // reconnectAttempt reset to 0

    ws2.serverClose(1001)
    vi.advanceTimersByTime(999)
    expect(MockWebSocket.instances.length).toBe(2)
    vi.advanceTimersByTime(1)
    expect(MockWebSocket.instances.length).toBe(3) // 1s again, not 2s

    client.close()
    vi.useRealTimers()
  })

  it('dispatches messages normally after reconnect', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('peerJoined', cb)

    ws.serverClose(1001)
    vi.advanceTimersByTime(1000)
    const ws2 = lastWS()
    ws2.open()
    ws2.push({ type: 'PEER_LIST', peers: [] })
    ws2.push({ type: 'PEER_JOINED', peerId: 'late-peer' })

    expect(cb).toHaveBeenCalledWith({ peerId: 'late-peer' })
    client.close()
    vi.useRealTimers()
  })
})

// ── RELAY_NODES event ────────────────────────────────────────────────────────

describe('RELAY_NODES handling', () => {
  it('emits relayNodes with Set<string> of relay peer IDs', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('relayNodes', cb)

    ws.push({
      type: 'RELAY_NODES',
      peers: [{ peerId: 'relay-1', region: 'eu-de' }],
    } as unknown as ServerMessage)

    expect(cb).toHaveBeenCalledOnce()
    const relayIds: Set<string> = cb.mock.calls[0]![0].relayPeerIds
    expect(relayIds).toBeInstanceOf(Set)
    expect(relayIds.has('relay-1')).toBe(true)
    expect(relayIds.size).toBe(1)
    client.close()
  })

  it('emits relayNodes with empty set when no relays', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('relayNodes', cb)

    ws.push({ type: 'RELAY_NODES', peers: [] } as unknown as ServerMessage)

    expect(cb).toHaveBeenCalledOnce()
    const relayIds: Set<string> = cb.mock.calls[0]![0].relayPeerIds
    expect(relayIds.size).toBe(0)
    client.close()
  })

  it('updates relay set on subsequent RELAY_NODES messages', async () => {
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('relayNodes', cb)

    ws.push({
      type: 'RELAY_NODES',
      peers: [{ peerId: 'relay-1', region: 'eu-de' }],
    } as unknown as ServerMessage)

    ws.push({
      type: 'RELAY_NODES',
      peers: [
        { peerId: 'relay-1', region: 'eu-de' },
        { peerId: 'relay-2', region: 'us-east' },
      ],
    } as unknown as ServerMessage)

    expect(cb).toHaveBeenCalledTimes(2)
    const lastSet: Set<string> = cb.mock.calls[1]![0].relayPeerIds
    expect(lastSet.size).toBe(2)
    expect(lastSet.has('relay-2')).toBe(true)
    client.close()
  })

  it('re-emits last known relay set on reconnect', async () => {
    vi.useFakeTimers()
    const { client, ws } = await connect()
    const cb = vi.fn()
    client.on('relayNodes', cb)

    // Server sends RELAY_NODES.
    ws.push({
      type: 'RELAY_NODES',
      peers: [{ peerId: 'relay-1', region: 'eu-de' }],
    } as unknown as ServerMessage)
    expect(cb).toHaveBeenCalledTimes(1)

    // Disconnect + reconnect.
    ws.serverClose(1001)
    vi.advanceTimersByTime(1000)
    const ws2 = lastWS()
    ws2.open()
    ws2.push({ type: 'PEER_LIST', peers: [] })

    // relayNodes should be re-emitted with the last known set.
    expect(cb).toHaveBeenCalledTimes(2)
    const reEmitted: Set<string> = cb.mock.calls[1]![0].relayPeerIds
    expect(reEmitted.has('relay-1')).toBe(true)

    client.close()
    vi.useRealTimers()
  })

  it('relayPeerIds() returns current set', async () => {
    const { client, ws } = await connect()
    expect(client.relayPeerIds().size).toBe(0)

    ws.push({
      type: 'RELAY_NODES',
      peers: [{ peerId: 'relay-1', region: 'eu-de' }],
    } as unknown as ServerMessage)

    expect(client.relayPeerIds().has('relay-1')).toBe(true)
    client.close()
  })
})

// ── Property-based tests ──────────────────────────────────────────────────────

describe('PBT: message dispatch', () => {
  // Property: every valid server message type reaches exactly the right handler.
  it('∀ server message: dispatched to correct event', async () => {
    const serverMessages: ServerMessage[] = [
      { type: 'PEER_JOINED', peerId: 'p1' },
      { type: 'PEER_LEFT', peerId: 'p2' },
      { type: 'RELAY_DELIVER', fromPeerId: 'p3', payload: 'x' },
      { type: 'ICE_OFFER', fromPeerId: 'p4', roomId: 'r', payload: 'sdp' },
      { type: 'ICE_ANSWER', fromPeerId: 'p5', roomId: 'r', payload: 'ans' },
      { type: 'ICE_CANDIDATE', fromPeerId: 'p6', roomId: 'r', payload: 'cand' },
      { type: 'ERROR', code: 'BAD_REQUEST', message: 'bad' },
      { type: 'PONG' },
    ]

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: serverMessages.length - 1 }),
        async (idx) => {
          const { client, ws } = await connect()

          const eventMap: Record<string, string> = {
            PEER_JOINED: 'peerJoined',
            PEER_LEFT: 'peerLeft',
            RELAY_DELIVER: 'relayDeliver',
            ICE_OFFER: 'ice',
            ICE_ANSWER: 'ice',
            ICE_CANDIDATE: 'ice',
            ERROR: 'error',
            PONG: 'pong',
          }

          const msg = serverMessages[idx]!
          const expectedEvent = eventMap[msg.type]!
          const cb = vi.fn()
          client.on(expectedEvent as Parameters<typeof client.on>[0], cb)

          ws.push(msg)
          expect(cb).toHaveBeenCalledOnce()

          client.close()
        }
      ),
      { numRuns: serverMessages.length }
    )
  })
})
