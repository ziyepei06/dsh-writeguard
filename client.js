/**
 * dsh-writeguard 的浏览器端面板。
 *
 * 载体约定：`window.__ModuleLoader__.load({ id: '<包名>', factory })`，factory 返回
 * `{ name, apply(ctx) }`。用 shadow root 隔离样式，避免与宿主应用 CSS 互相污染。
 *
 * 数据来源是 Host 注册的两个精确路由：
 *   GET  /api/writeguard/state  → { roots: [{ root, locks, presence, messages }] }
 *   POST /api/writeguard/act    → { action: 'unlock' | 'post', ... }
 *
 * @module dsh-writeguard/client
 */
;(function () {
  'use strict'

  var HOST_ID = 'dsh-writeguard-host'
  var POLL_MS = 2500
  var KIND_LABEL = {
    note: '留言',
    intent: '预告',
    request: '请求',
    reply: '回复',
    handoff: '移交',
    release: '释放'
  }
  var KIND_COLOR = {
    note: '#6b7280',
    intent: '#2563eb',
    request: '#b45309',
    reply: '#0f766e',
    handoff: '#7c3aed',
    release: '#15803d'
  }

  window.__ModuleLoader__.load({
    id: 'dsh-writeguard',
    factory: function () {
      function el(tag, className, text) {
        var node = document.createElement(tag)
        if (className) node.className = className
        if (text !== undefined && text !== null) node.textContent = String(text)
        return node
      }

      function relativeTime(iso) {
        var then = Date.parse(iso)
        if (!Number.isFinite(then)) return '—'
        var seconds = Math.round((Date.now() - then) / 1000)
        if (seconds < 5) return '刚刚'
        if (seconds < 60) return seconds + ' 秒前'
        var minutes = Math.round(seconds / 60)
        if (minutes < 60) return minutes + ' 分钟前'
        var hours = Math.round(minutes / 60)
        if (hours < 24) return hours + ' 小时前'
        return Math.round(hours / 24) + ' 天前'
      }

      function countdown(iso) {
        var then = Date.parse(iso)
        if (!Number.isFinite(then)) return '—'
        var left = Math.round((then - Date.now()) / 1000)
        if (left <= 0) return '已到期'
        if (left < 60) return left + ' 秒后到期'
        return Math.round(left / 60) + ' 分钟后到期'
      }

      function shortRoot(root) {
        var parts = String(root || '').split('/').filter(Boolean)
        if (parts.length <= 2) return root || ''
        return '…/' + parts.slice(-2).join('/')
      }

      function shortOwner(owner) {
        var text = String(owner || '')
        return text.length <= 14 ? text : text.slice(0, 6) + '…' + text.slice(-4)
      }

      var CSS = [
        ':host { all: initial; }',
        '* { box-sizing: border-box; }',
        '.launcher {',
        '  position: fixed; right: 20px; bottom: 20px; width: 42px; height: 42px;',
        '  border-radius: 21px; border: 1px solid rgba(127,127,127,.35);',
        '  background: #17181a; color: #f2f3f5; cursor: pointer; z-index: 2147483000;',
        '  display: flex; align-items: center; justify-content: center;',
        '  box-shadow: 0 6px 20px rgba(0,0,0,.28); padding: 0;',
        '  font: 500 13px/1 -apple-system, "SF Pro Text", "PingFang SC", sans-serif;',
        '}',
        '.launcher:hover { background: #24262a; }',
        '.launcher .badge {',
        '  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;',
        '  border-radius: 9px; background: #f59e0b; color: #1a1a1a; font-size: 11px;',
        '  display: flex; align-items: center; justify-content: center; padding: 0 4px;',
        '}',
        '.panel {',
        '  position: fixed; right: 20px; bottom: 74px; width: 386px; max-height: 70vh;',
        '  display: flex; flex-direction: column; z-index: 2147483001;',
        '  background: #17181a; color: #e8eaed; border: 1px solid rgba(127,127,127,.28);',
        '  border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.38); overflow: hidden;',
        '  font: 13px/1.5 -apple-system, "SF Pro Text", "PingFang SC", sans-serif;',
        '}',
        '.head { display: flex; align-items: baseline; gap: 8px; padding: 12px 14px 8px; }',
        '.head .title { font-size: 13px; font-weight: 600; letter-spacing: .01em; }',
        '.head .root { color: #9aa0a6; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.head .spacer { flex: 1; }',
        '.head button {',
        '  background: none; border: 0; color: #9aa0a6; cursor: pointer; font-size: 12px; padding: 2px 4px;',
        '}',
        '.head button:hover { color: #e8eaed; }',
        '.body { overflow-y: auto; padding: 0 14px 10px; }',
        '.section { margin-top: 10px; }',
        '.section > h4 {',
        '  margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .08em;',
        '  text-transform: uppercase; color: #8b9196;',
        '}',
        '.empty { color: #6b7075; font-size: 12px; padding: 2px 0 4px; }',
        '.row { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid rgba(127,127,127,.12); }',
        '.row:last-child { border-bottom: 0; }',
        '.row .grow { flex: 1; min-width: 0; }',
        '.row .name { font-weight: 500; }',
        '.row .meta { color: #8b9196; font-size: 11px; }',
        '.row .path { color: #c8ccd0; font-size: 12px; word-break: break-all; }',
        '.dot { width: 7px; height: 7px; border-radius: 4px; margin-top: 6px; background: #34d399; flex: none; }',
        '.dot.idle { background: #6b7280; }',
        '.chip {',
        '  display: inline-block; font-size: 10px; padding: 0 5px; border-radius: 5px;',
        '  border: 1px solid currentColor; line-height: 16px; margin-right: 5px;',
        '}',
        '.msg { padding: 6px 0; border-bottom: 1px solid rgba(127,127,127,.12); }',
        '.msg:last-child { border-bottom: 0; }',
        '.msg .text { white-space: pre-wrap; word-break: break-word; }',
        '.link { background: none; border: 0; color: #60a5fa; cursor: pointer; font-size: 11px; padding: 2px 0; }',
        '.link:hover { text-decoration: underline; }',
        '.composer { display: flex; gap: 6px; padding: 10px 14px 12px; border-top: 1px solid rgba(127,127,127,.18); background: #131416; }',
        '.composer textarea {',
        '  flex: 1; resize: none; height: 44px; border-radius: 8px; padding: 7px 9px;',
        '  border: 1px solid rgba(127,127,127,.28); background: #1b1c1f; color: #e8eaed;',
        '  font: inherit; font-size: 12px; outline: none;',
        '}',
        '.composer textarea:focus { border-color: #4b7bec; }',
        '.composer .stack { display: flex; flex-direction: column; gap: 4px; }',
        '.composer select {',
        '  border-radius: 6px; border: 1px solid rgba(127,127,127,.28); background: #1b1c1f;',
        '  color: #e8eaed; font: inherit; font-size: 11px; padding: 3px 4px; outline: none;',
        '}',
        '.composer button {',
        '  border-radius: 6px; border: 0; background: #4b7bec; color: #fff; cursor: pointer;',
        '  font: inherit; font-size: 12px; padding: 0 10px;',
        '}',
        '.composer button:disabled { opacity: .5; cursor: default; }',
        '.status { padding: 0 14px 8px; color: #8b9196; font-size: 11px; }',
        '.status.bad { color: #f87171; }',
        '@media (prefers-color-scheme: light) {',
        '  .launcher { background: #fff; color: #1a1a1a; }',
        '  .panel { background: #fff; color: #1c1d1f; }',
        '  .composer { background: #f6f7f8; }',
        '  .composer textarea, .composer select { background: #fff; color: #1c1d1f; }',
        '}'
      ].join('\n')

      function build() {
        var host = document.getElementById(HOST_ID)
        if (host === null) {
          host = document.createElement('div')
          host.id = HOST_ID
          document.body.appendChild(host)
        }
        var shadow = host.shadowRoot || host.attachShadow({ mode: 'open' })
        shadow.textContent = ''

        var style = document.createElement('style')
        style.textContent = CSS
        shadow.appendChild(style)

        var launcher = el('button', 'launcher')
        launcher.title = '写者协作面板'
        launcher.setAttribute('aria-label', '写者协作面板')
        launcher.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10" width="15" height="10" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>'
        var badge = el('span', 'badge', '0')
        badge.style.display = 'none'
        launcher.appendChild(badge)
        shadow.appendChild(launcher)

        var panel = el('div', 'panel')
        panel.style.display = 'none'
        shadow.appendChild(panel)

        var head = el('div', 'head')
        head.appendChild(el('span', 'title', '写者协作'))
        var rootLabel = el('span', 'root', '')
        head.appendChild(rootLabel)
        head.appendChild(el('span', 'spacer'))
        var refresh = el('button', '', '刷新')
        head.appendChild(refresh)
        var close = el('button', '', '✕')
        head.appendChild(close)
        panel.appendChild(head)

        var status = el('div', 'status', '')
        panel.appendChild(status)

        var body = el('div', 'body')
        var presenceSection = el('div', 'section')
        var locksSection = el('div', 'section')
        var boardSection = el('div', 'section')
        body.appendChild(presenceSection)
        body.appendChild(locksSection)
        body.appendChild(boardSection)
        panel.appendChild(body)

        var composer = el('div', 'composer')
        var area = el('textarea')
        area.placeholder = '留一句话给另一个写者…'
        composer.appendChild(area)
        var stack = el('div', 'stack')
        var kindSelect = el('select')
        ;['note', 'request', 'reply', 'handoff', 'intent'].forEach(function (kind) {
          var option = el('option', '', KIND_LABEL[kind])
          option.value = kind
          kindSelect.appendChild(option)
        })
        stack.appendChild(kindSelect)
        var send = el('button', '', '发送')
        stack.appendChild(send)
        composer.appendChild(stack)
        panel.appendChild(composer)

        return {
          host: host,
          shadow: shadow,
          launcher: launcher,
          badge: badge,
          panel: panel,
          rootLabel: rootLabel,
          refresh: refresh,
          close: close,
          status: status,
          presenceSection: presenceSection,
          locksSection: locksSection,
          boardSection: boardSection,
          area: area,
          kindSelect: kindSelect,
          send: send
        }
      }

      function sectionTitle(text) {
        return el('h4', '', text)
      }

      function render(ui, state) {
        var root = state && state.roots && state.roots[0] ? state.roots[0] : null
        ui.currentRoot = root ? root.root : null
        ui.rootLabel.textContent = root ? shortRoot(root.root) : ''
        ui.rootLabel.title = root ? root.root : ''

        var liveLocks = root ? root.locks.length : 0
        if (liveLocks > 0) {
          ui.badge.style.display = 'flex'
          ui.badge.textContent = String(liveLocks)
        } else {
          ui.badge.style.display = 'none'
        }

        ui.presenceSection.textContent = ''
        ui.presenceSection.appendChild(sectionTitle('在场'))
        var presence = root ? root.presence : []
        if (presence.length === 0) {
          ui.presenceSection.appendChild(el('div', 'empty', '没有活跃会话（5 分钟无活动会自动消失）'))
        } else {
          presence.forEach(function (item) {
            var row = el('div', 'row')
            row.appendChild(el('span', 'dot'))
            var grow = el('div', 'grow')
            grow.appendChild(el('div', 'name', item.agent || shortOwner(item.owner)))
            grow.appendChild(el('div', 'meta', shortOwner(item.owner) + ' · ' + relativeTime(item.lastSeen)))
            row.appendChild(grow)
            ui.presenceSection.appendChild(row)
          })
        }

        ui.locksSection.textContent = ''
        ui.locksSection.appendChild(sectionTitle('写锁'))
        var locks = root ? root.locks : []
        if (locks.length === 0) {
          ui.locksSection.appendChild(el('div', 'empty', '当前没有写锁'))
        } else {
          locks.forEach(function (lock) {
            var row = el('div', 'row')
            var grow = el('div', 'grow')
            var name = el('div', 'name', shortOwner(lock.agent || lock.owner))
            grow.appendChild(name)
            var pathLine = el('div', 'path', shortRoot(lock.prefix))
            pathLine.title = lock.prefix
            grow.appendChild(pathLine)
            grow.appendChild(el('div', 'meta', (lock.note ? lock.note + ' · ' : '') + countdown(lock.expiresAt)))
            row.appendChild(grow)
            var unlock = el('button', 'link', '释放')
            unlock.addEventListener('click', function () {
              act(ui, { root: root.root, action: 'unlock', id: lock.id })
            })
            row.appendChild(unlock)
            ui.locksSection.appendChild(row)
          })
        }

        ui.boardSection.textContent = ''
        ui.boardSection.appendChild(sectionTitle('留言板'))
        var messages = root ? root.messages.slice().reverse() : []
        if (messages.length === 0) {
          ui.boardSection.appendChild(el('div', 'empty', '还没有留言。写下你打算动的区域，对方就不用猜。'))
        } else {
          messages.forEach(function (message) {
            var wrap = el('div', 'msg')
            var head = el('div', 'meta')
            var chip = el('span', 'chip', KIND_LABEL[message.kind] || message.kind)
            chip.style.color = KIND_COLOR[message.kind] || KIND_COLOR.note
            head.appendChild(chip)
            head.appendChild(document.createTextNode(
              shortOwner(message.agent || message.owner) + ' · ' + relativeTime(message.ts)
              + (message.path ? ' · ' + shortRoot(message.path) : '')
            ))
            wrap.appendChild(head)
            wrap.appendChild(el('div', 'text', message.text))
            ui.boardSection.appendChild(wrap)
          })
        }
      }

      function setStatus(ui, text, bad) {
        ui.status.textContent = text
        ui.status.className = bad ? 'status bad' : 'status'
      }

      function act(ui, payload) {
        setStatus(ui, '提交中…', false)
        fetch('/api/writeguard/act', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (response) {
          return response.json().catch(function () { return { ok: false, error: 'HTTP ' + response.status } })
        }).then(function (result) {
          if (!result || result.ok !== true) {
            setStatus(ui, '操作失败：' + ((result && result.error) || '未知错误'), true)
            return
          }
          setStatus(ui, '已提交', false)
          refresh(ui)
        }).catch(function (error) {
          setStatus(ui, '操作失败：' + String(error && error.message ? error.message : error), true)
        })
      }

      function refresh(ui) {
        fetch('/api/writeguard/state', { headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(function (state) {
            if (!state || state.ok !== true) throw new Error((state && state.error) || '状态返回异常')
            render(ui, state)
            setStatus(ui, '已连接 · ' + new Date().toLocaleTimeString(), false)
          })
          .catch(function (error) {
            setStatus(ui, '无法连接后台：' + String(error && error.message ? error.message : error)
              + '（确认 writeguard 插件已启用）', true)
          })
      }

      return {
        name: 'writeguard',
        apply: function (ctx) {
          var ui = build()
          var timer = null
          var cleanups = []

          function open() {
            ui.panel.style.display = 'flex'
            refresh(ui)
            if (timer === null) timer = window.setInterval(function () { refresh(ui) }, POLL_MS)
          }

          function close() {
            ui.panel.style.display = 'none'
            if (timer !== null) {
              window.clearInterval(timer)
              timer = null
            }
          }

          ui.launcher.addEventListener('click', function () {
            if (ui.panel.style.display === 'flex') close()
            else open()
          })
          ui.close.addEventListener('click', close)
          ui.refresh.addEventListener('click', function () { refresh(ui) })
          ui.send.addEventListener('click', function () {
            var text = ui.area.value.trim()
            if (text === '') return
            var root = ui.currentRoot || null
            ui.area.value = ''
            act(ui, { root: root, action: 'post', kind: ui.kindSelect.value, text: text })
          })

          cleanups.push(function () {
            close()
            if (ui.host.parentNode) ui.host.parentNode.removeChild(ui.host)
          })

          var dispose = function () {
            cleanups.forEach(function (fn) {
              try { fn() } catch (error) { /* 清理失败不阻塞 */ }
            })
          }

          if (ctx && typeof ctx.effect === 'function') {
            ctx.effect(function () { return dispose })
          } else {
            window.addEventListener('beforeunload', dispose)
          }
        }
      }
    }
  })
})()
