# Playwright smoke tests

Headless-browser end-to-end checks that complement the unit / property-based test suite. Verifies behaviour against a real signaling server + vite dev demo, in a real browser engine — catching regressions the unit tests can't (DOM listeners, IndexedDB, real timing).

Each test is a single Node.js script with explicit `assert()` calls; readable, no test-framework runtime, no fixtures. They are not part of CI by default — run them locally before pushing significant changes (handshake, persistence, sync) or integrate into CI as needed.

## Tests

| Script | What it verifies |
|--------|------------------|
| `persistence-smoke.js` | v0.2.0 encrypted-at-rest: DB creation, debounced save, ciphertext-on-disk, reload-restore, IV randomness |

## Setup

```bash
cd .playwright-smoke
npm install
npx playwright install chromium  # one-time, ~111 MB
```

## Run persistence smoke

In separate terminals, start the signaling server and the demo:

```bash
# Terminal 1 — signaling server (port 8080 by default)
cd server && go run . -addr :8080

# Terminal 2 — vite dev demo (port 5173 or 5174)
npm run dev --prefix demo
```

Then run the smoke:

```bash
node persistence-smoke.js
# or:
DEMO_URL=http://localhost:5173/ node persistence-smoke.js
```

A successful run ends with:

```
[persistence] ALL CHECKS PASS
```

Exit codes: `0` = all checks pass, `1` = at least one assertion failed, `2` = unhandled crash.

## When to run

- Before any release that touches `persistence.ts`, `crdt.ts`, `room.ts`, or the React `provider.tsx`.
- After changing the demo's storage / persistence wiring.
- When investigating reports of "doc didn't restore on reload" or "text leaked into IDB".
