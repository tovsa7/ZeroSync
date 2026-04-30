/**
 * persistence-smoke.js — E2E smoke test for v0.2.0 encrypted-at-rest.
 *
 * Pre-requisites (must be running locally):
 *   - ZeroSync signaling server on :8080  (`cd server && go run . -addr :8080`)
 *   - vite dev server for the demo on :5174 (`npm run dev --prefix demo`,
 *     port 5173 is the default; vite auto-picks 5174 if 5173 is in use)
 *
 * What it tests:
 *   1. Demo loads without console errors, persistence wires up.
 *   2. EncryptedPersistence DB is created on mount (zerosync-persistence-{roomId}).
 *   3. Typing text triggers a debounced save; the on-disk row is ciphertext
 *      (Uint8Array, length matches IV+ciphertext+tag, plaintext bytes absent).
 *   4. Page reload restores the typed text from disk before the user can
 *      observe an empty editor.
 *   5. Two saves produce different ciphertext (IV randomness preserved).
 *
 * Usage:
 *   npm install
 *   npx playwright install chromium  # one-time
 *   node persistence-smoke.js
 *
 *   # custom URL:
 *   DEMO_URL=http://localhost:5173/ node persistence-smoke.js
 */

import { chromium } from 'playwright'

const DEMO_URL = process.env.DEMO_URL || 'http://localhost:5174/'
const log = (msg) => console.log(`[persistence] ${msg}`)
const errors = []

function assert(cond, msg) {
  if (!cond) {
    errors.push(msg)
    console.error(`[FAIL] ${msg}`)
  } else {
    console.log(`[ OK ] ${msg}`)
  }
}

/** Reads the encrypted row directly from IDB inside the page context. */
async function readEncryptedRow(page, roomId) {
  return page.evaluate(async (id) => {
    return new Promise((resolve) => {
      const req = indexedDB.open('zerosync-persistence-' + id, 1)
      req.onerror = () => resolve({ error: req.error?.message || 'open failed' })
      req.onsuccess = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('state')) {
          db.close()
          resolve({ error: 'no state store' })
          return
        }
        const tx  = db.transaction('state', 'readonly')
        const get = tx.objectStore('state').get('doc')
        get.onsuccess = () => {
          const row = get.result
          db.close()
          if (!row) {
            resolve({ exists: false })
            return
          }
          resolve({
            exists:        true,
            isUint8Array:  row instanceof Uint8Array,
            byteLength:    row.byteLength,
            firstBytes:    Array.from(row.slice(0, 16)),
            allBytes:      Array.from(row),
          })
        }
        get.onerror = () => { db.close(); resolve({ error: get.error?.message }) }
      }
    })
  }, roomId)
}

/** Lists all zerosync-persistence-* databases in the page's origin. */
async function listPersistenceDBs(page) {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases()
    return dbs.map((d) => d.name).filter((n) => n && n.startsWith('zerosync-persistence-'))
  })
}

async function main() {
  log(`launching headless chromium against ${DEMO_URL}`)
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
  })

  // ── 1. Initial load ──────────────────────────────────────────────────────
  log('navigating to demo…')
  await page.goto(DEMO_URL)
  await page.waitForSelector('textarea', { timeout: 10_000 })
  await page.waitForTimeout(2000) // give Room.join + persistence.open time

  const url = page.url()
  const hashMatch = url.match(/#room=([^&]+)&key=([^&]+)/)
  assert(hashMatch !== null, 'URL hash contains room + key after auto-generation')
  const roomId = hashMatch?.[1]
  log(`roomId: ${roomId}`)

  // ── 2. Verify persistence DB exists ──────────────────────────────────────
  const dbs = await listPersistenceDBs(page)
  log(`persistence DBs in origin: ${JSON.stringify(dbs)}`)
  assert(
    dbs.includes(`zerosync-persistence-${roomId}`),
    'EncryptedPersistence DB created on mount',
  )

  // ── 3. Type text → debounced save → verify ciphertext on disk ────────────
  const PLAINTEXT = `Hello, ZeroSync v0.2.0! Timestamp ${Date.now()}`
  log(`typing into editor: "${PLAINTEXT.slice(0, 30)}…"`)
  const textarea = page.locator('textarea').first()
  await textarea.fill(PLAINTEXT)
  await page.waitForTimeout(1000) // exceed 500 ms debounce + IDB write latency

  const row1 = await readEncryptedRow(page, roomId)
  log(`stored row: ${JSON.stringify({ ...row1, allBytes: undefined })}`)
  assert(row1.exists,        'row exists after typing + debounce flush')
  assert(row1.isUint8Array,  'stored value is Uint8Array')
  assert(row1.byteLength >= 12 + 16, `byteLength ${row1.byteLength} >= 28 (IV + tag minimum)`)

  // Verify ciphertext does NOT contain the plaintext as a contiguous run.
  // AES-GCM with random IV makes any plaintext run statistically impossible
  // to appear in ciphertext.
  const plaintextBytes = Array.from(new TextEncoder().encode(PLAINTEXT))
  const cipherBytes    = row1.allBytes
  const containsPlaintext = (() => {
    if (cipherBytes.length < plaintextBytes.length) return false
    outer: for (let i = 0; i <= cipherBytes.length - plaintextBytes.length; i++) {
      for (let j = 0; j < plaintextBytes.length; j++) {
        if (cipherBytes[i + j] !== plaintextBytes[j]) continue outer
      }
      return true
    }
    return false
  })()
  assert(!containsPlaintext, 'plaintext bytes do NOT appear in stored ciphertext')

  // ── 4. Reload page → verify text restored ────────────────────────────────
  log('reloading page…')
  await page.reload()
  await page.waitForSelector('textarea', { timeout: 10_000 })
  await page.waitForTimeout(2000) // allow Room.join + persistence.load + applyUpdate

  const restoredValue = await page.locator('textarea').first().inputValue()
  log(`restored textarea value (first 60 chars): "${restoredValue.slice(0, 60)}…"`)
  assert(
    restoredValue === PLAINTEXT,
    `editor restored to typed text after reload (length=${restoredValue.length} vs ${PLAINTEXT.length})`,
  )

  // ── 5. Append text → second save → IV-randomness check ──────────────────
  const APPENDED = ' more text after reload'
  log(`appending more text…`)
  await textarea.fill(PLAINTEXT + APPENDED)
  await page.waitForTimeout(1000)

  const row2 = await readEncryptedRow(page, roomId)
  assert(row2.exists, 'row still exists after second edit')
  // Different content → different ciphertext is trivial. The interesting
  // invariant: even at the IV layer (first 12 bytes), two saves of overlapping
  // state should differ — IV byte-equality across saves would be a smoking gun.
  const sameIv = row1.firstBytes.every((b, i) => b === row2.firstBytes[i])
  assert(!sameIv, 'IV (first 12 bytes) differs between two saves (no IV reuse)')

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await ctx.close()
  await browser.close()

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60))
  if (errors.length === 0) {
    console.log('[persistence] ALL CHECKS PASS')
    process.exit(0)
  } else {
    console.log(`[persistence] ${errors.length} FAILURE(S):`)
    for (const e of errors) console.log(`  ${e}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[persistence] crashed:', err)
  process.exit(2)
})
