/**
 * 协作层的端到端测试：留言板、在场、排队等锁、HTTP 路由。
 *
 *   node dev/board-test.mjs
 *
 * 不依赖 DSH 运行时：用一个最小的 ctx 桩驱动 apply()，直接调用注册上来的
 * 工具与路由处理函数，检查它们对真实文件的读写结果。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendMessage, readMessages, readPresence, writePresence } from '../lib/board.js'
import { apply } from '../index.js'
import { acquire, resolveLockDir } from '../lib/store.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-board-'))
const dir = resolveLockDir(root)
fs.mkdirSync(dir, { recursive: true })

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}

// ── 纯 board 层 ─────────────────────────────────────────────────────────
await check('appendMessage 返回带 id 与 ts 的记录', () => {
  const message = appendMessage(dir, { kind: 'intent', owner: 'a', text: '我要改 benchmark/' })
  assert.match(message.id, /^msg-[0-9a-f]{8}$/)
  assert.equal(message.kind, 'intent')
})

await check('readMessages 按 limit 取最新 N 条', () => {
  for (let i = 0; i < 5; i += 1) appendMessage(dir, { kind: 'note', owner: 'a', text: `第 ${i} 条` })
  const messages = readMessages(dir, { limit: 3 })
  assert.equal(messages.length, 3)
  assert.equal(messages[2].text, '第 4 条')
})

await check('readMessages 的 since 只保留更新留言', () => {
  const all = readMessages(dir, { limit: 10 })
  const marker = all[2].ts
  const newer = readMessages(dir, { since: marker })
  assert.ok(newer.every((message) => Date.parse(message.ts) > Date.parse(marker)))
})

await check('readMessages 的 path 过滤按前缀重叠', () => {
  appendMessage(dir, { kind: 'note', owner: 'b', path: `${root}/benchmark/labels`, text: 'labels 归我' })
  const hits = readMessages(dir, { path: `${root}/benchmark` })
  assert.ok(hits.some((message) => message.text === 'labels 归我'))
  assert.ok(hits.every((message) => message.path === undefined || message.path.startsWith(`${root}/benchmark`)))
})

await check('未知 kind 退化为 note', () => {
  const message = appendMessage(dir, { kind: 'bogus', owner: 'a', text: 'x' })
  assert.equal(message.kind, 'note')
})

await check('writePresence / readPresence 往返', () => {
  writePresence(dir, { owner: 'session-a', agent: 'lead', root, focus: 'benchmark' })
  const live = readPresence(dir)
  assert.equal(live.length, 1)
  assert.equal(live[0].agent, 'lead')
  assert.equal(live[0].focus, 'benchmark')
})

await check('过期 presence 会被清掉', () => {
  const folder = path.join(dir, 'presence')
  fs.writeFileSync(path.join(folder, 'stale.json'), JSON.stringify({
    owner: 'stale',
    lastSeen: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  }))
  const live = readPresence(dir)
  assert.equal(live.length, 1)
  assert.ok(!fs.existsSync(path.join(folder, 'stale.json')))
})

// ── 工具层 ──────────────────────────────────────────────────────────────
const tools = new Map()
const routes = new Map()
const handlers = new Map()
let nextOwner = 'session-me'

const ctx = {
  get(name) {
    if (name === 'workingDirectory') {
      return { ensure: async () => root }
    }
    if (name === 'connection') {
      return {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return async () => {}
          },
        },
      }
    }
    return undefined
  },
  on(event, handler) {
    handlers.set(event, handler)
  },
  effect() {},
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
    },
  },
}

await apply(ctx, { lockDir: '.writeguard' })

const exec = (name, args) => ({
  name,
  arguments: args,
  agent: { session: { id: nextOwner, header: { name: 'lead', cwd: root } } },
})

await check('apply 注册了 6 个工具与两个路由', () => {
  for (const name of [
    'writeguard_lock', 'writeguard_unlock', 'writeguard_status',
    'writeguard_post', 'writeguard_inbox', 'writeguard_wait',
  ]) assert.ok(tools.has(name), name)
  assert.ok(routes.has('/api/writeguard/state'))
  assert.ok(routes.has('/api/writeguard/act'))
})

await check('writeguard_post 写进留言板', async () => {
  const result = await tools.get('writeguard_post').execute(
    { text: '我在改 benchmark/，约 20 分钟', kind: 'intent', path: 'benchmark' },
    exec('writeguard_post'),
  )
  assert.equal(result.message.kind, 'intent')
  assert.equal(result.message.path, path.join(root, 'benchmark'))
})

await check('writeguard_inbox 能读到自己与别人的留言', async () => {
  nextOwner = 'session-other'
  await tools.get('writeguard_post').execute({ text: '收到，我先不动 labels/' }, exec('writeguard_post'))
  nextOwner = 'session-me'
  const result = await tools.get('writeguard_inbox').execute({ limit: 10 }, exec('writeguard_inbox'))
  assert.ok(result.messages.some((message) => message.text.includes('收到')))
})

await check('writeguard_status 返回锁、在场与留言', async () => {
  const result = await tools.get('writeguard_status').execute({}, exec('writeguard_status'))
  assert.ok(Array.isArray(result.locks))
  assert.ok(result.presence.some((item) => item.owner === 'session-me'))
  assert.ok(result.messages.length > 0)
})

await check('writeguard_wait 在锁空闲时立刻成功', async () => {
  const result = await tools.get('writeguard_wait').execute(
    { paths: ['free-dir'], timeoutSeconds: 5 },
    exec('writeguard_wait'),
  )
  assert.equal(result.ok, true)
  assert.equal(result.waitedSeconds, 0)
})

await check('writeguard_wait 超时返回冲突与留言', async () => {
  nextOwner = 'session-blocker'
  const held = await tools.get('writeguard_lock').execute(
    { paths: ['contested'], note: '长任务' },
    exec('writeguard_lock'),
  )
  assert.equal(held.ok, true)
  const started = Date.now()
  nextOwner = 'session-me'
  const result = await tools.get('writeguard_wait').execute(
    { paths: ['contested'], timeoutSeconds: 2 },
    exec('writeguard_wait'),
  )
  assert.equal(result.ok, false)
  assert.ok(Date.now() - started >= 1000)
  assert.equal(result.conflicts.length, 1)
})

await check('writeguard_lock 冲突时会自动在板上留请求', async () => {
  const before = readMessages(dir, { limit: 100 }).length
  await tools.get('writeguard_lock').execute({ paths: ['contested'] }, exec('writeguard_lock'))
  const messages = readMessages(dir, { limit: 100 })
  assert.equal(messages.length, before + 1)
  assert.equal(messages[messages.length - 1].kind, 'request')
  assert.equal(messages[messages.length - 1].to, 'session-blocker')
})

await check('pre-execute 拒绝落在他人锁下的写，并在理由里给沟通出口', async () => {
  const handler = handlers.get('tools/pre-execute')
  const decision = await handler(
    { name: 'write', arguments: { file_path: 'contested/x.md' }, agent: { session: { id: 'session-me', header: { cwd: root } } } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /writeguard_post/)
  assert.match(decision.reason, /writeguard_wait/)
})

await check('pre-execute 放行无锁路径', async () => {
  const handler = handlers.get('tools/pre-execute')
  const decision = await handler(
    { name: 'write', arguments: { file_path: 'free/x.md' }, agent: { session: { id: 'session-me', header: { cwd: root } } } },
    async () => ({ kind: 'allow' }),
  )
  assert.equal(decision.kind, 'allow')
})

// ── HTTP 路由 ───────────────────────────────────────────────────────────
await check('GET /api/writeguard/state 返回根、锁、在场与留言', async () => {
  const route = routes.get('/api/writeguard/state')
  const response = await route.fetch(new Request(`http://127.0.0.1/api/writeguard/state?root=${encodeURIComponent(root)}`))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.roots.length, 1)
  assert.equal(payload.roots[0].root, root)
  assert.ok(payload.roots[0].locks.length >= 1)
  assert.ok(payload.roots[0].messages.length >= 1)
})

await check('POST /api/writeguard/act 留言', async () => {
  const route = routes.get('/api/writeguard/act')
  const response = await route.fetch(new Request('http://127.0.0.1/api/writeguard/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, action: 'post', kind: 'note', text: '从面板发的留言' }),
  }))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.message.owner, 'gui')
})

await check('POST /api/writeguard/act 强制释放锁', async () => {
  const state = await routes.get('/api/writeguard/state')
    .fetch(new Request(`http://127.0.0.1/api/writeguard/state?root=${encodeURIComponent(root)}`))
    .then((response) => response.json())
  const id = state.roots[0].locks[0].id
  const response = await routes.get('/api/writeguard/act').fetch(new Request('http://127.0.0.1/api/writeguard/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, action: 'unlock', id }),
  }))
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.released[0].id, id)
})

await check('POST /api/writeguard/act 拒绝空留言与未知动作', async () => {
  const route = routes.get('/api/writeguard/act')
  const empty = await route.fetch(new Request('http://127.0.0.1/api/writeguard/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, action: 'post', text: '   ' }),
  }))
  assert.equal(empty.status, 400)
  const unknown = await route.fetch(new Request('http://127.0.0.1/api/writeguard/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root, action: 'nope' }),
  }))
  assert.equal(unknown.status, 400)
})

// 收尾：清掉测试留下的锁，避免污染临时目录之外的判断
acquire({ dir: resolveLockDir(root), prefix: path.join(root, 'x'), owner: 'cleanup', ttlMs: 1000 })
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} 项全部通过`)
