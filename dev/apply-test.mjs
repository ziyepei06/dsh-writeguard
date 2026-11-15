/**
 * Hook-level test: drive `apply()` with a stub cordis context to verify that a
 * foreign lock denies `write`/`edit`/`apply_patch` and that the owner passes.
 *
 *   node dev/apply-test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

let passed = 0
const failures = []
const check = (name, condition, detail) => {
  if (condition) passed += 1
  else failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'writeguard-apply-'))
const registered = new Map()
const listeners = new Map()
const ctx = {
  tools: { register: (definition) => registered.set(definition.name, definition) },
  on: (event, handler) => listeners.set(event, handler),
  get: () => undefined,
}

await apply(ctx, { ttlMinutes: 5 })
check('six tools registered', registered.size === 6
  && ['writeguard_lock', 'writeguard_unlock', 'writeguard_status',
    'writeguard_post', 'writeguard_inbox', 'writeguard_wait'].every((name) => registered.has(name)),
[...registered.keys()].join(','))
const pre = listeners.get('tools/pre-execute')
check('pre-execute hook installed', typeof pre === 'function')

const call = (definition, args, session) => definition.execute(args, {
  agent: { session: { id: session, header: { cwd: root } } },
})

const ownerTool = registered.get('writeguard_lock')
const locked = await call(ownerTool, { paths: ['benchmark'], ttlMinutes: 5, note: 'rebuild' }, 'session-a')
check('owner acquires', locked.ok === true && locked.locks.length === 1, JSON.stringify(locked))

const asWriter = (session) => async (exec, next) => {
  let advanced = false
  const decision = await pre(exec, async () => {
    advanced = true
    return { kind: 'allow' }
  })
  return { decision, advanced }
}

const foreign = await asWriter('session-b')({
  name: 'write', arguments: { file_path: 'benchmark/leaderboard.md' },
  agent: { session: { id: 'session-b', header: { cwd: root } } },
})
check('foreign write is denied', foreign.decision.kind === 'deny', JSON.stringify(foreign.decision))
check('denial names the holder', String(foreign.decision.reason).includes('session-a'))
check('denial explains the lock scope', String(foreign.decision.reason).includes(path.join(root, 'benchmark')))
check('denied call never advances', foreign.advanced === false)

const owner = await asWriter('session-a')({
  name: 'edit', arguments: { file_path: 'benchmark/leaderboard.md', old_string: 'a', new_string: 'b' },
  agent: { session: { id: 'session-a', header: { cwd: root } } },
})
check('owner passes', owner.decision.kind === 'allow' && owner.advanced === true)

const outside = await asWriter('session-b')({
  name: 'write', arguments: { file_path: 'other/file.md' },
  agent: { session: { id: 'session-b', header: { cwd: root } } },
})
check('unrelated path passes', outside.decision.kind === 'allow' && outside.advanced === true)

const patch = await asWriter('session-b')({
  name: 'apply_patch',
  arguments: { input: '*** Begin Patch\n*** Update File: benchmark/protocol.md\n@@\n-a\n+b\n*** End Patch' },
  agent: { session: { id: 'session-b', header: { cwd: root } } },
})
check('apply_patch target is denied', patch.decision.kind === 'deny', JSON.stringify(patch.decision))

const absolute = await asWriter('session-b')({
  name: 'write', arguments: { file_path: path.join(root, 'benchmark', 'x.md') },
  agent: { session: { id: 'session-b', header: { cwd: root } } },
})
check('absolute path is denied too', absolute.decision.kind === 'deny')

const status = await call(registered.get('writeguard_status'), { path: 'benchmark/x.md' }, 'session-b')
check('status reports the overlapping lock', status.locks.length === 1, JSON.stringify(status))

const unlockForeign = await call(registered.get('writeguard_unlock'), {}, 'session-b')
check('foreign unlock releases nothing', unlockForeign.released.length === 0 && unlockForeign.refused.length === 1)

const unlockOwn = await call(registered.get('writeguard_unlock'), {}, 'session-a')
check('owner unlock releases', unlockOwn.released.length === 1)

const afterRelease = await asWriter('session-b')({
  name: 'write', arguments: { file_path: 'benchmark/leaderboard.md' },
  agent: { session: { id: 'session-b', header: { cwd: root } } },
})
check('write passes after release', afterRelease.decision.kind === 'allow')

fs.rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`FAIL (${failures.length}):`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log(`ok — ${passed} checks passed`)
