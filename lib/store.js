/**
 * writeguard lock store — plain filesystem leases, no DSH imports.
 *
 * A lock is one JSON file per prefix under `<root>/.writeguard/locks/`:
 *   { id, prefix, owner, agent, pid, host, createdAt, expiresAt, note }
 *
 * Locks are advisory but enforced by the plugin: a live lock owned by someone
 * else blocks `write`/`edit`/`apply_patch` calls whose target falls under it.
 * Acquisition is serialized with an atomic `mkdir` mutex so two processes
 * cannot both believe they won.
 *
 * @module dsh-writeguard/lib/store
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const LOCK_DIR_NAME = '.writeguard'
const MUTEX_TTL_MS = 10_000
const MUTEX_TIMEOUT_MS = 5_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Absolute, separator-normalized, trailing-slash-free path. */
export function normalizePath(input) {
  const resolved = path.resolve(String(input))
  return resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved
}

/** True when one path is the other or sits beneath it (segment-safe). */
export function overlaps(a, b) {
  if (a === b) return true
  return a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
}

/** Lock directory for a workspace root. */
export function resolveLockDir(root, dirName = LOCK_DIR_NAME) {
  return path.join(normalizePath(root), dirName)
}

function lockDirOf(dir) {
  return path.join(dir, 'locks')
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function pidAlive(pid, host) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  // A lock taken on another machine (shared folder, iCloud) cannot be probed.
  if (host !== undefined && host !== os.hostname()) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * A lock is live while its lease has not expired and its owner process exists.
 * `persistent` locks (a detached `wg lock`) outlive their process by design and
 * are bounded by the lease alone.
 */
export function isLive(lock, now = Date.now()) {
  const expires = Date.parse(lock?.expiresAt ?? '')
  if (!Number.isFinite(expires) || expires <= now) return false
  if (lock?.persistent === true) return true
  return pidAlive(lock?.pid, lock?.host)
}

/**
 * All live locks in a lock directory. Stale lock files are removed on the way.
 * @param dir - the workspace-local `.writeguard` directory.
 * @param now - clock override for tests.
 */
export function readLocks(dir, now = Date.now()) {
  const locks = lockDirOf(dir)
  let names
  try {
    names = fs.readdirSync(locks)
  } catch {
    return []
  }
  const live = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(locks, name)
    const lock = readJson(file)
    if (lock === undefined || !isLive(lock, now)) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* another process pruned it first */
      }
      continue
    }
    live.push(lock)
  }
  live.sort((a, b) => a.prefix.localeCompare(b.prefix))
  return live
}

async function withMutex(dir, body) {
  const locks = lockDirOf(dir)
  fs.mkdirSync(locks, { recursive: true })
  const mutex = path.join(locks, '.mutex')
  const deadline = Date.now() + MUTEX_TIMEOUT_MS
  for (;;) {
    try {
      fs.mkdirSync(mutex)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(mutex).mtimeMs > MUTEX_TTL_MS) fs.rmdirSync(mutex)
      } catch {
        /* the holder released it between stat and rmdir */
      }
      if (Date.now() > deadline) throw new Error('writeguard: lock directory is busy, retry in a moment')
      await sleep(15)
    }
  }
  try {
    return await body()
  } finally {
    try {
      fs.rmdirSync(mutex)
    } catch {
      /* already released */
    }
  }
}

/**
 * Acquire one lease over `prefix`, or report the live lock that blocks it.
 * @param options.dir - workspace-local `.writeguard` directory.
 * @param options.prefix - absolute file or directory the caller intends to write.
 * @param options.owner - stable owner id (session id, or `cli:<pid>`).
 * @param options.ttlMs - lease duration.
 * @param options.note - free-text purpose shown to other writers.
 */
export async function acquire(options) {
  const { dir, ttlMs, note } = options
  const prefix = normalizePath(options.prefix)
  return withMutex(dir, () => {
    const now = Date.now()
    for (const lock of readLocks(dir, now)) {
      if (overlaps(lock.prefix, prefix)) return { ok: false, conflict: lock }
    }
    const lock = {
      id: 'wg-' + crypto.randomBytes(4).toString('hex'),
      prefix,
      owner: options.owner,
      agent: options.agent,
      pid: options.pid ?? process.pid,
      host: options.host ?? os.hostname(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      ...(options.persistent === true ? { persistent: true } : {}),
      ...(note === undefined ? {} : { note }),
    }
    const file = path.join(lockDirOf(dir), lock.id + '.json')
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n')
    fs.renameSync(tmp, file)
    return { ok: true, lock }
  })
}

/**
 * Release leases by id. Only the owner may release; `force` drops ownership
 * checks so a human can clear a lease left by a crashed session.
 */
export function release({ dir, ids, owner, force = false }) {
  const released = []
  const refused = []
  for (const lock of readLocks(dir)) {
    if (ids !== undefined && !ids.includes(lock.id)) continue
    if (!force && lock.owner !== owner) {
      refused.push(lock)
      continue
    }
    try {
      fs.rmSync(path.join(lockDirOf(dir), lock.id + '.json'), { force: true })
      released.push(lock)
    } catch {
      /* already gone */
    }
  }
  return { released, refused }
}

/** Live locks, optionally limited to those overlapping one path. */
export function listLocks({ dir, prefix }) {
  const all = readLocks(dir)
  if (prefix === undefined) return all
  const target = normalizePath(prefix)
  return all.filter((lock) => overlaps(lock.prefix, target))
}

/** One-line human summary of a lock. */
export function describeLock(lock) {
  const who = lock.agent === undefined || lock.agent === lock.owner
    ? lock.owner
    : `${lock.agent} (${lock.owner})`
  const note = lock.note === undefined ? '' : ` · ${lock.note}`
  return `${lock.id} ${lock.prefix} — held by ${who} until ${lock.expiresAt}${note}`
}
