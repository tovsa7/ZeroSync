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
ZEROSYNC_LICENSE_KEY=              # leave empty — reserved for future enterprise plugin
ZEROSYNC_LICENSE_SECRET=           # leave empty — reserved for future enterprise plugin
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
| `ghcr.io/tovsa7/zerosync-relay:latest`  | Encrypted relay node — optional, for strict-NAT / corporate-proxy environments where peer-to-peer WebRTC fails |

Multi-arch (`linux/amd64`, `linux/arm64`) built from source on every release.

The relay node joins the signaling server as a special peer of type `"relay"`,
forwards opaque ciphertext blobs (≤64 KB each) between users that cannot
establish direct WebRTC, and never possesses any room key — it sees only
encrypted bytes. Logs use SHA-256-hashed identifiers; no plaintext IDs are
emitted. Health probe at `:8081/health`.

To opt in, add the relay service to your compose file (one process per room
you want covered) and set `SIGNALING_URL` and `ROOM_ID` env vars. Most
deployments do not need this — direct WebRTC works for the majority of NAT
configurations.

---

## License

The signaling server is **Apache 2.0**. The encrypted relay node is **Apache 2.0**.
Self-host both for free, in any environment, including production. No license
keys, no phone-home, no telemetry, no per-room or per-peer limits enforced at
runtime.

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

**Server won't start with a license key**  
Verify `ZEROSYNC_LICENSE_SECRET` is set and at least 32 characters. Both variables must be set together.
