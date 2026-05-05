# Security Policy

## Supported Versions

`@tovsa7/zerosync-client` and `@tovsa7/zerosync-react`:

| Version | Supported |
|---------|-----------|
| 0.2.x (latest) | ✅ Active maintenance + security fixes |
| 0.1.x | 🟡 Security fixes only — please upgrade to 0.2.x |
| < 0.1.0 | ❌ |

The signaling server lives in a separate repository ([github.com/tovsa7/zerosync-self-hosted](https://github.com/tovsa7/zerosync-self-hosted), Apache 2.0) with its own [SECURITY.md](https://github.com/tovsa7/zerosync-self-hosted/blob/main/SECURITY.md). Server vulnerabilities should be reported there.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting:
👉 [Report a vulnerability](https://github.com/tovsa7/ZeroSync/security/advisories/new)

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

We aim to acknowledge reports on a best-effort basis, typically within a few business days. If the issue is confirmed, the workflow is:
1. Fix developed privately
2. Patched version released
3. Public security advisory published

For active exploitation or imminent disclosure pressure, prefix the email subject with `[URGENT]`.

## Security Model

ZeroSync is a zero-knowledge architecture. The signaling server:
- Never holds encryption keys
- Exchanges only signaling metadata between peers (ICE candidates, SDP) — user data flows directly between browsers
- Logs only SHA-256 hashed room/peer IDs
- When direct WebRTC fails (strict NAT, corporate proxy), the server forwards opaque ciphertext blobs in-memory between currently-connected peers — server still cannot decrypt

**Cryptographic primitives:**
- AES-256-GCM (data encryption, Web Crypto API)
- HKDF-SHA-256 (room key derivation)
- HMAC-SHA-256 (message authentication)

A fresh random IV is generated for every encryption call. IV reuse is a critical invariant — any finding related to IV reuse will be treated as high severity.

## Scope

| In scope | Out of scope |
|----------|--------------|
| `@tovsa7/zerosync-client` SDK | Demo application UI bugs |
| `@tovsa7/zerosync-react` hooks | Self-hosted infrastructure config |
| Cryptographic implementation (AES-GCM, HKDF, mutual peer auth) | Third-party dependencies (report upstream) |
| Key derivation logic — wire `roomKey` and at-rest `persistKey` | Signaling server findings — report in [zerosync-self-hosted](https://github.com/tovsa7/zerosync-self-hosted/security) |
| WebRTC transport security | |
| Encrypted-at-rest IndexedDB persistence (v0.2.0+) | |
