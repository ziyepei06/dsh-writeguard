#!/usr/bin/env node
/**
 * wg — the shell side of dsh-writeguard.
 *
 *   node bin/wg.mjs status [--root DIR] [--json]
 *   node bin/wg.mjs lock <path...> [--ttl MINUTES] [--note TEXT] [--root DIR]
 *   node bin/wg.mjs unlock [id...] [--all] [--force] [--root DIR]
 *   node bin/wg.mjs run [--paths a,b] [--ttl MINUTES] [--note TEXT] [--root DIR] -- <command...>
 *   node bin/wg.mjs post <text...> [--kind KIND] [--path PATH] [--root DIR]
 *
 * `run` is the useful one for long jobs: it takes the lease, runs the command,
 * and releases on exit or signal, so a concurrent agent session cannot write
 * into the product directory while `make all` is regenerating it.
 *
 * @module dsh-writeguard/bin/wg
 */

import { spawn } from 'node:child_process'
import os from 'node:os'
import {
  acquire,
  describeLock,
  listLocks,
  normalizePath,
  release,
  resolveLockDir,
} from '../lib/store.js'
import { appendMessage, readMessages, readPresence, writePresence } from '../lib/board.js'

const USAGE = `wg — 跨会话写锁

  wg status [--root DIR] [--json]
  wg lock <path...> [--ttl MINUTES] [--note TEXT] [--root DIR]
  wg unlock [id...] [--all] [--force] [--root DIR]
  wg run [--paths a,b] [--ttl MINUTES] [--note TEXT] [--root DIR] -- <command...>
  wg post <text...> [--kind note|intent|request|reply|handoff|release] [--path PATH]

根目录默认当前目录，锁目录为 <root>/.writeguard。
status 同时显示在场会话与最近留言；post 是 shell 一侧的留言板入口。`

const OWNER = 'cli'
const HOST = os.hostname()

function parse(argv) {
  const options = { root: process.cwd(), ttl: undefined, note: undefined, paths: undefined, json: false, all: false, force: false, kind: undefined, path: undefined }
  const positional = []
  let command = undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      command = argv.slice(i + 1)
      break
    }
    if (arg === '--root' || arg === '--ttl' || arg === '--note' || arg === '--paths' || arg === '--kind' || arg === '--path') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} 需要一个值`)
      i += 1
      if (arg === '--root') options.root = value
      else if (arg === '--ttl') options.ttl = Number(value)
      else if (arg === '--note') options.note = value
      else if (arg === '--kind') options.kind = value
      else if (arg === '--path') options.path = value
      else options.paths = value.split(',').map((item) => item.trim()).filter(Boolean)
      continue
    }
    if (arg === '--json') options.json = true
    else if (arg === '--all') options.all = true
    else if (arg === '--force') options.force = true
    else if (arg.startsWith('--')) throw new Error(`未知选项 ${arg}`)
    else positional.push(arg)
  }
  return { options, positional, command }
}

function lockDir(options) {
  return resolveLockDir(options.root)
}

function ttlMs(options) {
  const minutes = Number.isFinite(options.ttl) && options.ttl !== undefined ? options.ttl : 15
  return Math.min(Math.max(Math.round(minutes), 1), 120) * 60_000
}

function resolveTarget(options, item) {
  return normalizePath(item.startsWith('/') ? item : `${normalizePath(options.root)}/${item}`)
}

function fail(message) {
  process.stderr.write(message + '\n')
  process.exitCode = 1
}

function printLocks(locks) {
  if (locks.length === 0) {
    process.stdout.write('没有有效写锁。\n')
    return
  }
  for (const lock of locks) process.stdout.write('  ' + describeLock(lock) + '\n')
}

async function takeLocks(options, paths) {
  const dir = lockDir(options)
  const held = []
  for (const item of paths) {
    const result = await acquire({
      dir,
      prefix: resolveTarget(options, item),
      owner: OWNER,
      agent: 'cli',
      host: HOST,
      ttlMs: ttlMs(options),
      persistent: true,
      ...(options.note === undefined ? {} : { note: options.note }),
    })
    if (!result.ok) {
      for (const lock of held) release({ dir, ids: [lock.id], owner: OWNER })
      fail(`无法锁定 ${result.conflict.prefix}\n  ${describeLock(result.conflict)}`)
      return undefined
    }
    held.push(result.lock)
  }
  return { dir, held }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(USAGE + '\n')
    return
  }
  const { options, positional, command: child } = parse(rest)

  if (command === 'status') {
    const dir = lockDir(options)
    const prefix = positional[0] === undefined ? undefined : resolveTarget(options, positional[0])
    const locks = listLocks({ dir, ...(prefix === undefined ? {} : { prefix }) })
    if (options.json) {
      process.stdout.write(JSON.stringify({
        locks,
        presence: readPresence(dir),
        messages: readMessages(dir, { limit: 10, ...(prefix === undefined ? {} : { path: prefix }) }),
      }, null, 2) + '\n')
      return
    }
    printLocks(locks)
    const presence = readPresence(dir)
    if (presence.length > 0) {
      process.stdout.write('在场的写者：\n')
      for (const item of presence) {
        process.stdout.write(`  ${item.agent ?? item.owner} (${item.owner}) — ${item.lastSeen}\n`)
      }
    }
    const messages = readMessages(dir, { limit: 5, ...(prefix === undefined ? {} : { path: prefix }) })
    if (messages.length > 0) {
      process.stdout.write('最近留言：\n')
      for (const message of messages) {
        process.stdout.write(`  [${message.ts}] [${message.kind}] ${message.owner}: ${message.text}\n`)
      }
    }
    return
  }

  if (command === 'post') {
    const text = (options.note ?? positional.join(' ')).trim()
    if (text === '') throw new Error('post 需要留言正文')
    const dir = lockDir(options)
    const message = appendMessage(dir, {
      kind: options.kind,
      owner: OWNER,
      agent: 'cli',
      ...(options.path === undefined ? {} : { path: resolveTarget(options, options.path) }),
      text,
    })
    writePresence(dir, { owner: OWNER, agent: 'cli', root: resolveTarget(options, '.') })
    process.stdout.write(`已留言 ${message.id}：${message.text}\n`)
    return
  }

  if (command === 'lock') {
    if (positional.length === 0) throw new Error('lock 需要至少一个路径')
    const taken = await takeLocks(options, positional)
    if (taken === undefined) return
    printLocks(taken.held)
    return
  }

  if (command === 'unlock') {
    const dir = lockDir(options)
    const ids = options.all || positional.length === 0 ? undefined : positional
    if (options.all || positional.length === 0) {
      const result = release({ dir, ...(ids === undefined ? {} : { ids }), owner: OWNER, force: options.force })
      if (result.refused.length > 0) {
        process.stderr.write(`${result.refused.length} 个锁属于其他会话，用 --force 才能强制释放：\n`)
        for (const lock of result.refused) process.stderr.write('  ' + describeLock(lock) + '\n')
        process.exitCode = 1
        return
      }
      process.stdout.write(`已释放 ${result.released.length} 个锁。\n`)
      return
    }
    const result = release({ dir, ids, owner: OWNER, force: options.force })
    process.stdout.write(`已释放 ${result.released.length} 个锁。\n`)
    if (result.refused.length > 0) process.exitCode = 1
    return
  }

  if (command === 'run') {
    if (child === undefined || child.length === 0) throw new Error('run 需要在 -- 之后给出命令')
    const paths = options.paths ?? [normalizePath(options.root)]
    const taken = await takeLocks(options, paths)
    if (taken === undefined) return
    process.stdout.write(`已获锁，开始执行：${child.join(' ')}\n`)
    for (const lock of taken.held) process.stdout.write('  ' + describeLock(lock) + '\n')
    runChild(taken.dir, taken.held, child)
    return
  }

  throw new Error(`未知命令 ${command}`)
}

function runChild(dir, held, argv) {
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', shell: false })
  let finished = false
  const cleanup = () => {
    for (const lock of held) release({ dir, ids: [lock.id], owner: OWNER })
  }
  const forward = (signal) => {
    process.on(signal, () => {
      if (!finished) child.kill(signal)
      cleanup()
      process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
    })
  }
  forward('SIGINT')
  forward('SIGTERM')
  child.on('error', (error) => {
    finished = true
    cleanup()
    process.stderr.write(`无法启动命令：${error.message}\n`)
    process.exit(127)
  })
  child.on('exit', (code, signal) => {
    finished = true
    cleanup()
    if (signal !== null) process.exit(128 + 15)
    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  process.stderr.write(`wg: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
