/**
 * The coordination layer around the lock store: an append-only board of
 * messages plus per-session presence.
 *
 * Two agent sessions (or one session and a shell) cannot see each other, so
 * every non-trivial multi-writer job needs three things beyond a lock:
 *   - who is here and when they were last active   → presence
 *   - what they are about to do                    → board intents
 *   - a way to ask, answer, and hand off           → board messages
 *
 * The board is one JSONL file so it survives restarts, can be tailed from a
 * shell, and needs no index.
 *
 * @module dsh-writeguard/lib/board
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const KINDS = ['note', 'intent', 'request', 'reply', 'handoff', 'release']
const MAX_BOARD_BYTES = 2 * 1024 * 1024
const KEEP_ON_ROTATE = 1000
const PRESENCE_STALE_MS = 5 * 60 * 1000

export function boardFile(dir) {
  return path.join(dir, 'board.jsonl')
}

export function presenceDir(dir) {
  return path.join(dir, 'presence')
}

function ensure(dir) {
  fs.mkdirSync(path.join(dir, 'presence'), { recursive: true })
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`
}

/** Append one message; returns the stored entry. */
export function appendMessage(dir, entry) {
  ensure(dir)
  const stored = {
    id: newId('msg'),
    ts: new Date().toISOString(),
    kind: KINDS.includes(entry.kind) ? entry.kind : 'note',
    owner: entry.owner,
    ...(entry.agent === undefined ? {} : { agent: entry.agent }),
    ...(entry.path === undefined ? {} : { path: entry.path }),
    ...(entry.to === undefined ? {} : { to: entry.to }),
    ...(entry.lockId === undefined ? {} : { lockId: entry.lockId }),
    text: String(entry.text ?? '').slice(0, 4000),
  }
  const file = boardFile(dir)
  fs.appendFileSync(file, JSON.stringify(stored) + '\n')
  rotateIfLarge(file)
  return stored
}

function rotateIfLarge(file) {
  let size
  try {
    size = fs.statSync(file).size
  } catch {
    return
  }
  if (size <= MAX_BOARD_BYTES) return
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const kept = lines.slice(-KEEP_ON_ROTATE)
    fs.writeFileSync(file, kept.join('\n') + '\n')
  } catch {
    /* rotation is best-effort; a stale large board still reads fine */
  }
}

/**
 * Messages in arrival order.
 * @param options.limit - newest N (default 50).
 * @param options.since - ISO timestamp; only strictly newer messages.
 * @param options.path - only messages whose path overlaps this path.
 */
export function readMessages(dir, options = {}) {
  const file = boardFile(dir)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const messages = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      /* a torn trailing line is skipped, not fatal */
    }
  }
  let filtered = messages
  if (options.since !== undefined) {
    const since = Date.parse(options.since)
    if (Number.isFinite(since)) filtered = filtered.filter((message) => Date.parse(message.ts) > since)
  }
  if (options.path !== undefined) {
    const target = options.path
    filtered = filtered.filter((message) => message.path === undefined
      || message.path === target
      || target.startsWith(message.path.replace(/\/+$/, '') + '/')
      || message.path.startsWith(target.replace(/\/+$/, '') + '/'))
  }
  const limit = Number.isInteger(options.limit) ? options.limit : 50
  return filtered.slice(-limit)
}

/** Record that a session is alive and where it works. */
export function writePresence(dir, entry) {
  ensure(dir)
  const file = path.join(presenceDir(dir), `${sanitize(entry.owner)}.json`)
  const payload = {
    owner: entry.owner,
    ...(entry.agent === undefined ? {} : { agent: entry.agent }),
    ...(entry.root === undefined ? {} : { root: entry.root }),
    ...(entry.focus === undefined ? {} : { focus: entry.focus }),
    lastSeen: new Date().toISOString(),
  }
  const tmp = file + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch {
    /* presence is advisory; never fail a tool call over it */
  }
}

/** Live presences, most recent first; stale files are removed. */
export function readPresence(dir, now = Date.now()) {
  const folder = presenceDir(dir)
  let names
  try {
    names = fs.readdirSync(folder)
  } catch {
    return []
  }
  const live = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = path.join(folder, name)
    let entry
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const seen = Date.parse(entry?.lastSeen ?? '')
    if (!Number.isFinite(seen) || now - seen > PRESENCE_STALE_MS) {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* already gone */
      }
      continue
    }
    live.push(entry)
  }
  live.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
  return live
}

function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
}
