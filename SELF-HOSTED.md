# Self-Hosting ZeroSync

Deploy your own ZeroSync signaling server in under 5 minutes using pre-built Docker images. No source code required.

---

## Prerequisites

- A Linux server (Ubuntu 22.04+ recommended) with at least 1 vCPU / 512 MB RAM
- Docker >= 24 and Docker Compose >= 2.20
- A domain with a DNS A record pointing to your server
- Ports 80 and 443 open

---

## Option A — Quick test (no TLS)

Run the server locally for development or testing:

```bash
docker run -p 8080:8080 ghcr.io/tovsa7/zerosync-server:latest
```

Verify it's running:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

Point the SDK at your local server:

```typescript
const room = await Room.join({
  serverUrl:  'ws://localhost:8080/ws',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  // ...
})
```

---

## Option B — Production (TLS)

### Step 1 — Clone the quickstart files

```bash
mkdir zerosync && cd zerosync
curl -O https://raw.githubusercontent.com/tovsa7/ZeroSync/main/self-hosted/docker-compose.yml
curl -O https://raw.githubusercontent.com/tovsa7/ZeroSync/main/self-hosted/Caddyfile
curl -O https://raw.githubusercontent.com/tovsa7/ZeroSync/main/self-hosted/.env.example
cp .env.example .env
```

### Step 2 — Configure your domain

Edit `.env`:

```bash
ZEROSYNC_DOMAIN=sync.example.com   # your domain
```

Make sure your DNS A record for `sync.example.com` points to your server's IP before starting — Caddy needs to complete the ACME challenge.

### Step 3 — Start

```bash
docker compose up -d
```

Caddy automatically obtains a TLS certificate from Let's Encrypt. First startup may take 30–60 seconds.

### Step 4 — Verify

```bash
curl https://sync.example.com/health
# {"status":"ok"}
```

### Step 5 — Connect your app

```typescript
const room = await Room.join({
  serverUrl:  'wss://sync.example.com/ws',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  // ...
})
```

---

## Docker images

| Image | Description |
|-------|-------------|
| `ghcr.io/tovsa7/zerosync-server:latest` | Signaling server (ICE/SDP exchange + in-memory encrypted blob forwarding) |

Multi-arch (`linux/amd64`, `linux/arm64`) built from source on every release.

When direct WebRTC fails (strict NAT, corporate proxy), the signaling server
itself forwards opaque ciphertext blobs (≤64 KB each) between currently
connected peers in the same room. The server never possesses any room key —
it sees only encrypted bytes. Logs use SHA-256-hashed identifiers; no
plaintext IDs are emitted.

---

## License

The signaling server is **Apache 2.0**. Self-host for free, in any
environment, including production. No license keys, no phone-home, no
telemetry, no per-room or per-peer limits enforced at runtime.

The `ZEROSYNC_LICENSE_KEY` and `ZEROSYNC_LICENSE_SECRET` env vars from the
`.env.example` file are reserved for a future enterprise plugin — leave them
empty to run the open-source server. The server starts and runs identically
with or without these set.

A paid enterprise plugin offering admin dashboard, SSO/SAML, audit log
retention, and compliance reports is in development. It will install
alongside the Apache 2.0 server (not replace it) and require a license key
for the plugin's premium features only. Contact
[contact.zerosync@proton.me](mailto:contact.zerosync@proton.me) to be notified
when it ships, or to discuss design-partner terms.

---

## Updating

```bash
docker compose pull
docker compose up -d
```

---

## Troubleshooting

**TLS certificate not issued**  
Ensure ports 80 and 443 are open and DNS is propagated before starting. Check Caddy logs: `docker compose logs caddy`.

**Health check failing**  
Wait 30 seconds after first start for the signaling server to become healthy. Check logs: `docker compose logs zerosync`.

