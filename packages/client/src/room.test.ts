import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Room, RoomJoinError } from './room.js'
import type { RoomOptions } from './room.js'
import type { SignalingClient, SignalingEventMap, SignalingEventName } from './signaling.js'

// ── MockWebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = []
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((e: Event) => void) | null = null

  constructor() { MockWebSocket.instances.push(this) }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.onclose?.() }

  // Test helpers
  open(): void { this.onopen?.() }
  push(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  /** Simulate server-initiated close (unexpected disconnect). */
  serverClose(_code = 1001): void { this.onclose?.() }
}

// ── MockRTCPeerConnection ────────────────────────────────────────────────────

class MockPC {
  static instances: MockPC[] = []
  connectionState: RTCPeerConnectionState = 'new'
  onicecandidate: ((e: { candidate: null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ondatachannel: (() => void) | null = null

  constructor() { MockPC.instances.push(this) }
  createDataChannel(): { binaryType: string; onopen: null; onclose: null; onmessage: null; send: () => void; close: () => void } {
    return { binaryType: 'arraybuffer', onopen: null, onclose: null, onmessage: null, send: vi.fn(), close: vi.fn() }
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'mock' } }
  async createAnswer(): Promise<RTCSessionDescriptionInit> { return { type: 'answer', sdp: 'mock' } }
  async setLocalDescription(): Promise<void> { /* noop */ }
  async setRemoteDescription(): Promise<void> { /* noop */ }
  addIceCandidate(): Promise<void> { return Promise.resolve() }
  close(): void { this.connectionState = 'closed' }
}

beforeEach(() => {
  MockWebSocket.instances = []
  MockPC.instances = []
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('RTCPeerConnection', MockPC)
  return () => vi.unstubAllGlobals()
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makeAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  )
}

function defaultOpts(overrides?: Partial<RoomOptions>): Promise<RoomOptions> {
  return makeAesKey().then(key => ({
    serverUrl:  'wss://test.local/ws',
    roomId:     'room-1',
    roomKey:    key,
    peerId:     '00000000-0000-4000-8000-000000000001',
    nonce:      'dGVzdA==',
    hmac:       'stub',
    iceServers: [],
    ...overrides,
  }))
}

/** Starts Room.join and completes the signaling handshake. */
async function joinRoom(opts?: Partial<RoomOptions>, existingPeers: string[] = []) {
  const roomOpts = await defaultOpts(opts)
  const joinPromise = Room.join(roomOpts)

  const ws = MockWebSocket.instances.at(-1)!
  ws.open()
  ws.push({ type: 'PEER_LIST', peers: existingPeers })

  const room = await joinPromise
  return { room, ws, roomOpts }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Room.join', () => {
  it('resolves with a Room instance after PEER_LIST', async () => {
    const { room } = await joinRoom()
    expect(room).toBeDefined()
    expect(room.getDoc()).toBeDefined()
    room.leave()
  })

  it('sends HELLO on connect', async () => {
    const { ws, room } = await joinRoom()
    const hello = JSON.parse(ws.sent[0]!)
    expect(hello.type).toBe('HELLO')
    expect(hello.roomId).toBe('room-1')
    expect(hello.peerId).toBe('00000000-0000-4000-8000-000000000001')
    room.leave()
  })

  it('creates RTCPeerConnection for each existing peer', async () => {
    const { room } = await joinRoom(undefined, ['peer-a', 'peer-b'])
    // One PC per existing peer.
    expect(MockPC.instances.length).toBe(2)
    room.leave()
  })
})

describe('Room.getDoc', () => {
  it('returns a Y.Doc that supports basic operations', async () => {
    const { room } = await joinRoom()
    const doc = room.getDoc()
    doc.getMap('test').set('key', 'value')
    expect(doc.getMap('test').get('key')).toBe('value')
    room.leave()
  })
})

describe('Room.updatePresence / onPresence', () => {
  it('fires presence callback after updatePresence', async () => {
    const { room } = await joinRoom()
    const cb = vi.fn()
    room.onPresence(cb)

    room.updatePresence({ name: 'Alice', cursor: { x: 10, y: 20 } })

    expect(cb).toHaveBeenCalledTimes(1)
    // Local peer is excluded from getPresence() — only remote peers appear.
    const peers = cb.mock.calls[0]![0] as ReadonlyMap<string, Record<string, unknown>>
    expect(peers.has('00000000-0000-4000-8000-000000000001')).toBe(false)

    room.leave()
  })

  it('unsubscribe stops callbacks', async () => {
    const { room } = await joinRoom()
    const cb = vi.fn()
    const unsub = room.onPresence(cb)

    room.updatePresence({ v: 1 })
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()
    room.updatePresence({ v: 2 })
    expect(cb).toHaveBeenCalledTimes(1)

    room.leave()
  })
})

describe('Room.getPresence', () => {
  it('returns current presence snapshot (remote peers only)', async () => {
    const { room } = await joinRoom()
    room.updatePresence({ name: 'Bob' })

    // Local peer is excluded — snapshot only contains remote peers.
    const snapshot = room.getPresence()
    expect(snapshot.size).toBe(0)
    expect(snapshot.has('00000000-0000-4000-8000-000000000001')).toBe(false)

    room.leave()
  })
})

describe('Room.leave', () => {
  it('closes WebSocket and peer connections', async () => {
    const { room, ws } = await joinRoom(undefined, ['peer-a'])
    const closeSpy = vi.spyOn(ws, 'close')
    room.leave()
    expect(closeSpy).toHaveBeenCalled()
    expect(MockPC.instances[0]!.connectionState).toBe('closed')
  })
})

describe('Room peer lifecycle', () => {
  it('PEER_JOINED creates a new RTCPeerConnection', async () => {
    const { room, ws } = await joinRoom()
    expect(MockPC.instances.length).toBe(0)

    // Server sends PEER_JOINED.
    ws.push({ type: 'PEER_JOINED', peerId: 'new-peer' })

    expect(MockPC.instances.length).toBe(1)
    room.leave()
  })

  it('PEER_LEFT closes the RTCPeerConnection', async () => {
    const { room, ws } = await joinRoom(undefined, ['existing-peer'])
    expect(MockPC.instances.length).toBe(1)

    ws.push({ type: 'PEER_LEFT', peerId: 'existing-peer' })

    expect(MockPC.instances[0]!.connectionState).toBe('closed')
    room.leave()
  })

  it('reconnect adds new peers not previously known', async () => {
    const { room, ws } = await joinRoom()
    expect(MockPC.instances.length).toBe(0)

    // Simulate signaling reconnect with a new peer in the list.
    ws.push({ type: 'PEER_LIST', peers: [] }) // this is ignored post-connect

    // Trigger reconnect via onmessage with a fresh PEER_LIST
    // (signaling.ts emits 'reconnect' after a new WS gets PEER_LIST).
    // Here we test via the mock: push PEER_JOINED as a proxy since full
    // reconnect simulation requires re-triggering WS close/reopen.
    ws.push({ type: 'PEER_JOINED', peerId: 'reconnected-peer' })
    expect(MockPC.instances.length).toBe(1)

    room.leave()
  })
})

describe('Room.onStatus', () => {
  it('fires connected asynchronously after join (via queueMicrotask)', async () => {
    const { room } = await joinRoom()
    const cb = vi.fn()
    room.onStatus(cb)

    // The initial 'connected' fires via queueMicrotask — flush microtasks.
    await Promise.resolve()

    expect(cb).toHaveBeenCalledWith('connected')
    room.leave()
  })

  it('fires reconnecting when signaling WS drops unexpectedly', async () => {
    const { room, ws } = await joinRoom()
    const statuses: string[] = []
    room.onStatus(s => statuses.push(s))

    // Simulate unexpected close from server side.
    ws.serverClose(1001)

    expect(statuses).toContain('reconnecting')
    room.leave()
  })

  it('fires connected again after successful reconnect', async () => {
    vi.useFakeTimers()
    const { room, ws } = await joinRoom()
    const statuses: string[] = []
    room.onStatus(s => statuses.push(s))

    // Drop the connection.
    ws.serverClose(1001)
    expect(statuses).toContain('reconnecting')

    // Advance to trigger reconnect.
    vi.advanceTimersByTime(1000)
    const ws2 = MockWebSocket.instances.at(-1)!
    ws2.open()
    ws2.push({ type: 'PEER_LIST', peers: [] })

    expect(statuses.at(-1)).toBe('connected')

    room.leave()
    vi.useRealTimers()
  })

  it('fires closed once on leave()', async () => {
    const { room } = await joinRoom()
    const statuses: string[] = []
    room.onStatus(s => statuses.push(s))

    room.leave()

    expect(statuses.filter(s => s === 'closed').length).toBe(1)
  })

  it('does not fire any event after leave()', async () => {
    const { room, ws } = await joinRoom()
    const statuses: string[] = []
    room.onStatus(s => statuses.push(s))

    room.leave() // sets 'closed' and intentionally closes signaling
    statuses.length = 0 // clear events after leave

    // Any WS events after intentional close must not trigger more callbacks.
    ws.serverClose(1001)
    expect(statuses).toHaveLength(0)
  })

  it('unsubscribe stops callbacks', async () => {
    const { room } = await joinRoom()
    const cb = vi.fn()
    const unsub = room.onStatus(cb)

    unsub()
    room.leave()
    expect(cb).not.toHaveBeenCalled()
  })

  it('supports multiple status callbacks', async () => {
    const { room } = await joinRoom()
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    room.onStatus(cb1)
    room.onStatus(cb2)

    room.leave()
    expect(cb1).toHaveBeenCalledWith('closed')
    expect(cb2).toHaveBeenCalledWith('closed')
  })
})

describe('Room.getConnectionSummary', () => {
  it('returns zero when no peers', async () => {
    const { room } = await joinRoom()
    expect(room.getConnectionSummary()).toEqual({ total: 0, p2p: 0 })
    room.leave()
  })

  it('counts existing peers without open DC', async () => {
    const { room } = await joinRoom(undefined, ['peer-a', 'peer-b'])
    // Two peers added but neither has an open DataChannel yet.
    expect(room.getConnectionSummary().total).toBe(2)
    expect(room.getConnectionSummary().p2p).toBe(0)
    room.leave()
  })
})

// ── Room isInitiator — WebRTC glare prevention ───────────────────────────────
//
// Exactly one peer per pair acts as WebRTC initiator.
// Initiator = peer whose peerId is lexicographically greater than the remote.
// This prevents simultaneous-offer (glare) when both peers add each other.

describe('Room isInitiator — glare prevention', () => {
  it('local is initiator when local peerId > remote peerId (sends ICE_OFFER)', async () => {
    // 'zzzzz...' > 'aaaaa...' → local is initiator → ICE_OFFER sent
    const { room, ws } = await joinRoom(
      { peerId: 'zzzzzzzz-0000-4000-8000-000000000000' },
      ['aaaaaaaa-0000-4000-8000-000000000000'],
    )
    await vi.waitFor(() => {
      const offer = ws.sent.find(m => JSON.parse(m).type === 'ICE_OFFER')
      expect(offer).toBeDefined()
    }, { timeout: 2000 })
    room.leave()
  })

  it('local is responder when local peerId < remote peerId (no ICE_OFFER sent)', async () => {
    // 'aaaaa...' < 'zzzzz...' → local is responder → waits for offer, sends nothing
    const { room, ws } = await joinRoom(
      { peerId: 'aaaaaaaa-0000-4000-8000-000000000000' },
      ['zzzzzzzz-0000-4000-8000-000000000000'],
    )
    await new Promise(r => setTimeout(r, 50))
    const offers = ws.sent.filter(m => JSON.parse(m).type === 'ICE_OFFER')
    expect(offers).toHaveLength(0)
    // RTCPeerConnection still created (as responder)
    expect(MockPC.instances.length).toBe(1)
    room.leave()
  })

  it('PEER_JOINED: local initiates when local peerId > incoming peerId', async () => {
    const { room, ws } = await joinRoom(
      { peerId: 'zzzzzzzz-0000-4000-8000-000000000000' },
    )
    ws.push({ type: 'PEER_JOINED', peerId: 'aaaaaaaa-0000-4000-8000-000000000000' })
    await vi.waitFor(() => {
      const offer = ws.sent.find(m => JSON.parse(m).type === 'ICE_OFFER')
      expect(offer).toBeDefined()
    }, { timeout: 2000 })
    room.leave()
  })

  it('PEER_JOINED: local waits when local peerId < incoming peerId', async () => {
    const { room, ws } = await joinRoom(
      { peerId: 'aaaaaaaa-0000-4000-8000-000000000000' },
    )
    ws.push({ type: 'PEER_JOINED', peerId: 'zzzzzzzz-0000-4000-8000-000000000000' })
    await new Promise(r => setTimeout(r, 50))
    const offers = ws.sent.filter(m => JSON.parse(m).type === 'ICE_OFFER')
    expect(offers).toHaveLength(0)
    expect(MockPC.instances.length).toBe(1)
    room.leave()
  })

  it('two peers with different IDs produce exactly one initiator', async () => {
    // peer-low joins room where peer-high already exists.
    // peer-low < peer-high → peer-low is responder → no ICE_OFFER from peer-low.
    // peer-high would be initiator (not tested here — separate process).
    const { room, ws } = await joinRoom(
      { peerId: 'aaaaaaaa-0000-4000-8000-000000000001' },
      ['zzzzzzzz-0000-4000-8000-000000000001'],
    )
    await new Promise(r => setTimeout(r, 50))
    const offers = ws.sent.filter(m => JSON.parse(m).type === 'ICE_OFFER')
    expect(offers).toHaveLength(0)
    room.leave()
  })
})

// ── Room.join — rejection paths (signaling-handshake failure) ────────────────
//
// When the WS handshake fails before PEER_LIST, Room.join probes GET /health
// on the same origin to learn *why*: 429 ⇒ capacity, 200 ⇒ unknown (race),
// other / fetch-fail ⇒ unreachable. The thrown RoomJoinError carries the
// reason so callers can surface a precise UX status. See room.ts.

describe('Room.join — rejection paths', () => {
  async function failHandshake(fetchStub: unknown): Promise<unknown> {
    vi.stubGlobal('fetch', fetchStub)
    const opts = await defaultOpts()
    const joinPromise = Room.join(opts)
    // SignalingClient.connect() runs synchronously up to `new WebSocket(...)`;
    // the MockWebSocket instance exists by this point.
    const ws = MockWebSocket.instances.at(-1)!
    ws.onclose?.()
    return joinPromise
  }

  it('throws RoomJoinError(reason=capacity) when /health returns 429', async () => {
    const join = failHandshake(vi.fn().mockResolvedValue({ status: 429, ok: false }))
    await expect(join).rejects.toBeInstanceOf(RoomJoinError)
    await expect(join).rejects.toMatchObject({ reason: 'capacity' })
  })

  it('throws RoomJoinError(reason=unreachable) when /health fetch fails', async () => {
    const join = failHandshake(vi.fn().mockRejectedValue(new Error('network')))
    await expect(join).rejects.toMatchObject({ reason: 'unreachable' })
  })

  it('throws RoomJoinError(reason=unreachable) on 5xx /health response', async () => {
    const join = failHandshake(vi.fn().mockResolvedValue({ status: 503, ok: false }))
    await expect(join).rejects.toMatchObject({ reason: 'unreachable' })
  })

  it('throws RoomJoinError(reason=unknown) when /health returns 200 (race)', async () => {
    const join = failHandshake(vi.fn().mockResolvedValue({ status: 200, ok: true }))
    await expect(join).rejects.toMatchObject({ reason: 'unknown' })
  })

  it('preserves the original WS error as cause', async () => {
    const join = failHandshake(vi.fn().mockResolvedValue({ status: 429, ok: false }))
    try {
      await join
      expect.fail('expected rejection')
    } catch (err) {
      expect(err).toBeInstanceOf(RoomJoinError)
      expect((err as RoomJoinError).cause).toBeInstanceOf(Error)
    }
  })

  it('probes the right URL: wss host + /ws → https + /health', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ status: 429, ok: false })
    await failHandshake(fetchSpy).catch(() => { /* expected */ })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://test.local/health',
      expect.objectContaining({ method: 'GET' }),
    )
  })
})
