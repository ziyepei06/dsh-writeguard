/**
 * dsh-writeguard — 跨会话的路径租约锁 + 写者之间的协作层。
 *
 * 两个并行的会话（或一个会话加一个 `make` 进程）写同一个目录时，最后一个
 * 写的会静默覆盖前面的结果。只加锁不够：拿到锁的人不知道谁在等，被拒的人
 * 不知道对方在干什么。所以本插件提供三类能力：
 *
 * 1. 锁：模型工具 `writeguard_lock` / `writeguard_unlock` / `writeguard_status`，
 *    以及 `tools/pre-execute` 拦截——目标落在别人活锁下时 `write`/`edit`/`apply_patch` 被拒。
 * 2. 沟通：`writeguard_post` / `writeguard_inbox` 的留言板（note/intent/request/reply/handoff/release）
 *    与 `writeguard_wait` 排队，拒绝理由里直接给出「告诉谁、怎么等」。
 * 3. 界面：`/api/writeguard/state` 与 `/api/writeguard/act` 两个路由，配合 `client.js`
 *    的浮动面板查看在场、锁和留言，并可从浏览器释放锁或留言。
 *
 * 锁是建议性的：它保护调用方，但不会阻止绕过插件的写（例如 shell 重定向）。
 *
 * @module dsh-writeguard
 */

import {
  acquire,
  describeLock,
  listLocks,
  normalizePath,
  overlaps,
  release,
  resolveLockDir,
} from './lib/store.js'
import { appendMessage, readMessages, readPresence, writePresence } from './lib/board.js'

export const name = 'writeguard'

/** Optional services are read through `ctx.get`, so only `tools` is required. */
export const inject = ['tools']

const DEFAULTS = {
  ttlMinutes: 15,
  maxTtlMinutes: 120,
  lockDir: '.writeguard',
  enforce: true,
}

const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch'])
const PRESENCE_THROTTLE_MS = 20_000
const WAIT_POLL_MS = 1_000
const MAX_WAIT_SECONDS = 120

/** Minimal stand-in for `defineTool` when the runtime module is unavailable. */
function plainDefine(definition) {
  const parameters = definition.parameters ?? {}
  const required = Object.keys(parameters).filter((key) => parameters[key]?.required === true)
  const properties = {}
  for (const [key, spec] of Object.entries(parameters)) {
    const { required: _ignored, ...rest } = spec
    properties[key] = rest
  }
  return {
    ...definition,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  }
}

async function loadDefineTool() {
  try {
    const module = await import('@deepseek-ai/dsh-tools')
    if (typeof module.defineTool === 'function') return module.defineTool
  } catch {
    /* the runtime did not expose the package; the structural fallback is enough */
  }
  return plainDefine
}

/** Paths a mutating call will touch, relative to its working directory. */
function targetPaths(exec) {
  const args = exec.arguments ?? {}
  if (exec.name === 'write' || exec.name === 'edit') {
    return typeof args.file_path === 'string' && args.file_path.trim() !== '' ? [args.file_path] : []
  }
  if (exec.name === 'apply_patch') {
    const found = []
    for (const line of String(args.input ?? '').split('\n')) {
      const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
        ?? /^\*\*\* Move to: (.+)$/.exec(line)
      if (match !== null) found.push(match[1].trim())
    }
    return found
  }
  return []
}

async function workingDirectoryOf(ctx, exec) {
  const service = ctx.get('workingDirectory')
  if (service !== undefined && exec.agent !== undefined) {
    try {
      const cwd = await service.ensure(exec.agent, exec.signal)
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch {
      /* fall through to the session header */
    }
  }
  const header = exec.agent?.session?.header
  if (typeof header?.cwd === 'string' && header.cwd !== '') return header.cwd
  return process.cwd()
}

function ownerOf(exec) {
  const id = exec.agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : `pid:${process.pid}`
}

function agentNameOf(exec) {
  const agent = exec.agent
  const value = agent?.name ?? agent?.session?.header?.name
  return typeof value === 'string' && value !== '' ? value : undefined
}

function lockView(lock) {
  return {
    id: lock.id,
    prefix: lock.prefix,
    owner: lock.owner,
    ...(lock.agent === undefined ? {} : { agent: lock.agent }),
    expiresAt: lock.expiresAt,
    ...(lock.note === undefined ? {} : { note: lock.note }),
  }
}

function messageView(message) {
  return {
    id: message.id,
    ts: message.ts,
    kind: message.kind,
    owner: message.owner,
    ...(message.agent === undefined ? {} : { agent: message.agent }),
    ...(message.path === undefined ? {} : { path: message.path }),
    ...(message.to === undefined ? {} : { to: message.to }),
    text: message.text,
  }
}

const LOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    prefix: { type: 'string', required: true },
    owner: { type: 'string', required: true },
    agent: { type: 'string' },
    expiresAt: { type: 'string', required: true },
    note: { type: 'string' },
  },
}

const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    ts: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    owner: { type: 'string', required: true },
    agent: { type: 'string' },
    path: { type: 'string' },
    to: { type: 'string' },
    text: { type: 'string', required: true },
  },
}

const PRESENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owner: { type: 'string', required: true },
    agent: { type: 'string' },
    root: { type: 'string' },
    focus: { type: 'string' },
    lastSeen: { type: 'string', required: true },
  },
}

/** Human-readable "who holds what" line used in denials and status output. */
function holderOf(lock) {
  return lock.agent === undefined || lock.agent === lock.owner
    ? lock.owner
    : `${lock.agent} (${lock.owner})`
}

export async function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const lockDir = String(cfg.lockDir ?? DEFAULTS.lockDir)
  const ttlMinutes = clampTtl(cfg.ttlMinutes, cfg.maxTtlMinutes)
  const defineTool = await loadDefineTool()

  const lockDirFor = (cwd) => resolveLockDir(cwd, lockDir)
  const knownRoots = new Set()
  const lastSeenAt = new Map()

  const remember = (cwd) => {
    if (typeof cwd === 'string' && cwd !== '') knownRoots.add(normalizePath(cwd))
  }

  /** Denial reason for one call, or undefined when it may proceed. */
  async function violation(exec) {
    if (cfg.enforce === false) return undefined
    if (!MUTATING_TOOLS.has(exec.name)) return undefined
    const raw = targetPaths(exec)
    if (raw.length === 0) return undefined
    const cwd = await workingDirectoryOf(ctx, exec)
    remember(cwd)
    const owner = ownerOf(exec)
    const dir = lockDirFor(cwd)
    for (const item of raw) {
      const target = normalizePath(item.startsWith('/') ? item : `${cwd}/${item}`)
      for (const lock of listLocks({ dir })) {
        if (lock.owner === owner || !overlaps(lock.prefix, target)) continue
        const waiting = readMessages(dir, { path: target, limit: 5 })
          .filter((message) => message.kind === 'request' || message.kind === 'intent')
        return [
          `writeguard: ${target} 位于另一个会话持有的写锁下，本次 ${exec.name} 已拒绝。`,
          `  持有者: ${holderOf(lock)}`,
          `  锁定范围: ${lock.prefix}`,
          ...(lock.note === undefined ? [] : [`  用途: ${lock.note}`]),
          `  到期: ${lock.expiresAt}`,
          ...(waiting.length === 0 ? [] : ['  该路径最近的沟通:', ...waiting.map((message) => `    [${message.kind}] ${message.owner}: ${message.text}`)]),
          '',
          '先确认对方的改动是否已完成；需要接手时让对方调用 writeguard_unlock，',
          '或人工执行 `node bin/wg.mjs unlock --force ' + lock.id + '`。',
          '需要沟通时用 writeguard_post 给对方留言（kind=request 表示请求让出），',
          '或用 writeguard_wait 排队等锁释放。不要绕过本工具继续写。',
        ].join('\n')
      }
    }
    return undefined
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = await violation(exec)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  })

  // ── 在场心跳：任何会话的活动都会刷新自己的 presence ────────────────────
  ctx.on('session/event', (session) => {
    try {
      const owner = session?.id
      if (typeof owner !== 'string' || owner === '') return
      const now = Date.now()
      const previous = lastSeenAt.get(owner) ?? 0
      if (now - previous < PRESENCE_THROTTLE_MS) return
      lastSeenAt.set(owner, now)
      const cwd = session?.header?.cwd
      remember(cwd)
      const root = typeof cwd === 'string' && cwd !== '' ? normalizePath(cwd) : undefined
      if (root === undefined) return
      writePresence(lockDirFor(root), {
        owner,
        agent: session?.header?.name,
        root,
      })
    } catch {
      /* presence is advisory */
    }
  })

  async function notePresence(dir, root, exec) {
    writePresence(dir, {
      owner: ownerOf(exec),
      agent: agentNameOf(exec),
      root,
    })
  }

  ctx.tools.register(defineTool({
    name: 'writeguard_lock',
    description: '先占住一组路径的跨会话写锁，再动手改。'
      + '当你要批量改同一目录里的多个文件、或让长任务在一段时间内独占产物目录时使用；'
      + '锁有租期，到期自动失效，进程退出也会被回收。'
      + '路径与租期冲突时本工具失败并返回持有者；可先 writeguard_post 留言或用 writeguard_wait 排队，不要绕过它直接写。',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '要锁住的文件或目录，相对于会话工作目录；目录会覆盖其下所有文件。',
      },
      ttlMinutes: {
        type: 'number',
        description: `租期分钟数，默认 ${ttlMinutes}，上限 ${cfg.maxTtlMinutes}；长任务请留足时间。`,
      },
      note: {
        type: 'string',
        description: '给其他写者看的用途说明，例如「重跑 benchmark 全流程」。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          locks: { type: 'array', required: true, items: LOCK_SCHEMA },
          conflicts: { type: 'array', required: true, items: LOCK_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `已获锁：\n${value.locks.map((lock) => '  ' + describeLock(lock)).join('\n')}`
          : `未能获锁：\n${value.conflicts.map((lock) => '  ' + describeLock(lock)).join('\n')}`,
      }],
    },
    async execute(args, exec) {
      const cwd = await workingDirectoryOf(ctx, exec)
      remember(cwd)
      const dir = lockDirFor(cwd)
      const ttl = clampTtl(args.ttlMinutes ?? ttlMinutes, cfg.maxTtlMinutes)
      const locks = []
      const conflicts = []
      for (const item of args.paths) {
        const prefix = item.startsWith('/') ? item : `${cwd}/${item}`
        const result = await acquire({
          dir,
          prefix,
          owner: ownerOf(exec),
          agent: agentNameOf(exec),
          ttlMs: ttl * 60_000,
          ...(args.note === undefined ? {} : { note: args.note }),
        })
        if (result.ok) locks.push(result.lock)
        else conflicts.push(result.conflict)
      }
      if (conflicts.length > 0) {
        const target = conflicts[0].prefix
        appendMessage(dir, {
          kind: 'request',
          owner: ownerOf(exec),
          agent: agentNameOf(exec),
          path: target,
          to: conflicts[0].owner,
          text: args.note === undefined
            ? `请求让出 ${target}` : `请求让出 ${target}：${args.note}`,
        })
      }
      await notePresence(dir, cwd, exec)
      return { ok: conflicts.length === 0, locks: locks.map(lockView), conflicts: conflicts.map(lockView) }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Lock paths', kind: 'other', rawInput: args.paths }),
  }))

  ctx.tools.register(defineTool({
    name: 'writeguard_unlock',
    description: '释放本次会话持有的写锁。省略 ids 时释放本会话全部锁；只能释放自己的锁。'
      + '释放后建议用 writeguard_post 通知排在后面的写者（kind=release）。',
    parameters: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: '要释放的锁 id，来自 writeguard_lock 或 writeguard_status 的输出。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          released: { type: 'array', required: true, items: LOCK_SCHEMA },
          refused: { type: 'array', required: true, items: LOCK_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.released.length === 0 ? '没有释放任何锁。' : `已释放 ${value.released.length} 个锁。`,
          ...(value.refused.length === 0 ? [] : [`${value.refused.length} 个锁属于其他会话，未释放。`]),
        ].join(' '),
      }],
    },
    async execute(args, exec) {
      const cwd = await workingDirectoryOf(ctx, exec)
      const result = release({
        dir: lockDirFor(cwd),
        ...(args.ids === undefined ? {} : { ids: args.ids }),
        owner: ownerOf(exec),
      })
      return { released: result.released.map(lockView), refused: result.refused.map(lockView) }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Unlock paths', kind: 'other', rawInput: args.ids }),
  }))

  ctx.tools.register(defineTool({
    name: 'writeguard_status',
    description: '查看当前工作区内仍然有效的写锁、在场的写者与最近的留言；给出 path 时只看与它重叠的部分。',
    parameters: {
      path: {
        type: 'string',
        description: '只看会影响这个路径（相对或绝对）的锁与留言。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          locks: { type: 'array', required: true, items: LOCK_SCHEMA },
          presence: { type: 'array', required: true, items: PRESENCE_SCHEMA },
          messages: { type: 'array', required: true, items: MESSAGE_SCHEMA },
          gui: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const lines = []
        lines.push(value.locks.length === 0
          ? '没有有效写锁。'
          : `有效写锁 ${value.locks.length} 个：\n${value.locks.map((lock) => '  ' + describeLock(lock)).join('\n')}`)
        if (value.presence.length > 0) {
          lines.push(`在场的写者 ${value.presence.length} 个：\n${value.presence
            .map((item) => `  ${item.agent ?? item.owner} — ${item.lastSeen}`).join('\n')}`)
        }
        if (value.messages.length > 0) {
          lines.push(`最近留言 ${value.messages.length} 条：\n${value.messages
            .map((message) => `  [${message.kind}] ${message.owner}: ${message.text}`).join('\n')}`)
        }
        if (value.gui === false) lines.push('面板路由未注册（connection 服务不可用），浏览器面板会显示无法连接。')
        return [{ type: 'text', text: lines.join('\n\n') }]
      },
    },
    async execute(args, exec) {
      const cwd = await workingDirectoryOf(ctx, exec)
      remember(cwd)
      const dir = lockDirFor(cwd)
      const prefix = args.path === undefined
        ? undefined
        : (args.path.startsWith('/') ? args.path : `${cwd}/${args.path}`)
      await notePresence(dir, cwd, exec)
      return {
        locks: listLocks({ dir, ...(prefix === undefined ? {} : { prefix }) }).map(lockView),
        presence: readPresence(dir).map((item) => ({
          owner: item.owner,
          ...(item.agent === undefined ? {} : { agent: item.agent }),
          ...(item.root === undefined ? {} : { root: item.root }),
          ...(item.focus === undefined ? {} : { focus: item.focus }),
          lastSeen: item.lastSeen,
        })),
        messages: readMessages(dir, {
          limit: 5,
          ...(prefix === undefined ? {} : { path: prefix }),
        }).map(messageView),
        gui: guiReady,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Write locks', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'writeguard_post',
    description: '给其他写者留言。用于：说明你要动哪片区域（intent）、请对方让出锁（request）、'
      + '回答对方（reply）、移交未完成的工作（handoff）、通知已释放（release）。'
      + '留言写入工作区的 .writeguard/board.jsonl，同时在 GUI 面板和 writeguard_inbox 里可见。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '留言正文，写清楚对象与时间，不超过 4000 字。',
      },
      kind: {
        type: 'string',
        description: 'note（默认）/ intent / request / reply / handoff / release。',
      },
      path: {
        type: 'string',
        description: '可选：相关路径，便于对方按路径过滤。',
      },
      to: {
        type: 'string',
        description: '可选：收件人 owner id（写在拒绝理由或 status 里）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { ...MESSAGE_SCHEMA, required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已留言 ${value.message.id}（${value.message.kind}）：${value.message.text}`,
      }],
    },
    async execute(args, exec) {
      const cwd = await workingDirectoryOf(ctx, exec)
      remember(cwd)
      const dir = lockDirFor(cwd)
      const message = appendMessage(dir, {
        kind: args.kind,
        owner: ownerOf(exec),
        agent: agentNameOf(exec),
        ...(args.path === undefined ? {} : {
          path: normalizePath(args.path.startsWith('/') ? args.path : `${cwd}/${args.path}`),
        }),
        ...(args.to === undefined ? {} : { to: args.to }),
        text: args.text,
      })
      await notePresence(dir, cwd, exec)
      return { message: messageView(message) }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Post to writeguard board', kind: 'other', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'writeguard_inbox',
    description: '读取留言板。默认取最近 50 条；用 since 只看新留言（传上一次结果的最后 ts），'
      + '用 path 只看与自己相关的部分。开始一段与别人重叠的工作前先看一遍。',
    parameters: {
      since: {
        type: 'string',
        description: '只返回严格晚于这个 ISO 时间戳的留言。',
      },
      path: {
        type: 'string',
        description: '只看与这个路径相关的留言。',
      },
      limit: {
        type: 'number',
        description: '最多返回多少条，默认 50。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { messages: { type: 'array', required: true, items: MESSAGE_SCHEMA } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? '没有新留言。'
          : value.messages.map((message) => `[${message.ts}] [${message.kind}] ${message.owner}${message.to === undefined ? '' : ' → ' + message.to}: ${message.text}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const cwd = await workingDirectoryOf(ctx, exec)
      const dir = lockDirFor(cwd)
      const path = args.path === undefined
        ? undefined
        : normalizePath(args.path.startsWith('/') ? args.path : `${cwd}/${args.path}`)
      return {
        messages: readMessages(dir, {
          ...(args.since === undefined ? {} : { since: args.since }),
          ...(path === undefined ? {} : { path }),
          ...(args.limit === undefined ? {} : { limit: Math.max(1, Math.min(500, args.limit)) }),
        }).map(messageView),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Writeguard inbox', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'writeguard_wait',
    description: '排队等锁：反复尝试直到拿到，或超时。适合「对方正在跑长任务，我等它释放」的场景。'
      + '超时会返回当前持有者与它们的留言，便于决定是否改用别的目录或请对方加速。',
    parameters: {
      paths: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '要等锁的路径，相对于会话工作目录。',
      },
      timeoutSeconds: {
        type: 'number',
        description: `最多等多久，默认 60，上限 ${MAX_WAIT_SECONDS}。`,
      },
      note: {
        type: 'string',
        description: '拿到锁之后的用途说明。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          waitedSeconds: { type: 'number', required: true },
          locks: { type: 'array', required: true, items: LOCK_SCHEMA },
          conflicts: { type: 'array', required: true, items: LOCK_SCHEMA },
          messages: { type: 'array', required: true, items: MESSAGE_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `等了 ${value.waitedSeconds} 秒后获锁：\n${value.locks.map((lock) => '  ' + describeLock(lock)).join('\n')}`
          : `等了 ${value.waitedSeconds} 秒仍未获锁：\n${value.conflicts.map((lock) => '  ' + describeLock(lock)).join('\n')}`,
      }],
    },
    async execute(args, exec) {
      const cwd = await workingDirectoryOf(ctx, exec)
      remember(cwd)
      const dir = lockDirFor(cwd)
      const timeout = Math.max(1, Math.min(MAX_WAIT_SECONDS, args.timeoutSeconds ?? 60))
      const started = Date.now()
      const deadline = started + timeout * 1000
      for (;;) {
        const locks = []
        const conflicts = []
        for (const item of args.paths) {
          const prefix = item.startsWith('/') ? item : `${cwd}/${item}`
          const result = await acquire({
            dir,
            prefix,
            owner: ownerOf(exec),
            agent: agentNameOf(exec),
            ttlMs: ttlMinutes * 60_000,
            ...(args.note === undefined ? {} : { note: args.note }),
          })
          if (result.ok) locks.push(result.lock)
          else conflicts.push(result.conflict)
        }
        if (conflicts.length === 0 || Date.now() + WAIT_POLL_MS > deadline) {
          await notePresence(dir, cwd, exec)
          return {
            ok: conflicts.length === 0,
            waitedSeconds: Math.round((Date.now() - started) / 1000),
            locks: locks.map(lockView),
            conflicts: conflicts.map(lockView),
            messages: readMessages(dir, { limit: 5 }).map(messageView),
          }
        }
        await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS))
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Wait for write lock', kind: 'other', rawInput: args.paths }),
  }))

  // ── HTTP：GUI 面板读状态、执行动作 ───────────────────────────────────
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    connection = undefined
  }
  const guiReady = connection !== undefined && typeof connection?.fetch?.register === 'function'
  if (guiReady) {
    const rootList = () => (knownRoots.size > 0 ? [...knownRoots] : [normalizePath(process.cwd())])

    const stateFor = (root) => {
      const dir = lockDirFor(root)
      return {
        root,
        locks: listLocks({ dir }).map(lockView),
        presence: readPresence(dir),
        messages: readMessages(dir, { limit: 40 }).map(messageView),
      }
    }

    const disposeState = connection.fetch.register({
      path: '/api/writeguard/state',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        const asked = url.searchParams.get('root')
        const roots = asked === null || asked === '' ? rootList() : [normalizePath(asked)]
        return json({ ok: true, now: new Date().toISOString(), roots: roots.map(stateFor) })
      },
    })

    const disposeAct = connection.fetch.register({
      path: '/api/writeguard/act',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let body
        try {
          body = await request.json()
        } catch {
          return json({ ok: false, error: 'body 必须是 JSON' }, 400)
        }
        const root = typeof body?.root === 'string' && body.root !== '' ? normalizePath(body.root) : rootList()[0]
        const dir = lockDirFor(root)
        try {
          if (body?.action === 'unlock') {
            if (typeof body.id !== 'string' || body.id === '') return json({ ok: false, error: '缺少 id' }, 400)
            const result = release({ dir, ids: [body.id], owner: 'gui', force: true })
            return json({ ok: true, released: result.released.map(lockView) })
          }
          if (body?.action === 'post') {
            if (typeof body.text !== 'string' || body.text.trim() === '') {
              return json({ ok: false, error: '留言不能为空' }, 400)
            }
            const message = appendMessage(dir, {
              kind: body.kind,
              owner: 'gui',
              agent: 'gui',
              ...(typeof body.path === 'string' && body.path !== '' ? { path: body.path } : {}),
              text: body.text,
            })
            return json({ ok: true, message: messageView(message) })
          }
          return json({ ok: false, error: '未知动作' }, 400)
        } catch (error) {
          return json({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      },
    })

    const dispose = () => {
      try { void disposeState() } catch { /* already disposed */ }
      try { void disposeAct() } catch { /* already disposed */ }
    }
    if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function clampTtl(value, max) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULTS.ttlMinutes
  return Math.min(Math.max(Math.round(numeric), 1), typeof max === 'number' ? max : DEFAULTS.maxTtlMinutes)
}
