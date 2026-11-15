/**
 * Structural smoke test for the lock store: path overlap, acquire/conflict,
 * ownership, staleness, and the concurrent-acquire race. No DSH runtime needed.
 *
 *   node dev/smoke.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acquire, describeLock, isLive, listLocks, normalizePath, overlaps, readLocks, release, resolveLockDir,
} from '../lib/store.js'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writeguard-smoke-'))
const dir = resolveLockDir(root)
const owner = 'session-a'

// --- path predicates ---
check('normalize strips trailing slash', normalizePath('/a/b/') === '/a/b')
check('overlaps: same path', overlaps('/a/b', '/a/b'))
check('overlaps: child', overlaps('/a/b/c', '/a/b'))
check('overlaps: parent', overlaps('/a/b', '/a/b/c'))
check('overlaps: sibling prefix is not overlap', overlaps('/a/bc', '/a/b') === false)
check('overlaps: unrelated', overlaps('/a/b', '/x/y') === false)

// --- acquire / conflict ---
const first = await acquire({ dir, prefix: path.join(root, 'data'), owner, agent: 'lead', ttlMs: 60_000, note: 'rerun' })
check('first acquire succeeds', first.ok === true, JSON.stringify(first))
check('first acquire is listed', listLocks({ dir }).length === 1)

const samePath = await acquire({ dir, prefix: path.join(root, 'data'), owner: 'session-b', ttlMs: 60_000 })
check('second owner conflicts on same path', samePath.ok === false && samePath.conflict.id === first.lock.id)

const child = await acquire({ dir, prefix: path.join(root, 'data', 'labels', 'x.parquet'), owner: 'session-b', ttlMs: 60_000 })
check('nested path conflicts', child.ok === false)

const sibling = await acquire({ dir, prefix: path.join(root, 'other'), owner: 'session-b', ttlMs: 60_000 })
check('unrelated path acquires', sibling.ok === true)

// --- ownership on release ---
const refused = release({ dir, ids: [first.lock.id], owner: 'session-b' })
check('foreign release is refused', refused.released.length === 0 && refused.refused.length === 1)
const own = release({ dir, ids: [first.lock.id], owner })
check('owner release works', own.released.length === 1)

// --- staleness ---
const stale = path.join(dir, 'locks', 'wg-stale.json')
fs.writeFileSync(stale, JSON.stringify({
  id: 'wg-stale', prefix: path.join(root, 'stale'), owner: 'gone', pid: process.pid,
  host: os.hostname(), createdAt: new Date(0).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(),
}))
check('expired lock is not live', isLive({ expiresAt: new Date(Date.now() - 1000).toISOString(), pid: process.pid }) === false)
const afterStale = await acquire({ dir, prefix: path.join(root, 'stale'), owner: 'session-c', ttlMs: 60_000 })
check('expired lock does not block', afterStale.ok === true)
check('expired lock file was pruned', readLocks(dir).some((lock) => lock.id === 'wg-stale') === false)

const deadFile = path.join(dir, 'locks', 'wg-dead.json')
fs.writeFileSync(deadFile, JSON.stringify({
  id: 'wg-dead', prefix: path.join(root, 'dead'), owner: 'gone', pid: 999_999,
  host: os.hostname(), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
}))
const afterDead = await acquire({ dir, prefix: path.join(root, 'dead'), owner: 'session-c', ttlMs: 60_000 })
check('dead owner does not block', afterDead.ok === true)

// --- concurrent acquire race ---
const raceDir = resolveLockDir(fs.mkdtempSync(path.join(os.tmpdir(), 'writeguard-race-')))
const attempts = await Promise.all(
  Array.from({ length: 12 }, (_, index) => acquire({
    dir: raceDir, prefix: '/race/target', owner: `session-${index}`, ttlMs: 60_000,
  })),
)
const winners = attempts.filter((result) => result.ok)
check('exactly one concurrent acquire wins', winners.length === 1, `winners=${winners.length}`)
check('losers name the winner', attempts.filter((r) => !r.ok).every((r) => r.conflict.id === winners[0].lock.id))

// --- persistent (detached CLI) locks ---
const detatched = await acquire({
  dir, prefix: path.join(root, 'detached'), owner: 'cli', agent: 'cli', pid: 999_999, ttlMs: 60_000, persistent: true,
})
check('persistent lock is acquired', detatched.ok === true)
check('persistent lock survives its dead process', readLocks(dir).some((lock) => lock.id === detatched.lock.id))
const blockedByDetached = await acquire({ dir, prefix: path.join(root, 'detached', 'x'), owner: 'session-d', ttlMs: 60_000 })
check('persistent lock blocks a session', blockedByDetached.ok === false)
check('expired persistent lock stops counting', isLive({ ...detatched.lock, expiresAt: new Date(Date.now() - 1).toISOString() }) === false)

check('describeLock mentions the holder', describeLock(winners[0].lock).includes('session-'))

fs.rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`FAIL (${failures.length}):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log(`ok — ${passed} checks passed`)
