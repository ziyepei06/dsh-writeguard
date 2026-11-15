# dsh-writeguard

跨会话的**路径租约锁**，加上一层给写者的**协作界面**：谁在场、谁锁了什么、接下来打算动哪片区域。

只加锁不够——拿到锁的人不知道谁在等，被拒的人不知道对方在干什么。所以本插件把
「保护」和「沟通」放在一起：锁负责不让写撞车，留言板与排队负责让两个写者知道彼此的存在。

## 它解决什么

同一个工作区里并行跑两个会话（或一个会话加一个 `make all`）时，谁最后写谁生效，
前面的结果静默消失。DSH 自带的 `fs-observation-policy` 只保证**同一会话**内先读后写，
跨会话没有约束。

writeguard 用文件租赁（lease）补这一段：动手前先占住路径，别人要写同一路径时被拦下，
并被告知谁持有、到什么时候、为什么。

## 四部分

| 部分 | 作用 |
| --- | --- |
| `writeguard_lock` / `writeguard_unlock` / `writeguard_status` | 模型侧工具：占锁、释放、查看锁 + 在场 + 最近留言 |
| `writeguard_post` / `writeguard_inbox` / `writeguard_wait` | 沟通：留言（预告/请求/回复/移交）、读留言、排队等锁 |
| `tools/pre-execute` 拦截 | `write` / `edit` / `apply_patch` 的目标落在**他人**活锁下时拒绝，理由里给出「找谁、怎么等、怎么留言」 |
| `bin/wg.mjs` + 浏览器面板 | shell 侧 `wg run -- make all` 持锁跑长任务；右下角面板查看在场/锁/留言，可释放锁或留言 |

## 协作从哪来

- **在场（presence）**：任何会话的活动都会刷新自己的心跳，5 分钟无活动自动消失。
- **留言板（board）**：`.writeguard/board.jsonl` 追加写，六种类型——`note` 普通留言、
  `intent` 预告要动哪片区域、`request` 请求让出、`reply` 回复、`handoff` 移交、`release` 通知释放。
  超 2 MB 自动轮转保留最近 1000 条。
- **排队（wait）**：`writeguard_wait` 反复尝试直到拿到锁或超时，超时返回持有者与它们的留言。
- **自动请求**：`writeguard_lock` 撞上别人的锁时会自动在留言板留一条 `request`，对方下一次
  `writeguard_status` / `writeguard_inbox` 就能看到。

## 用法

```bash
# 查看 / 占锁 / 释放
node bin/wg.mjs status
node bin/wg.mjs lock 数据研究/benchmark --ttl 30 --note "重建 leaderboard"
node bin/wg.mjs unlock wg-1a2b3c4d
node bin/wg.mjs unlock --all --force        # 清掉崩溃会话留下的锁

# 长任务：持锁运行，结束时自动释放（含 Ctrl-C）
node bin/wg.mjs run --paths 数据研究/benchmark/labels --ttl 45 --note "make all" -- make -C 数据研究/benchmark all

# shell 一侧留言 / 看板
node bin/wg.mjs post "labels/ 我这边冻结了，20 分钟后释放" --kind intent --path 数据研究/benchmark/labels
node bin/wg.mjs status            # 锁 + 在场 + 最近留言
```

模型侧看到的是六个 `writeguard_*` 工具，描述里写清了什么时候该锁、锁多久、什么时候该留言或排队。

## 浏览器面板

Host 注册两个精确路由供面板使用（面板随 `client.js` 由 `__ModuleLoader__` 加载，右下角锁按钮打开）：

| 路由 | 用途 |
| --- | --- |
| `GET /api/writeguard/state` | 返回各工作区的 `locks` / `presence` / `messages` |
| `POST /api/writeguard/act` | `{ action: 'unlock', id }` 释放锁；`{ action: 'post', text, kind }` 留言 |

面板 2.5 秒轮询一次：在场会话、每条锁的持有者与到期倒计时、留言板，以及一个留言输入框。
锁可以一键释放（等价于 `wg unlock --force`），方便处理崩溃会话留下的死锁。

## 锁的语义

- **前缀锁**：锁一个目录即覆盖其下所有文件；两个路径只要互为祖先或相等就算冲突。
- **租期**：默认 15 分钟，上限 120 分钟；到期自动失效，不需要清理。
- **进程回收**：会话持的锁在宿主进程消失后立刻作废；`wg lock` 是显式的独立租约，
  只受租期约束（所以要给它一个够用的 `--ttl`）。
- **所有权**：只有持有者能释放；`--force` 是给人用的逃生口。
- 锁文件在 `<工作区>/.writeguard/locks/*.json`，一个锁一个文件，可直接看、可删。
- 抢占用 `mkdir` 互斥串行化，12 路并发实测只有 1 个赢。

## 不覆盖的地方

- `bash` 里的重定向、`sed -i`、`python` 脚本写文件——插件看不到目标路径。
  这类写入请用 `wg run` 把整条命令包起来。
- 这是**协作**机制，不是安全边界：它防的是「不知道对方在写」，不防「明知故犯」。

## 安装

profile 里以本地包安装（`file:` 依赖 + patch 插入一条 Loader entry）：

```bash
# 1. 放进 profile 的 plugins 目录
cp -R dsh-writeguard ~/.dsh/profiles/desktop/plugins/
# 2. 用 plugin_manager 安装（install_bundle，target 传绝对目录）
#    或在 profile 的 package.json 里加 file: 依赖并跑 pnpm install
```

装完在插件列表里能看到「并发写保护」，新会话即可使用。

## 配置

`cordis.patch.yml` 里可覆盖：

```yaml
config:
  ttlMinutes: 15      # 锁默认租期
  maxTtlMinutes: 120  # 单个锁的租期上限
  lockDir: .writeguard
  enforce: false      # 只记录不拦截（调试用）
```

## 测试

```bash
node dev/smoke.mjs   # 24 项：路径重叠、冲突、所有权、过期/死进程回收、并发抢占
```
