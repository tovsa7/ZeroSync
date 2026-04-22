# Compliance — ZeroSync

This document maps ZeroSync's architecture to specific regulatory and industry
compliance frameworks. It is intended for buyers performing security /
compliance due diligence on ZeroSync as a component of their own compliance
program.

> **Important disclaimer.** ZeroSync is **not** HIPAA-certified, SOC 2-certified,
> or GDPR-certified. The architecture *supports* customer compliance programs;
> achieving certification is the customer's responsibility. ZeroSync is a
> self-hosted component — customers run the signaling server on their own
> infrastructure, making *them* the data controller and processor. This
> dramatically narrows the vendor's compliance footprint.

---

## Architectural claims

ZeroSync's zero-knowledge server design is the foundation for every claim in
this document:

| Property | Architectural guarantee |
|----------|-------------------------|
| Plaintext data exposure | The server never receives plaintext. All document content is AES-256-GCM-encrypted in the browser before transmission. |
| Key material exposure | Room keys are derived client-side (HKDF-SHA-256) and never transmitted to the server. The server cannot decrypt data — not after a breach, not under legal compulsion. |
| Metadata exposure | Only SHA-256-hashed room IDs and peer IDs appear in server logs. Connection IP addresses are hashed before logging. |
| Retention of content | Zero. The server persists no document content to disk under any circumstance. |
| Retention of metadata | 30 days for hashed connection logs; session-duration + 60 s GC for room/peer registry; 30 s TTL for encrypted relay blobs. |

These guarantees are enforced by code, not policy. The audit path:
`packages/client/src/crypto.ts` · `packages/client/src/transport.ts` · `server/internal/signaling/hash.go` · `server/internal/relay/`.

---

## HIPAA — 45 CFR §164.312 Technical Safeguards

U.S. healthcare covered entities and business associates can use ZeroSync as
part of a HIPAA-compliant real-time collaboration solution. Specific safeguard
support:

### §164.312(a)(1) — Access Control
| Required implementation | ZeroSync support |
|------------------------|------------------|
| Unique user identification | UUIDv4 `peerId` generated client-side per session. Never shared across sessions. |
| Emergency access procedure | Customer responsibility (application-level). |
| Automatic logoff | Customer responsibility (application-level). WebSocket drops after 25 s of no heartbeat; peer evicted automatically. |
| Encryption and decryption | ✅ AES-256-GCM via Web Crypto API. Keys never leave the browser. |

### §164.312(b) — Audit Controls
| Required implementation | ZeroSync support |
|------------------------|------------------|
| Hardware, software, procedural mechanisms that record and examine activity | Server logs connection events (hashed IDs). Customer can enable application-level audit logging on top. See [Audit Trail](#audit-trail) below. |

### §164.312(c)(1) — Integrity
| Required implementation | ZeroSync support |
|------------------------|------------------|
| Protect PHI from improper alteration or destruction | AES-256-GCM is an AEAD cipher — every ciphertext carries an authentication tag. Tampering produces a decryption error; altered data is rejected. Yjs CRDT semantics preserve document history across concurrent edits. |

### §164.312(d) — Person or Entity Authentication
| Required implementation | ZeroSync support |
|------------------------|------------------|
| Verify that a person or entity seeking access is the one claimed | **Peer-to-peer**: AES-GCM challenge-response handshake on WebRTC DataChannel open — proves both peers possess the same room key without transmitting it. **Application-level**: customer responsibility (e.g., OIDC before room join). |

### §164.312(e)(1) — Transmission Security
| Required implementation | ZeroSync support |
|------------------------|------------------|
| Guard against unauthorized access to ePHI transmitted over networks | Dual-layer encryption: AES-256-GCM application layer + DTLS-SRTP (WebRTC) or TLS 1.2+ (relay fallback). Server operators cannot intercept content even with access to TLS private keys. |

**Business Associate Agreement (BAA)**: because ZeroSync is self-hosted, the
vendor (ZeroSync Labs) has no access to customer PHI and is not a HIPAA
business associate in the default deployment model. If a customer operates
their own instance, **they are the HIPAA-covered entity** with full control.
BAA between vendor and customer is therefore unnecessary for self-hosted
deployments.

(An optional managed-hosting offering, when launched, will require a BAA —
this is pending business-operating-entity formation. See [Roadmap](#roadmap).)

---

## GDPR

### Article 25 — Data protection by design and by default
ZeroSync implements data minimization at the architectural level: the
signaling server is structurally incapable of accessing personal data in the
first place. This goes beyond traditional "policy-based" minimization.

- Content: encrypted client-side, never in plaintext at rest or in transit
  past the client
- Identifiers: hashed with SHA-256 before any logging
- Presence data (user names, cursor positions): also end-to-end encrypted
- Retention: bounded by code (30 s relay TTL, 30 d hashed-metadata log, no
  content persistence)

### Article 32 — Security of processing
The pseudonymization and encryption of personal data, plus integrity and
confidentiality, are implemented as follows:

| Art. 32 requirement | ZeroSync implementation |
|--------------------|-------------------------|
| Encryption of personal data | AES-256-GCM, Web Crypto API (no third-party crypto libraries) |
| Pseudonymisation | SHA-256 hashing of all identifiers before logging |
| Confidentiality | AES-256-GCM + TLS (transport) + DTLS (WebRTC) |
| Integrity | AEAD (authenticated encryption) — tampering detected and rejected |
| Availability | Docker health checks, automatic restart, graceful shutdown, GC-based resource bounds |
| Regular testing | 141 unit + property-based tests per release; CI runs tests on every push; OpenSSF Best Practices badge |

### Articles 33–34 — Personal data breach notification
Under GDPR Art. 34, breach notification to data subjects is required if the
breach "is likely to result in a high risk to the rights and freedoms of
natural persons." Art. 34(3)(a) explicitly waives this requirement if:

> "the controller has implemented appropriate technical and organisational
> protection measures, in particular those that render the personal data
> unintelligible to any person who is not authorised to access it, such as
> encryption"

**A signaling server breach exposes only AES-256-GCM ciphertext and
SHA-256-hashed identifiers.** Neither is "intelligible personal data" under
Art. 4(1). The Art. 34 notification obligation therefore typically does not
apply to the server component of a ZeroSync deployment.

### Article 28 — Data processing agreement (DPA)
In the default self-hosted model, **the customer operates the signaling
server**. The customer is therefore both controller and processor for their
own users' data — **no DPA with ZeroSync (vendor) is required**, because the
vendor never processes customer user data.

A DPA template is available for customers who deploy ZeroSync to sign with
*their own* customers (where the customer's customer is the controller).
Request via email.

---

## SOC 2 Trust Service Criteria

SOC 2 audits an organization, not a software product. ZeroSync (the software)
supports SOC 2 Common Criteria via the following architectural properties.
Customers pursuing SOC 2 Type II should map these to their own control set.

| Criterion | ZeroSync architectural support |
|-----------|-------------------------------|
| **CC6.1** Logical access security software, infrastructure, and architectures | AES-GCM mutual peer authentication; non-extractable CryptoKey objects; hashed peer IDs in logs |
| **CC6.6** Implements boundary protection | Signaling server binds only to `127.0.0.1:8080` behind Caddy; TLS-terminated at reverse proxy |
| **CC6.7** Restricts transmission of data to authorized users | AES-256-GCM end-to-end; only key-possessing peers can decrypt |
| **CC7.1** Monitoring of configuration and changes | Docker image provenance via GitHub Actions OIDC (SLSA Level 3 supply chain attestation) |
| **CC7.2** Monitoring for anomalies | Nonce replay protection (30 s window); rate limiting per IP; health endpoint |
| **CC8.1** Change management | All changes reviewed via GitHub PR; CI enforces tests; dependabot for supply chain |

---

## Audit Trail

### Current (v0.1.x)
The signaling server logs operational events for service-reliability purposes:

| Event type | Data logged | Retention |
|-----------|-------------|-----------|
| Connection open/close | SHA-256-hashed client IP, SHA-256-hashed room/peer ID, timestamp | 30 days |
| Room lifecycle (create, GC) | SHA-256-hashed room ID, peer count, timestamp | 30 days |
| Relay blob transit | Size, timestamp (no content ever) | 30 days |
| Authentication failures | Error code, SHA-256-hashed peer ID, timestamp | 30 days |

Logs are written to the container's stderr and rotated by standard logging
drivers. No plaintext identifiers or content appear in logs.

**Important**: server logs are **metadata-only**. They do not constitute an
application-level audit trail (e.g., "user X opened document Y at time Z").
Application-level audit logging is the customer's responsibility; the
customer has access to all plaintext operations in-browser and can log them
via their own backend.

### Planned (Enterprise tier, H1 2027)
Per [ROADMAP](docs/ROADMAP.md) feature 6 — "Enterprise Audit Trail":

- Client-side encrypted append-only event log
- Customer holds the audit encryption key (separate from room keys)
- Events: peer join/leave, room create/delete, document edit timestamps (not content), connection type changes, license validation
- Export formats: JSON Lines, CSV
- Merkle-tree integrity for tamper-evidence
- Opt-in; requires `@tovsa7/zerosync-client` v0.3+ (TBD)

Target release: **H1 2027**. Enterprise tier customers will be notified when
available. No interim product action required — once shipped, customer
integrates the `audit.ts` module; existing deployments continue working
without change.

---

## Roadmap

| Compliance-adjacent feature | Target |
|----------------------------|--------|
| Enterprise Audit Trail (client-side encrypted append-only log) | H1 2027 |
| ECDH invite links (replaces URL-fragment key distribution) | Q4 2026 |
| Post-quantum hybrid crypto (X25519 + ML-KEM-768) | H2 2027 |
| Signed DPA templates (for customer → customer's customer) | On first enterprise inquiry |
| BAA template (for managed-hosting offering, if launched) | Pending entity formation |

See [docs/ROADMAP.md](docs/ROADMAP.md) for full engineering roadmap.

---

## Contact

Security vulnerabilities: see [`/.well-known/security.txt`](https://tovsa7.github.io/ZeroSync/.well-known/security.txt) and [SECURITY.md](SECURITY.md).
Compliance / commercial / enterprise inquiries: <contact.zerosync@proton.me>
Subject line suggestion: `Compliance inquiry — [your industry]`

---

*This document is descriptive, not legal advice. Customers pursuing regulated
workflows should consult their own compliance counsel. ZeroSync Labs makes no
warranty that use of the software ensures compliance with any particular
regulation; use of ZeroSync is one component of a broader compliance program
that remains the customer's responsibility.*

*Last updated: 2026-04-22. Document version: 0.1.*
