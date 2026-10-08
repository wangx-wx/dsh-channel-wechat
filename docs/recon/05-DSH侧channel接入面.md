# 侦察报告 05：DSH 侧 channel 接入面

> 来源：子任务 54d51995（只读调查，DSH 仓库）

## 0. 总判断

**DSH 里不存在名为 channel / connector / bridge / gateway 的「外部 IM 消息进出 agent」seam**（全仓 grep `ctx.channel|ctx.connector|ctx.bridge|ctx.gateway`、`dsh-channel` 均无命中；`docs/capability-seams.md` 92 行 seam 表无此类）。

- 最接近的入站面是 `ctx.webhookRuntime`（fire-and-forget）
- **出站完全没有投递 seam**，必须自己监听事件
- 微信 channel 插件 ≈ **自己写「入站适配器 + 会话映射表 + 出站订阅转发器」三块**

## 1. 入站通道现状

**现成可复用的入站面只有两层**：
1. `ctx.webhookRuntime`：外部 webhook → 可选创建 root Session（`packages/webhook/webhook/src/index.ts:58,73`）
2. **底层 agent 输入 API**（所有入站最终都走这里）：`Agent.send / followup / steer / inject`（`packages/core/agent/src/runtime-types.ts:215,222,231,241`）

**`webhookRuntime` 明确不支持的**（`docs/subsystems/webhook.md:23` 原文）：
> "The runtime has **no queue, retry, deduplication, execution status, crash replay, Agent-status listener, or completion result**. Repeated delivery may create repeated Sessions."

`dispatch()` 是 fire-and-forget，"returns before any callback settles"（`:21`）；创建 Session 后 "does not specially flush or wait for the turn"（`:29`）。

**ACP / SDK 的定位**：都是「**外部客户端驱动 DSH**」的进程边界协议，**不是** IM 通道。
- ACP：JSON-RPC over stdio（`packages/acp/acp/README.md:12`）
- SDK：newline-delimited JSON-RPC，方法只有 `initialize / session/prompt / shutdown`（`packages/sdk/protocol/src/types.ts:114-118`）
- **本质区别**：ACP/SDK 是「外部进程 = 另一个 client」，client 自己管理 session 身份；而 IM 通道是「外部消息 = 输入源，DSH 自己拥有会话」，且需要 微信会话ID ↔ SessionId 映射。用 ACP/SDK 会引入多余进程，且拿不到 in-process 的 `ctx.*`（如 `workspaceRegistry`、`commands`）

## 2. 命令分发给适配器（★ 现成可复用）

`ctx.commands`（`CommandRuntime`）挂在 base 系 profile（`packages/bundle/base/cordis.patch.yml:308`）。

**确切签名**（`docs/subsystems/commands.md:195`，实现 `packages/interaction/commands/src/index.ts:362-368`）：

```ts
@Remote async execute(
  agent: Agent,
  line: string,
  submittedAttachments: readonly CommandSubmitAttachment[],
  signal: AbortSignal,
): Promise<CommandExecution | undefined>
```

- 返回 `undefined` = 语法不合法**或**未知命令名（两者都返回 undefined，不区分）
- 辅助：`list(agent)`、`find(agent, name)`、`register(definition)`
- **非 Web 适配器调用范式**（`packages/interaction/commands/README.md:60-62`）：
  > "An interactive adapter calls `execute(agent, line, attachments, signal)` with the exact receiving agent, the full command line, and the submission's ordered attachments."

**语法规则**（`src/index.ts:126`）：
```ts
/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u
```
斜杠必须在 **byte zero**；名称小写字母开头；后接输入结束或空白。`rawInput` 保留分隔空白。

**返回值**：
```ts
type CommandResult =
  | { kind: 'success'; text?: string; sourceEventSeq?: SessionSeq }
  | { kind: 'error'; text: string }
```
结果是「**直接 UI 输出，不是 tool result、不是 session event**」。
`recordInput` 默认 `true`（把 `rawInput` 写进 `command/run` 的 `args`）。

生命周期：`command/run` 先 append → 调 handler → `command/done` 结算；两者都是 **log-only、无 turn 包裹**。

**现成调用点**：Host 侧仅 `packages/api/session-controller/src/client/sessions/session.ts:388`；Web 侧 `packages/client/ui-commands/src/client/service.ts:406`。
→ **没有现成的「非 Web、in-process 外部通道」dispatch 范例**；建议直接 inject `commands` 后调 `ctx.commands.execute(agent, line, [], signal)`。

## 3. 出站投递 / 主动推送

**明确不存在** outbound/delivery/notification seam。最接近的表述是 `docs/architecture.md:157`「Add UI or editor integration | drive `ctx.agents` and render from `session/event`」。
→ **必须自己造**：监听 `session/event`（durable）或 `agent/assistant-stream`（live）。

唯一「通知类」抽象是 `ctx.otel` 的 reporting channel，**与用户消息投递无关**。

**可作为主动推送事件源，但都需自己订阅转发**：

| 服务 | 事件 | 订阅方式 |
|---|---|---|
| `ctx.jobs` | `registered/progress/stopping/removed/settled/output` | **不是 ctx.on**，而是 `ctx.jobs.events.subscribe(filter, listener)` |
| `ctx.goals` | `goal/changed`（scoped）、`goal/activation-changed` | `ctx.on(...)` |
| `ctx.schedule` | `schedule/changed` | `ctx.on(...)`；**投递本身是 `agent.followup()`** |

> ⚠️ `docs/user/guide/schedule.md:63` 明确："This is not an execution history or an external notification channel."
> 这三个只能当**触发器**，推送动作必须自己写。

**deliverables / message-feedback 均非投递抽象**：
- `deliverables` 的 `presented` / `workspace/changes` 是 **log-only 事件**，"Only clients read them"
- `messageFeedback` 是**人对输出打分**（入站方向），但微信 👍/👎 可落这里

**不存在**任何「投递目标（recipient）/ notification」抽象。

## 4. 流式输出：`agent/assistant-stream`

```ts
| { type:'start'; attemptId; revision; turn; step }
| { type:'chunk'; attemptId; revision; index; time; chunk }   // 密集、0 基
| { type:'end'; attemptId; revision; index;
    outcome: { kind:'committed'; eventType; seq } | { kind:'abandoned' } }
```

- **process-local**：chunk 是 transient
- **durable 规则**（`packages/core/agent/README.md:67`）：
  > "The loop commits the complete compact stream as one `assistant/message` or `assistant/attempt` **before** a committed end frame, so the live event remains presentation data rather than the replay source."
- 硬进程丢失在 settlement 之前 → **没有 durable attempt stream**

**能否边生成边发微信**：技术可行（范例 `packages/bundle/headless/src/index.ts:121-159`），但：
1. chunk transient，跨重启丢失
2. 更稳：**用 `end{committed}` 或 durable `assistant/message` 作为提交点再发微信**，chunk 仅用于「正在输入…」预览
3. 目前 live event 的远程消费者只有 Web 一个，微信插件是**第二个消费者**（in-process 无限制）

## 5. 会话与工作目录

**创建 agent 时 cwd 通过 `meta.cwd`**：
- `ctx.agents.create(options)`（`packages/core/agent/src/index.ts:391`）
- `meta?: { cwd?; parentSession?; isSeeded?; origin?; delegationDepth?; agentPreset? }`（`:79-86`）
- cwd 落到 **immutable `SessionHeader.cwd`**（`packages/core/session/src/types.ts:105`）

**现成范例**（可直接照抄，`packages/webhook/webhook/src/session.ts:131-143`）：
```ts
const workspace = await ctx.workspaceRegistry.create(resolved.workspacePath)
const handle = await ctx.agents.create({
  sessionId, signal,
  meta: { cwd: workspace.path, agentPreset: preset.id },
})
await workspace.attachSession(sessionId)
```

**★ 运行时切换 cwd：明确不存在**
- `SessionHeader` 是 immutable metadata，`cwd` 为 `readonly`
- 全仓 grep `setCwd|changeCwd|updateCwd|switchWorkspace` 无实现
- **后果**：一个 Session 的 cwd 终生固定。**换目录 = 新建 Session。**
- 另注：adopt 已存在 session 时 cwd 必须完全相等，否则 `ApiSessionCwdConflict`（`packages/api/session-controller/src/agent.ts:272-273`）

**`dsh-workspace` 的准确 key 是 `ctx.workspaceRegistry`**（不是 `ctx.workspace`）：
- 定位：可选 host 能力，**只为 GUI 项目列表服务**，对模型不可见
- 关系：**一个 Workspace 多个 Session；一个 Session 至多属于一个 Workspace**
- membership 是**双重校验**：既在 `sessionIds` 账上，`SessionHeader.cwd` 的 canonical 值又要等于 `workspace.path`
- `create()` 要求**已存在的绝对目录**，否则 reject
- **若不需 GUI 项目列表，可以不挂 workspace，直接 `meta.cwd`**

## 6. 可复用的插件骨架

**没有真正对等的「独立外部通道」插件**，但有三个结构模板：

| 参考 | 价值 |
|---|---|
| `packages/webhook/webhook-github` | **入站适配器**规范写法：认证 + 路由 + 归一化事件。`inject = ['webServer','webhookRuntime','credentials']`；`ctx.effect(() => ctx.webServer.register(route))` |
| `packages/webhook/webhook` | **Service 类插件**规范写法 + 声明合并 |
| `packages/experimental/agent-team` | **最接近 channel 的形态**：Service 类 + 多事件订阅 + `MessageSourceMap` 声明合并 |

**★ 入站消息源标记（重要、易漏）**：新增外部来源应声明合并 `MessageSourceMap`：
```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { wechat: { kind: 'wechat'; ... } }
}
```
先例：webhook（`packages/webhook/webhook/src/types.ts:71-84`）、schedule、agent-team。
`session-controller` 会按 source 区分：`event.data.source.kind !== 'user'` 时不算 activity。

**cordis.patch.yml 格式**：insert / 覆盖既有行（**整体替换 config，不深合并**）/ `disabled: !!js` 条件装配。真实例子见 `packages/experimental/schedule-bundle/cordis.patch.yml`。

**apply() 两种合法导出形态（不可混用）**：
- `export function apply(ctx, config)` + 可选 `export const inject` / `Config`
- 或 default export 一个 Service 类
- 所有资源注册必须包 `ctx.effect` / `ctx.on` 并返回清理函数

配置校验器是 **Schemastery**（`import z from '@deepseek-ai/schemastery'`），**非 zod**。

**安装途径三条**，官方推荐 `install_bundle`（传绝对包目录作 target）或 `dsh plugin`；
**官方明确反对**手改 profile 的 `package.json` / `cordis.patch.yml`。

**若插件要挂 HTTP 路由**：必须 `inject: ['webServer']`；重复 `(kind,path)` 会 throw；
webhook 适配器的做法是**挂到隔离的第二个 WebServer**，避免暴露浏览器 API——微信回调建议照此。

## 7. 汇总三分法

**现成可复用**
- 入站注入：`Agent.followup/steer/inject/send`
- 命令分发：`ctx.commands.execute(agent, line, [], signal)`
- 会话创建 + cwd 绑定：`ctx.agents.create({meta:{cwd}})`
- 可选工作目录登记：`ctx.workspaceRegistry`
- 出站事件源：`ctx.on('session/event', ...)`
- 流式预览：`ctx.on('agent/assistant-stream', ...)`
- 入站 HTTP 路由：`ctx.webServer.register(...)`
- 消息来源标记：declaration-merge `MessageSourceMap`
- 人对消息评分：`ctx.messageFeedback`（微信 👍/👎）

**需自己造**
- 微信侧入站：登录/长轮询/验签 + **微信会话ID→SessionId 映射表**（DSH 无此抽象）
- 微信侧出站：`assistant/message` → 微信消息，含分段、限流、重试（DSH 无 retry/queue）
- 多轮并发与去重：需自己保证「同一微信会话串行」
- 主动推送触发器：自己 `ctx.jobs.events.subscribe(...)`

**明确不存在**
- channel / connector / bridge seam
- 出站投递 seam / 投递目标 / 通知抽象
- **运行时切换 cwd**（`SessionHeader.cwd` immutable）
- `webhookRuntime` 的 completion result / 回执 / 去重 / crash replay
- ACP/SDK 作为 IM 通道

## 8. 对项目的含义

1. **工作量确认**：DSH 没有 channel seam，所以「三块自造」（入站适配器 + 映射表 + 出站转发器）是**无论谁做都必须付的成本**——这也解释了为什么已有的两个包都需要 37 个版本迭代。
2. **命令分发是唯一现成的、可直接复用的通道**——`ctx.commands.execute()` 四参数签名 + 非 Web adapter 调用范式都有明确指引。
3. **Q8 的「工作目录用户可选」有硬约束**：cwd 终身不可变，**换目录必须新建 Session**。设计上要把它表达成「切换工作区 = 切换/新建会话」。
4. **`MessageSourceMap` 声明合并是必做项**，否则微信消息在 session log 里没有来源标记，违反「模型可见⟺logged」的精神。
