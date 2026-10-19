# 需求规格：通道长期运行、会话级提权卡片、输入状态

日期：2026-10-19
分支：**未创建**（本规格处于调研阶段）
状态：**调研完成，待裁定开发范围**

## 1. 背景

用户提出三项，均来自真实使用观察：

1. **通道会静默停摆。** 怀疑存在 24 小时上限，需要确认机制、触发条件和恢复方式。
2. **审批卡还缺一档权限。** 希望卡片能直接选「当前会话全部权限」，并明确 `/new` 之后恢复配置。
3. **缺少「正在输入中…」中间状态。** 需要调研腾讯官方 `openclaw-weixin` 是否已有方案。

本文件只记录**事实与裁定**，不改代码。三项的开发范围见 §6。

## 2. 结论速览

| 问题 | 结论 |
|---|---|
| 24 小时上限 | **存在，且到期后不会自动恢复**。计时从通道启动开始，与是否收发消息无关 |
| 是否「超过 24 小时没发消息」才停 | **不是**。连续运行满 24 小时即停，正常聊天也计 |
| 停摆后能否自愈 | **不会自动恢复**。可手动恢复：保存任意配置字段、或在登录面板重新连接账号、或重启进程（见 §3.5） |
| 提权卡片 | **可行**，且 `/new` 恢复配置的语义已经天然满足 |
| 输入状态 | 协议支持，腾讯官方已实现；本仓库**尚未实现**，协议层需要新增两个接口 |

## 3. 事实一：24 小时运行上限

### 3.1 机制

`src/channel/monitor.ts:86`：

```ts
/** How long a single call may run before it gives up. */
const DEFAULT_MAX_RUN_MS = 24 * 60 * 60 * 1_000
```

`src/channel/monitor.ts:102`：

```ts
const deadline = now() + (options.maxRunMs ?? DEFAULT_MAX_RUN_MS)
```

循环条件（`monitor.ts:106`）：

```ts
while (!options.shouldStop() && !(options.signal?.aborted ?? false) && now() < deadline) {
```

`deadline` 在**进入 `monitorLoop` 的那一刻**确定，即通道启动时刻，与消息收发无关。

### 3.2 生产路径没有覆盖这个值

全仓库 grep `maxRunMs`：

| 文件 | 行为 |
|---|---|
| `src/channel/channel.ts:78,316` | 透传 |
| `src/channel/runtime.ts:71,270` | 透传 |
| `src/index.ts` | **从未传值** |

所以生产环境永远走默认的 24 小时。测试里倒是大量传了小值（`tests/unit/monitor.spec.ts:286`、`tests/integration/channel-real-loop.spec.ts:94` 等），因此单测覆盖的是「上限生效」，没有人覆盖「生产不需要上限」。

### 3.3 到期后的传导链

```text
monitorLoop 因 now() >= deadline 退出
  → channel.run() resolve
  → startChannelFromStore 的 finally：unsubscribe() + channel.stop()
  → runChannel resolve
  → SingleRun 的 settled resolve
```

关键缺陷在 `src/channel/single-run.ts:78-81`：

```ts
const launched = options.launch(controller.signal)
settled = launched === undefined
  ? undefined
  : Promise.resolve(launched).catch((error: unknown) => { options.onError?.(error) })
```

`settled` 是派生的 promise，它的 settle **不会清理 `current`**。`current` 只在两处被清空：

- `start({ force: true })`（`single-run.ts:73` 的 `stop()` 内部，`single-run.ts:96`）
- 显式 `stop()`

而普通启动路径 `src/index.ts:202` 调用的是 `startChannel(ctx, config)` → `run.start({})`，进入 `single-run.ts:68`：

```ts
if (current !== undefined) {
  if (!force) return
}
```

**直接 return，不重启。**

### 3.4 用户可见后果

| 现象 | 是否发生 |
|---|---|
| 24 小时后停止轮询 | 是 |
| 微信继续发消息能收到回复 | 否 |
| 有日志报错 | **没有**。`runChannel` 是正常 resolve，不是异常 |
| `live()` 的返回值 | `true`（谎报） |
| 插件页保存配置能恢复 | **能**（见 §3.5 的实测） |
| 登录面板重新连接账号能恢复 | 能（唯一走 `force: true` 的路径，`src/index.ts:257`） |
| 重启进程能恢复 | 能 |

### 3.5 一次判断被推翻并实测更正

本文档起草过程中先判断「插件页保存配置不能恢复」，理由是 `channelRun` 用 `WeakMap<Context, SingleRun>` 缓存（`src/index.ts:357,391`），同一 context 会拿回那个 `current` 未清空的实例。**这个判断是错的**，实测推翻了它。

证据：`tests/integration/session-policy-wiring.spec.ts` 的
`saving the page while the channel is running > still answers the next message after a working directory change` 用例通过（2026-10-19 本地运行，6/6 passed）。该用例走的正是 volatile 配置的 `update()` 路径，并在改动后成功收到新消息。运行输出中 `[channel-wechat] polling as: bot-1` 出现两次，说明旧的 run 被 `channel.stop()` 结束、新的 `apply` 重新启动了轮询。

原因：volatile-only 配置变更会让 Loader **dispose 并重跑 `apply`**（`src/index.ts:379-388` 的注释与 `ctx.effect` disposer 就是为此存在），disposer 里的 `run.stop()` 清空 `current`，新 `apply` 因此能正常启动。

**所以真正的缺陷范围要收窄**：`SingleRun` 的 `current` 泄漏只在「run 自然结束而没有任何外部调用 `stop()`」时显现。§3.7 仍然是独立缺陷，但它不是 24 小时停摆的**唯一**恢复途径问题——用户可以通过保存任意配置字段恢复。

### 3.6 用户裁定

**采用方案一：接线 `maxRunMs`，让生产环境不再有 24 小时上限。**

实现要点（尚未开发）：

- `src/index.ts` 向 `startChannelFromStore` 传入一个不设上限的值，或让 `monitorLoop` 在未显式给出上限时不设 deadline。
- 保留 `signal` 与 `shouldStop` 两条退出路径，长期运行不等于不可停止。
- 测试中传小值的用例不受影响。

### 3.7 附带缺陷：`SingleRun` 不清理已结束的运行

`launch` 自然 resolve 时 `current` 不会被清空，`live()` 会持续返回 `true`。由于 §3.5 描述的重载路径会调用 `stop()`，日常使用中这个泄漏很少被触发；但任何**非 abort 原因**的循环退出都会让 `live()` 永久为 `true`，后续不带 `force` 的 `start` 全部被挡掉。

建议单独修复并配 TDD 用例：循环自然结束后 `live()` 必须为 `false`，且随后 `start()` 能真正启动。

## 4. 事实二：会话级提权卡片

### 4.1 现状：卡片只有两档

`src/bridge/cards.ts:24`：

```ts
export const APPROVAL_OPTIONS = ['once', 'reject'] as const
```

渲染为 `1. once — 仅允许这一次` / `2. reject — 拒绝这次调用`（`cards.ts:64-66`）。
`readApprovalReply` 只返回 `allowed-once` 或 `rejected`（`cards.ts:184-192`）。

### 4.2 `/new` 恢复配置的语义已经满足

`src/bridge/peer-map.ts:329`：

```ts
if (!resumed) this.applyPermission?.(handle)
```

`applyPermission` 来自 `src/index.ts:479`，写入的是 `config.permission`（`Config` 默认 `workspace-write`，`src/index.ts:147-148`）。

因此：

| 操作 | 结果 |
|---|---|
| 卡片提升权限 | 写入**当前 session** 的 durable 事件（`permission/preset` + `sandbox/mode` + `approval/policy`） |
| `/new` | 生成新 generation（`~g<N+1>`），`resumed === false`，重新按配置创建 → **权限恢复** |
| 进程重启 | 同一 session 被 resume，`resumed === true`，权限**保留** |

这与既有设计一致，见 `peer-map.ts:248-252` 的注释：resume 时不重新套用配置，以免覆盖用户用 `/permission` 改过的会话选择。

### 4.3 已有的等价能力

用户目前已经能通过 `/permission danger-full-access` 达到同样效果（`docs/commands.md:46-48` 已记录）。卡片选项的价值是**把这条路放到决策现场**，而不是新增能力。

### 4.4 文案与确认流程

用户裁定：**个人使用，从简**。不做二次确认。

卡片渲染为三行选项：

```text
🔒 需要权限确认
工具：bash
原因：
  ...（请求方给出的原因）

请回复其中一个：
  1. once — 仅允许这一次
  2. reject — 拒绝这次调用
  3. session — 本会话全部权限（之后不再弹审批卡，/new 恢复）

回复：P1 1
```

选择 `3` 后的流程：

1. 立即回复一条确认：「已切换本会话为完全权限，后续不再弹出审批卡；`/new` 之后恢复配置的权限。」
2. 返回 `allowed-once`，当前这次调用继续执行。
3. 之后同一会话的审批请求由 `approval: never` 在到达本插件前结算，卡片不再出现。

不做二次确认，因此选项文案本身就是唯一的风险告知。第 3 项必须写出「之后不再弹审批卡」和「/new 恢复」，不能只写「全部权限」。

### 4.5 实现要点（尚未开发）

1. `APPROVAL_OPTIONS` 增加第三项 `'session'`。
2. `readApprovalReply` 增加 `{ kind: 'elevate' }` 分支。
3. `CardService` 增加注入回调，例如 `elevate: (sessionId: string) => boolean`，内部调用 `ctx.permissionPresets.set(session, 'danger-full-access')`；返回是否成功，供确认文案区分。
4. 提权成功后返回 `allowed-once`，让当前这次调用继续。
5. 提权失败时不改变结果语义：仍按 `allowed-once` 放行本次调用，但确认文案改为说明「权限未能切换」并报告原因。

### 4.6 必须记录的风险

`danger-full-access` 在 `dsh-base` 的预设表里捆绑 `approval: never`（`src/index.ts:144-148` 与 `src/channel/session-policy.ts:27-30` 均有说明）。这意味着：

- 本次调用放行；
- sandbox 升级为 full access；
- **同一会话之后的审批请求在到达卡片监听器之前就被结算**，卡片不会再出现。

所以选项文案不能写成「允许这次并记住」，必须写成「本会话全部权限」。

GUI 页面对该预设有一层显式二次确认（`src/client/client.js:107-111`）。微信侧**不做**，理由是个人使用；代价是点击 `3` 即生效，没有撤销步骤。选项文案因此承担全部告知责任（见 §4.4）。

## 5. 事实三：「正在输入中…」中间状态

### 5.1 它是什么

微信聊天窗口顶部那行「对方正在输入…」。微信没有推送式 API，只有一对显式接口：**先取一张票据，再带着票据反复上报状态**。

两个接口（`docs/protocol/protocol_zh_CN.md:301-349`）：

| 接口 | 用途 |
|---|---|
| `POST /ilink/bot/getconfig` | 取 `typing_ticket` |
| `POST /ilink/bot/sendtyping` | `status: 1` 开始输入，`2` 取消 |

`sendtyping` 的请求体：

```json
{
  "ilink_user_id": "<用户 ID>",
  "typing_ticket": "<从 getconfig 拿到的票据>",
  "status": 1,
  "base_info": { "channel_version": "2.4.8", "bot_agent": "OpenClaw" }
}
```

三个关键约束，决定了实现形状：

1. **票据是必需的**。没有 `typing_ticket` 就不能发状态，所以必须先调 `getconfig`。
2. **状态有时效**。不是发一次就常亮，需要周期续期（官方 5 秒一次）。
3. **是"用户维度"的，不是"会话维度"**。`ilink_user_id` 指向人，所以同一用户在同一时刻只有一个输入状态。

### 5.2 腾讯官方怎么做的

仓库：`/Users/wangx/workspace/aaa/github/openclaw-weixin`（v2.4.10，MIT）。

**票据管理**（`src/api/config-cache.ts`）：

| 设计 | 值 | 为什么 |
|---|---|---|
| 缓存粒度 | 每个用户一条 | 票据按 `ilink_user_id` 发放 |
| 刷新时机 | `Math.random() * 24h` | 24 小时内随机时刻，避免多用户同时刷新 |
| 失败退避 | 2 秒起，指数退避到 1 小时 | 不因票据接口故障打断消息处理 |
| 首次失败 | 缓存空票据 | 后续 `sendTyping` 直接跳过 |

**发送逻辑**（`src/messaging/process-message.ts:311-341`）：

```ts
const hasTypingTicket = Boolean(deps.typingTicket)
const typingCallbacks = createTypingCallbacks({
  start: hasTypingTicket ? () => sendTyping({ ... status: TypingStatus.TYPING }) : async () => {},
  stop:  hasTypingTicket ? () => sendTyping({ ... status: TypingStatus.CANCEL }) : async () => {},
  onStartError: (err) => deps.log(`[weixin] typing send error: ${String(err)}`),
  onStopError:  (err) => deps.log(`[weixin] typing cancel error: ${String(err)}`),
  keepaliveIntervalMs: 5000,
})
```

行为要点：

- **没有票据就什么都不发**（`async () => {}`），不报错、不阻断。
- **5 秒续期一次**，直到 `stop()`。
- **只覆盖一轮回复**：消息进入处理时 `start`，回复交付时 `stop`。
- `start`/`stop` 的错误只记日志，不影响回复本身。

> 另外还有一个**不同的**机制（`src/messaging/reply-progress-sender.ts`）：用 `runId` + `onItemEvent` 把工具调用开始/结束作为消息发出去。那不是"正在输入中"，是另一种中间反馈，本次不纳入。

### 5.3 本仓库现状

`src/wechat/api.ts` 只有 `getUpdates`、`sendText`、`sendFile`、`getUploadUrl`、`get`、`post`。
`getConfig` / `sendTyping` / `typing_ticket` 全仓库 grep：**零实现**。

所以目前用户发一条消息后，界面上没有任何反馈，直到回复整段出现。长任务（比如跑测试）可能沉默几十秒到几分钟。

### 5.4 接入点

一轮对话在本仓库里有明确边界：

| 位置 | 含义 |
|---|---|
| `src/channel/channel.ts:593` `this.options.onTurnStarted?.()` | 一轮开始 |
| `src/channel/channel.ts:600` `await agentOf(handle).whenIdle?.()` | 一轮结束 |

但 `handleMessage` 里有两类**提前 return**，不应触发输入状态（`channel.ts:571-579`）：

- 命令（`/status` 之类）——本地立刻回答，不需要"输入中"；
- 卡片回复——用户正在回答卡片，也不该显示机器人正在输入。

也就是说，`start` 应放在这两处 return **之后**、`deliverInbound` 之前；`stop` 应放在 `whenIdle()` 之后（且用 `finally` 保证异常也取消）。

### 5.5 `notifyStart` / `notifyStop` 是什么

它不是输入状态，是**账号在线状态上报**：告诉微信服务端「这个 bot 客户端启动了 / 停止了」。

协议（`protocol_zh_CN.md:351-378`）：

```http
POST /ilink/bot/msg/notifystart
POST /ilink/bot/msg/notifystop
```

请求体只有 `base_info`（没有 `ilink_user_id`、没有 `context_token`），响应是 `{ ret, errmsg }`。

**用途**：官方 CHANGELOG（`CHANGELOG.zh_CN.md:107`）写明「便于上游微信服务端对账户在线状态进行对账」。也就是说，服务端用它判断这个 bot 是否在线，而不是用来给用户看「正在输入」。

**官方调用时机**（`src/channel.ts:520-528, 563-576`）：

| 时机 | 接口 | 失败处理 |
|---|---|---|
| `startAccount` 里，登录检查通过、开始 `monitor` 之前 | `notifyStart` | 记 warning，**不阻断启动** |
| `stopAccount` 里，关闭时 | `notifyStop` | 记 warning，**不阻断关闭** |

`notifyStop` 用**独立超时**而不是网关的 abort signal，目的是让请求能在长轮询已被中止后仍然发完。

**与本插件的关系**：协议层没有强制要求，缺了它通道照样收发消息。它影响的是服务端对账号在线状态的判断，具体表现（是否影响消息推送、是否影响重新扫码登录）**没有实测证据**。

### 5.6 用户裁定

| 问题 | 裁定 |
|---|---|
| 范围 | 先只做 `getConfig` + `sendTyping`；`notifyStart`/`notifyStop` **不做** |
| 票据持久化 | **只放内存**，并显式处理失效 |
| 续期间隔 | **5 秒**（沿用官方） |
| 失败语义 | 沿用官方静默降级 |

**票据失效的处理**（用户明确要求考虑）：

- 内存缓存，结构为 `Map<userId, { ticket, expiresAt }>`。
- 缓存条目带过期时间；到期或票据为空时，下一次需要发送状态前重新 `getConfig`。
- 若 `sendTyping` 返回非零 `ret` 或抛错，**丢弃该用户的缓存票据**，下次重新获取；本次状态发送放弃，不影响回复。
- `getConfig` 失败时沿用官方策略：标记不可用并退避重试（2 秒起，指数退避到 1 小时上限），期间跳过状态上报而不是阻塞消息处理。
- 不做跨重启持久化，因此重启后第一次需要状态上报时会多发一次 `getConfig`。

## 6. 建议的开发范围

按用户当前「调研阶段」的设定，以下只列候选，**不代表已批准**：

| 项 | 建议 | 依赖 | 风险 |
|---|---|---|---|
| A. 移除 24 小时上限 | **做** | 无 | 低；需要验证长期运行 |
| B. 修 `SingleRun` 不清理 `current` | **建议做**，与 A 分开提交 | 无 | 低；纯逻辑修复，日常难触发（§3.5） |
| C. 提权卡片选项 | **做** | 文案见 §4.4，个人使用不加二次确认 | 中；`approval: never` 会让本会话后续卡片消失 |
| D. `sendTyping` | **做**，先只做发送侧 | 协议层新增接口 | 低；票据缺失静默降级 |
| E. `getConfig` 票据缓存 | 与 D 同批，内存 + 失效处理（§5.6） | D | 低 |
| F. `notifyStart` / `notifyStop` | **不做**（用户裁定） | 无 | 需实测服务端影响 |

建议顺序：B → A → C → D+E。B 和 A 在同一个缺陷链上，先修 B 能让 A 的效果可验证。

## 7. 参考

| 内容 | 位置 |
|---|---|
| 卡片超时 30 分钟 | `src/index.ts:57` |
| 卡片超时行为（审批/提问不同） | `src/bridge/cards-service.ts:135-146` |
| 运行上限 | `src/channel/monitor.ts:86,102,106` |
| 运行生命周期 | `src/channel/single-run.ts:67-104` |
| 权限应用时机 | `src/bridge/peer-map.ts:329` |
| 审批选项 | `src/bridge/cards.ts:24,184-192` |
| typing 协议 | `docs/protocol/protocol_zh_CN.md:301-349` |
| notify 协议与在线状态用途 | `docs/protocol/protocol_zh_CN.md:351-378`、`openclaw-weixin/CHANGELOG.zh_CN.md:107` |
| 官方实现 | `openclaw-weixin/src/api/config-cache.ts`、`src/messaging/process-message.ts:311-341`、`src/channel.ts:520-576` |
| 既有权限命令说明 | `docs/commands.md:46-48` |
