import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { frame, parse, MessageType } from './transport.js'
import { encrypt as cryptoEncrypt } from './crypto.js'

// ── Pure framing functions (no mocks needed) ──────────────────────────────────

const MESSAGE_TYPES = [
  MessageType.UPDATE,
  MessageType.PRESENCE,
  MessageType.SYNC_REQ,
  MessageType.SYNC_RES,
  MessageType.HANDSHAKE_CHALLENGE,
  MessageType.HANDSHAKE_RESPONSE,
] as const

describe('frame / parse', () => {
  it('roundtrip: parse(frame(type, payload)) == { type, payload }', () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const wire = frame(MessageType.UPDATE, payload)
    const result = parse(wire)
    expect(result).not.toBeNull()
    expect(result!.type).toBe(MessageType.UPDATE)
    expect(result!.payload).toEqual(payload)
  })

  it('frame with empty payload', () => {
    const wire = frame(MessageType.SYNC_REQ, new Uint8Array(0))
    const result = parse(wire)
    expect(result!.type).toBe(MessageType.SYNC_REQ)
    expect(result!.payload.length).toBe(0)
  })

  it('parse returns null on empty input', () => {
    expect(parse(new Uint8Array(0))).toBeNull()
  })

  it('frame length is 1 + payload.length', () => {
    const payload = new Uint8Array(50)
    expect(frame(MessageType.PRESENCE, payload).length).toBe(51)
  })

  it('type byte is first byte of wire', () => {
    const wire = frame(MessageType.SYNC_RES, new Uint8Array([9]))
    expect(wire[0]).toBe(MessageType.SYNC_RES)
  })
})

// ── PBT: framing roundtrip ────────────────────────────────────────────────────
//
// ∀ msgType ∈ {0x01..0x06}, payload:
//   parse(frame(msgType, payload)) == (msgType, payload)

describe('PBT: frame / parse', () => {
  it('∀ msgType, payload: parse(frame(msgType, payload)) == (msgType, payload)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MESSAGE_TYPES),
        fc.uint8Array({ minLength: 0, maxLength: 256 }),
        (msgType, payload) => {
          const wire = frame(msgType, payload)
          const result = parse(wire)
          expect(result).not.toBeNull()
          expect(result!.type).toBe(msgType)
          expect(result!.payload).toEqual(payload)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('∀ payload: frame length == 1 + payload.length', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MESSAGE_TYPES),
        fc.uint8Array({ minLength: 0, maxLength: 512 }),
        (msgType, payload) => {
          expect(frame(msgType, payload).length).toBe(1 + payload.length)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('∀ wire with unknown type byte: parse returns it as-is (passthrough)', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        (wire) => {
          // parse must not throw on arbitrary bytes — unknown type is caller's concern
          expect(() => parse(wire)).not.toThrow()
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ── Transport integration (mocked WebRTC + SignalingClient) ───────────────────

// Minimal mock for SignalingClient — only the methods Transport uses.
function makeSignalingMock() {
  return {
    sendRelay: vi.fn(),
    sendICE: vi.fn(),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    peers: vi.fn().mockReturnValue([]),
  }
}

// Minimal mock for RTCPeerConnection.
class MockPC {
  static instances: MockPC[] = []

  localDescription: RTCSessionDescriptionInit | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  connectionState: RTCPeerConnectionState = 'new'

  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ondatachannel: ((e: { channel: MockDC }) => void) | null = null

  private _dc: MockDC | null = null

  constructor() { MockPC.instances.push(this) }

  createDataChannel(_label: string): MockDC {
    this._dc = new MockDC()
    return this._dc
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'mock-sdp-offer' }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'mock-sdp-answer' }
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = desc
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = desc
  }

  addIceCandidate(_c: RTCIceCandidateInit): Promise<void> { return Promise.resolve() }
  close(): void { this.connectionState = 'closed' }

  // Test helper: simulate DC open
  openDataChannel(): void {
    this._dc?.open()
  }

  get dc(): MockDC | null { return this._dc }
}

class MockDC {
  readyState: RTCDataChannelState = 'connecting'
  binaryType = 'arraybuffer'
  sent: ArrayBuffer[] = []

  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null

  send(data: ArrayBuffer): void { this.sent.push(data) }
  close(): void { this.readyState = 'closed'; this.onclose?.() }

  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }

  // Test helper: push incoming data
  receive(data: ArrayBuffer): void {
    this.onmessage?.({ data })
  }
}

beforeEach(() => {
  MockPC.instances = []
  vi.stubGlobal('RTCPeerConnection', MockPC)
  return () => vi.unstubAllGlobals()
})

async function makeAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  )
}

async function makeTransport(overrides?: {
  iceTimeoutMs?:        number
  handshakeTimeoutMs?:  number
  roomKey?:             CryptoKey
  onPeerConnected?:     (peerId: string) => void
  onPeerRelayReady?:    (peerId: string) => void
}) {
  const { Transport } = await import('./transport.js')
  const signaling = makeSignalingMock()

  let iceHandler:   ((e: unknown) => void) | undefined
  let relayHandler: ((e: unknown) => void) | undefined

  signaling.on.mockImplementation((event: string, handler: (e: unknown) => void) => {
    if (event === 'ice')          iceHandler   = handler
    if (event === 'relayDeliver') relayHandler = handler
    return signaling
  })

  const onMessage = vi.fn()
  const roomKey   = overrides?.roomKey ?? {} as CryptoKey

  const transport = new Transport({
    peerId:     'local-peer',
    roomId:     'room-1',
    roomKey,
    iceServers: [],
    signaling: signaling as unknown as import('./signaling.js').SignalingClient,
    onMessage,
    ...(overrides?.onPeerConnected  ? { onPeerConnected:  overrides.onPeerConnected  } : {}),
    ...(overrides?.onPeerRelayReady ? { onPeerRelayReady: overrides.onPeerRelayReady } : {}),
    iceTimeoutMs:       overrides?.iceTimeoutMs       ?? 50,
    handshakeTimeoutMs: overrides?.handshakeTimeoutMs ?? 1000,
  })

  return { transport, signaling, onMessage, iceHandler, relayHandler, MockPC }
}

// ── Handshake helper ──────────────────────────────────────────────────────────

/**
 * Simulates a legitimate remote peer completing the mutual auth handshake.
 *
 * Protocol:
 *   1. Reads transport's HANDSHAKE_CHALLENGE from dc.sent[0].
 *   2. Sends a valid HANDSHAKE_RESPONSE: encrypt(roomKey, theirChallenge).
 *   3. Sends our own HANDSHAKE_CHALLENGE (16 random bytes).
 *   4. Transport verifies response → sets dcReady → calls onPeerConnected.
 *
 * Pass `onPeerConnectedSpy` to additionally wait until dcReady is confirmed
 * (the onPeerConnected callback fires). Required before any sendDC calls.
 */
async function completeHandshake(
  dc: MockDC,
  roomKey: CryptoKey,
  onPeerConnectedSpy?: ReturnType<typeof vi.fn>,
): Promise<void> {
  // 1. Wait for transport's HANDSHAKE_CHALLENGE.
  // NOTE: vi.waitFor retries only when the callback THROWS, not on falsy return.
  // Always use expect() inside vi.waitFor to get retry behavior.
  await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(0) }, { timeout: 2000 })
  const sentChallenge = new Uint8Array(dc.sent[0]!)
  expect(sentChallenge[0]).toBe(MessageType.HANDSHAKE_CHALLENGE)  // 0x05
  const theirChallenge = sentChallenge.slice(1)                   // 16 bytes

  // 2. Respond: encrypt(roomKey, theirChallenge).
  const encryptedResponse = await cryptoEncrypt(roomKey, theirChallenge)
  const responseFrame = new Uint8Array([MessageType.HANDSHAKE_RESPONSE, ...encryptedResponse])
  dc.receive(responseFrame.buffer)

  // 3. Send our challenge.
  const ourChallenge = crypto.getRandomValues(new Uint8Array(16))
  dc.receive(new Uint8Array([MessageType.HANDSHAKE_CHALLENGE, ...ourChallenge]).buffer)

  // 4. Transport will send HANDSHAKE_RESPONSE to our challenge.
  await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThanOrEqual(2) }, { timeout: 2000 })

  // 5. Wait for dcReady to be confirmed via onPeerConnected.
  //    Step 4 resolves when handleChallenge sends its response, but handleResponse
  //    (the decrypt verifying remote's response) may still be pending.
  //    Waiting for the spy guarantees both halves are done.
  if (onPeerConnectedSpy) {
    await vi.waitFor(() => { expect(onPeerConnectedSpy).toHaveBeenCalled() }, { timeout: 2000 })
  }
}

// ── Handshake tests ───────────────────────────────────────────────────────────

describe('Transport handshake — onPeerConnected only fires after mutual auth', () => {
  it('does NOT fire onPeerConnected on DC open alone (before handshake)', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // No handshake yet — must not have fired.
    expect(onPeerConnected).not.toHaveBeenCalled()
    transport.close()
  })

  it('fires onPeerConnected after successful mutual handshake', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    await completeHandshake(dc, key)
    await vi.waitFor(() => expect(onPeerConnected).toHaveBeenCalledWith('remote-peer'))
    transport.close()
  })

  it('sends HANDSHAKE_CHALLENGE (0x05) with 16-byte payload immediately on DC open', async () => {
    const key = await makeAesKey()
    const { transport } = await makeTransport({ roomKey: key })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(0) })
    const sent = new Uint8Array(dc.sent[0]!)
    expect(sent[0]).toBe(0x05)          // HANDSHAKE_CHALLENGE
    expect(sent.length).toBe(1 + 16)    // type byte + 16-byte challenge
    transport.close()
  })
})

describe('Transport handshake — wrong roomKey is rejected', () => {
  it('wrong RESPONSE closes DC and prevents onPeerConnected', async () => {
    const rightKey = await makeAesKey()
    const wrongKey = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: rightKey, onPeerConnected })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // Read transport's challenge.
    await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(0) })
    const theirChallenge = new Uint8Array(dc.sent[0]!).slice(1)

    // Encrypt with WRONG key — transport cannot verify this.
    const wrongResponse = await cryptoEncrypt(wrongKey, theirChallenge)
    dc.receive(new Uint8Array([0x06, ...wrongResponse]).buffer)

    // Also send our challenge (so transport can try to reply).
    dc.receive(new Uint8Array([0x05, ...crypto.getRandomValues(new Uint8Array(16))]).buffer)

    // Transport closes the DC; p2p count stays 0.
    await vi.waitFor(() => { expect(dc.readyState).toBe('closed') }, { timeout: 1000 })
    expect(onPeerConnected).not.toHaveBeenCalled()
    transport.close()
  })
})

describe('Transport handshake — pre-handshake messages discarded', () => {
  it('application messages arriving before handshake are not dispatched', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport, onMessage } = await makeTransport({ roomKey: key, onPeerConnected })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // Wait for CHALLENGE to be sent (DC is open, handshake started).
    await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(0) })

    // Send a valid encrypted application message before handshake completes.
    const encPayload = await cryptoEncrypt(key, new Uint8Array([1, 2, 3]))
    dc.receive(new Uint8Array([MessageType.UPDATE, ...encPayload]).buffer)

    // Give async processing time to run.
    await new Promise(r => setTimeout(r, 50))
    expect(onMessage).not.toHaveBeenCalled()

    // Complete handshake — the pre-handshake message must NOT appear.
    await completeHandshake(dc, key)
    await vi.waitFor(() => expect(onPeerConnected).toHaveBeenCalledWith('remote-peer'))
    expect(onMessage).not.toHaveBeenCalled()
    transport.close()
  })
})

describe('Transport handshake — timeout', () => {
  it('handshake timeout → peer stays relay-only, onPeerConnected never fires', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({
      roomKey: key,
      onPeerConnected,
      handshakeTimeoutMs: 50,   // very short for this test
    })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // Do NOT complete the handshake — let it time out.
    await new Promise(r => setTimeout(r, 150))

    expect(onPeerConnected).not.toHaveBeenCalled()
    expect(transport.getConnectionSummary().p2p).toBe(0)
    transport.close()
  })
})

describe('Transport handshake — PBT', () => {
  it('PBT: correct roomKey always passes handshake; wrong key always fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),  // true = use correct key, false = use wrong key
        async (useCorrectKey) => {
          MockPC.instances = []
          const rightKey = await makeAesKey()
          const wrongKey = await makeAesKey()
          const onPeerConnected = vi.fn()

          const { Transport: Tr } = await import('./transport.js')
          const sig = makeSignalingMock()

          const t = new Tr({
            peerId: 'local', roomId: 'room', roomKey: rightKey,
            iceServers: [],
            signaling: sig as unknown as import('./signaling.js').SignalingClient,
            onMessage: vi.fn(),
            onPeerConnected,
            handshakeTimeoutMs: 500,
          })

          t.addPeer('remote', true)
          await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
          MockPC.instances[0]!.openDataChannel()
          const dc = MockPC.instances[0]!.dc!
          await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

          if (useCorrectKey) {
            await completeHandshake(dc, rightKey, onPeerConnected)
            expect(onPeerConnected).toHaveBeenCalledWith('remote')
          } else {
            // Respond with wrong key — handshake must fail.
            await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(0) })
            const theirChallenge = new Uint8Array(dc.sent[0]!).slice(1)
            const wrongResponse  = await cryptoEncrypt(wrongKey, theirChallenge)
            dc.receive(new Uint8Array([0x06, ...wrongResponse]).buffer)
            dc.receive(new Uint8Array([0x05, ...crypto.getRandomValues(new Uint8Array(16))]).buffer)
            await vi.waitFor(() => { expect(dc.readyState).toBe('closed') }, { timeout: 1000 })
            expect(onPeerConnected).not.toHaveBeenCalled()
          }

          t.close()
          return true
        }
      ),
      { numRuns: 10 }
    )
  })
})

// ── Existing integration tests (updated to complete handshake) ────────────────

describe('Transport.addPeer — initiator', () => {
  it('creates RTCPeerConnection and sends ICE_OFFER via signaling', async () => {
    const { transport, signaling } = await makeTransport()
    transport.addPeer('remote-peer', true)
    await vi.waitFor(() => { expect(signaling.sendICE).toHaveBeenCalledWith(
      'ICE_OFFER', 'room-1', 'remote-peer', 'mock-sdp-offer'
    ) })
    transport.close()
  })
})

describe('Transport.addPeer — responder', () => {
  it('creates RTCPeerConnection and waits for ICE_OFFER', async () => {
    const { transport } = await makeTransport()
    transport.addPeer('remote-peer', false)
    expect(MockPC.instances.length).toBe(1)
    transport.close()
  })
})

describe('Transport relay fallback', () => {
  it('sends via relay when no DataChannel is open (ICE timeout)', async () => {
    const key = await makeAesKey()
    const { transport, signaling } = await makeTransport({ iceTimeoutMs: 10, roomKey: key })
    transport.addPeer('remote-peer', true)

    await new Promise(r => setTimeout(r, 30))

    transport.sendRelay('remote-peer', MessageType.UPDATE, new Uint8Array([1, 2, 3]))
    await vi.waitFor(() => { expect(signaling.sendRelay).toHaveBeenCalled() })
    transport.close()
  })
})

describe('Transport DataChannel send', () => {
  it('sends framed data via DataChannel when open and handshake complete', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // Must complete handshake before sendDC works.
    await completeHandshake(dc, key, onPeerConnected)

    const countBeforeSend = dc.sent.length
    transport.sendDC('remote-peer', MessageType.UPDATE, new Uint8Array([9, 8, 7]))

    await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(countBeforeSend) }, { timeout: 2000 })
    const appMsg = new Uint8Array(dc.sent[dc.sent.length - 1]!)
    expect(appMsg[0]).toBe(MessageType.UPDATE)
    transport.close()
  })
})

describe('Transport.onPeerConnected', () => {
  it('calls onPeerConnected after mutual handshake (not on DC open alone)', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    expect(onPeerConnected).not.toHaveBeenCalled()  // not yet — handshake pending

    await completeHandshake(dc, key, onPeerConnected)
    expect(onPeerConnected).toHaveBeenCalledWith('remote-peer')
    transport.close()
  })

  it('does not call onPeerConnected before DataChannel opens', async () => {
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ onPeerConnected, iceTimeoutMs: 500 })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    expect(onPeerConnected).not.toHaveBeenCalled()
    transport.close()
  })
})

describe('Transport.removePeer', () => {
  it('closes the RTCPeerConnection for that peer', async () => {
    const { transport } = await makeTransport()
    transport.addPeer('remote-peer', true)
    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    transport.removePeer('remote-peer')
    expect(MockPC.instances[0]!.connectionState).toBe('closed')
    transport.close()
  })
})

describe('Transport.getConnectionSummary', () => {
  it('returns total=0, p2p=0 with no peers', async () => {
    const { transport } = await makeTransport()
    expect(transport.getConnectionSummary()).toEqual({ total: 0, p2p: 0 })
    transport.close()
  })

  it('counts peer as total but not p2p before DataChannel opens', async () => {
    const { transport } = await makeTransport({ iceTimeoutMs: 500 })
    transport.addPeer('remote-peer', true)
    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    expect(transport.getConnectionSummary()).toEqual({ total: 1, p2p: 0 })
    transport.close()
  })

  it('counts peer as p2p once DataChannel is open and handshake verified', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // Not p2p yet — handshake pending.
    expect(transport.getConnectionSummary().p2p).toBe(0)

    await completeHandshake(dc, key, onPeerConnected)
    expect(transport.getConnectionSummary()).toEqual({ total: 1, p2p: 1 })
    transport.close()
  })
})

// ── Relay peer tests ─────────────────────────────────────────────────────────

describe('Transport relay peer — skip handshake', () => {
  it('relay peer DataChannel is marked ready without handshake', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })

    // Mark 'relay-peer' as a relay peer.
    transport.updateRelayPeerIds(new Set(['relay-peer']))
    transport.addPeer('relay-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // Relay peer should be marked ready immediately — no handshake needed.
    await vi.waitFor(() => { expect(onPeerConnected).toHaveBeenCalledWith('relay-peer') })

    // No HANDSHAKE_CHALLENGE should have been sent.
    expect(dc.sent.length).toBe(0)
    expect(transport.getConnectionSummary()).toEqual({ total: 1, p2p: 1 })
    transport.close()
  })

  it('regular peer DataChannel still requires handshake', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })

    // Only 'relay-peer' is in relay set, not 'regular-peer'.
    transport.updateRelayPeerIds(new Set(['relay-peer']))
    transport.addPeer('regular-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // Regular peer must NOT be auto-connected — handshake is required.
    expect(onPeerConnected).not.toHaveBeenCalled()

    // HANDSHAKE_CHALLENGE should have been sent.
    await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(0) })
    const sent = new Uint8Array(dc.sent[0]!)
    expect(sent[0]).toBe(MessageType.HANDSHAKE_CHALLENGE)

    transport.close()
  })

  it('relay peer set updates propagate correctly', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })

    // Initially empty relay set.
    transport.updateRelayPeerIds(new Set())
    transport.addPeer('peer-a', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })

    // peer-a is NOT relay → handshake started.
    await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(0) })
    expect(new Uint8Array(dc.sent[0]!)[0]).toBe(MessageType.HANDSHAKE_CHALLENGE)

    // Now update relay set (won't affect already-connected peers, but tests propagation).
    transport.updateRelayPeerIds(new Set(['peer-b']))

    // peer-b added after relay set update → should skip handshake.
    transport.addPeer('peer-b', true)
    await vi.waitFor(() => { expect(MockPC.instances.length).toBe(2) })
    MockPC.instances[1]!.openDataChannel()
    const dc2 = MockPC.instances[1]!.dc!
    await vi.waitFor(() => { expect(dc2.readyState).toBe('open') })

    await vi.waitFor(() => { expect(onPeerConnected).toHaveBeenCalledWith('peer-b') })
    expect(dc2.sent.length).toBe(0) // no handshake for relay

    transport.close()
  })
})

describe('Transport.close — listener cleanup', () => {
  it('off() removes the exact same function references that on() registered', async () => {
    const { transport, signaling } = await makeTransport()
    transport.close()

    expect(signaling.off).toHaveBeenCalledWith('ice', expect.any(Function))
    expect(signaling.off).toHaveBeenCalledWith('relayDeliver', expect.any(Function))

    const onCalls  = signaling.on.mock.calls  as [string, (...a: unknown[]) => void][]
    const offCalls = signaling.off.mock.calls as [string, (...a: unknown[]) => void][]

    const iceOnFn   = onCalls.find(c => c[0] === 'ice')?.[1]
    const iceOffFn  = offCalls.find(c => c[0] === 'ice')?.[1]
    const relayOnFn = onCalls.find(c => c[0] === 'relayDeliver')?.[1]
    const relayOffFn= offCalls.find(c => c[0] === 'relayDeliver')?.[1]

    expect(iceOnFn).toBeDefined()
    expect(iceOnFn).toBe(iceOffFn)
    expect(relayOnFn).toBeDefined()
    expect(relayOnFn).toBe(relayOffFn)
  })
})

// ── Transport.send — DC or relay fallback ─────────────────────────────────────

describe('Transport.send — uses DC when ready, relay otherwise', () => {
  it('send() routes to DataChannel when dcReady', async () => {
    const key = await makeAesKey()
    const onPeerConnected = vi.fn()
    const { transport } = await makeTransport({ roomKey: key, onPeerConnected })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })
    await completeHandshake(dc, key, onPeerConnected)

    const countBefore = dc.sent.length
    transport.send('remote-peer', MessageType.SYNC_REQ, new Uint8Array(0))

    await vi.waitFor(() => { expect(dc.sent.length).toBeGreaterThan(countBefore) }, { timeout: 2000 })
    const msg = new Uint8Array(dc.sent[dc.sent.length - 1]!)
    expect(msg[0]).toBe(MessageType.SYNC_REQ)
    transport.close()
  })

  it('send() falls back to relay when DC not ready (relay-only peer)', async () => {
    const key = await makeAesKey()
    const { transport, signaling } = await makeTransport({ roomKey: key, iceTimeoutMs: 10 })
    transport.addPeer('remote-peer', true)

    // Wait for ICE timeout → relay-only
    await new Promise(r => setTimeout(r, 50))

    transport.send('remote-peer', MessageType.SYNC_REQ, new Uint8Array(0))
    await vi.waitFor(() => { expect(signaling.sendRelay).toHaveBeenCalled() })
    transport.close()
  })

  it('send() for unknown peer does not throw synchronously', async () => {
    const key = await makeAesKey()
    const { transport } = await makeTransport({ roomKey: key })
    expect(() => {
      transport.send('unknown-peer', MessageType.SYNC_REQ, new Uint8Array(0))
    }).not.toThrow()
    transport.close()
  })
})

// ── Transport.onPeerRelayReady ────────────────────────────────────────────────

describe('Transport.onPeerRelayReady', () => {
  it('fires after ICE timeout when DataChannel never opened', async () => {
    const onPeerRelayReady = vi.fn()
    const { transport } = await makeTransport({ iceTimeoutMs: 20, onPeerRelayReady })
    transport.addPeer('remote-peer', true)

    await new Promise(r => setTimeout(r, 80))

    expect(onPeerRelayReady).toHaveBeenCalledWith('remote-peer')
    transport.close()
  })

  it('does NOT fire if DataChannel opens before ICE timeout', async () => {
    const key = await makeAesKey()
    const onPeerRelayReady = vi.fn()
    const onPeerConnected  = vi.fn()
    const { transport } = await makeTransport({
      roomKey:           key,
      onPeerConnected,
      onPeerRelayReady,
      iceTimeoutMs:      500,
      handshakeTimeoutMs: 1000,
    })
    transport.addPeer('remote-peer', true)

    await vi.waitFor(() => { expect(MockPC.instances.length).toBeGreaterThan(0) })
    MockPC.instances[0]!.openDataChannel()
    const dc = MockPC.instances[0]!.dc!
    await vi.waitFor(() => { expect(dc.readyState).toBe('open') })
    await completeHandshake(dc, key, onPeerConnected)

    // DC opened successfully — relay callback must not have fired
    expect(onPeerRelayReady).not.toHaveBeenCalled()
    transport.close()
  })

  it('fires independently for each relay-only peer', async () => {
    const onPeerRelayReady = vi.fn()
    const { transport } = await makeTransport({ iceTimeoutMs: 20, onPeerRelayReady })
    transport.addPeer('peer-a', true)
    transport.addPeer('peer-b', false)

    await new Promise(r => setTimeout(r, 80))

    expect(onPeerRelayReady).toHaveBeenCalledWith('peer-a')
    expect(onPeerRelayReady).toHaveBeenCalledWith('peer-b')
    expect(onPeerRelayReady).toHaveBeenCalledTimes(2)
    transport.close()
  })
})
