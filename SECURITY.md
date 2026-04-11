# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x (latest) | ✅ |
| < 0.1.0 | ❌ |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting:
👉 [Report a vulnerability](https://github.com/tovsa7/ZeroSync/security/advisories/new)

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

You will receive a response within **72 hours**. If the issue is confirmed, we will:
1. Work on a fix privately
2. Release a patched version
3. Publish a security advisory

## Security Model

ZeroSync is a zero-knowledge architecture. The signaling server:
- Never holds encryption keys
- Sees only opaque ciphertext in relay messages
- Logs only SHA-256 hashed room/peer IDs

**Cryptographic primitives:**
- AES-256-GCM (data encryption, Web Crypto API)
- HKDF-SHA-256 (room key derivation)
- HMAC-SHA-256 (message authentication)

A fresh random IV is generated for every encryption call. IV reuse is a critical invariant — any finding related to IV reuse will be treated as high severity.

## Scope

| In scope | Out of scope |
|----------|--------------|
| `@tovsa7/zerosync-client` SDK | Demo application UI bugs |
| Cryptographic implementation | Self-hosted infrastructure config |
| WebRTC transport security | Third-party dependencies (report upstream) |
| Key derivation logic | |
