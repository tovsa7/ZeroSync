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
ZEROSYNC_LICENSE_KEY=              # leave empty for Free tier
ZEROSYNC_LICENSE_SECRET=           # required only with a license key
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
| `ghcr.io/tovsa7/zerosync-server:latest` | Signaling server (ICE/SDP exchange) |

Multi-arch (`linux/amd64`, `linux/arm64`) built from source on every release.

> **Roadmap — encrypted relay fallback**
> A TURN-like relay component for strict NATs is in development. When shipped,
> it will deploy as an additional service (`ghcr.io/tovsa7/zerosync-relay`) in
> the same compose file and forward opaque ciphertext only — the server still
> cannot decrypt.

---

## License tiers

The server runs on the **Free tier** by default (5 rooms, 10 peers/room) — no license key required.

For higher limits, contact [contact.zerosync@proton.me](mailto:contact.zerosync@proton.me) to obtain a license key. Keys are offline-verified JWTs — no network calls, no phone-home.

Set the license in `.env`:

```bash
ZEROSYNC_LICENSE_KEY=eyJ...   # JWT from ZeroSync
ZEROSYNC_LICENSE_SECRET=...   # signing secret provided with your key
```

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

**Server won't start with a license key**  
Verify `ZEROSYNC_LICENSE_SECRET` is set and at least 32 characters. Both variables must be set together.
