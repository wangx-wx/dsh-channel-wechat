# 侦察报告 06：会话桥接 API 精确签名

> 来源：子任务 7ec0e179（只读调查，DSH 仓库 @ 4878cda / release 0.2.0-rc.1）

## ★ 首先：纠正一个方案中的错误

**方案 §5.2 推荐的 `source: { kind: 'plugin', plugin: 'wechat' }` 是无效写法。**

- `packages/core/agent/README.md:56` 的该示例是**过时错误文档**
- format v4 **明确拒绝** `kind:'plugin'`（`packages/session/session-format-v3-to-v4/src/message-sources.ts:9-10`），会话持久化时抛 `SessionFormatError`

**正确做法（两档，按是否需要 human authority）**：

| 情形 | 做法 |
|---|---|
| 需要人类权限（如 goal 工具把 `{kind:'user'}` 当"人类指令"） | `source: { kind: 'user' }`，必要时声明自己的 `rpcId` 做请求关联 |
| 需要独立归属语义 / 不继承人类权限 | 在自己包里 declare-merge 新 kind，如 `wechat-message`，只含字符串/数字原语 |

先例：`packages/webhook/webhook/src/types.ts:71-83`、`packages/schedule/schedule/src/runtime.ts:4-8`。
约束：任何 `kind` 必须是非空字符串且**不能是 `plugin`**。

## 1. create / resume / AgentHandle

```ts
export interface CreateAgentOptions {
  readonly sessionId: SessionId
  readonly parentAgent?: Agent
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly isSeeded?: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  readonly inheritedEventCount?: SessionLogOffset
  readonly seed?: readonly SessionEvent[]
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup
}

export interface ResumeAgentOptions {
  readonly resumeSessionId: SessionId
  readonly parentAgent?: Agent
  readonly agentOptions?: AgentOptions
  readonly signal?: AbortSignal
  readonly setup?: AgentSetup
}
```

- `AgentRegistry.create(options): Promise<AgentHandle>`（`index.ts:391`）
- `AgentRegistry.resume(options): Promise<AgentHandle>`（`:410`）
- **都不接收 ctx 参数**（ownerCtx 由 registry 从 `this.ctx` 取）
- **resume 没有** `meta` / `seed` / `inheritedEventCount` —— cwd/lineage 来自持久化 header
- `AgentHandle`（`:160-163`）**只有** `agent: Agent` 和 `dispose(): Promise<void>`；消息/等待方法在 `Agent` 上

`AgentOptions`（`runtime-types.ts:26-35`）：`provider?`、`model?`、`reasoningEffort?: ReasoningEffortId`、`maxTokens?`（+ merge 扩展 `subagentDepth?`）

## 2. followup / steer / inject

```ts
followup(message: UserMessage): void      // :222
steer(message: UserMessage): void         // :231
inject(message: UserMessage): void        // :241
```

内部实现 `packages/core/agent-loop/src/agent.ts:154-173`：
- `followup` = `send(msg,'next-turn',true)` —— 队首下一轮普通消息并**唤醒**
- `steer` = `send(msg,'next-step',true)` —— 下一步边界消费并唤醒（idle 时开新轮）
- `inject` = `send(msg,'next-step',false)` —— 只投模型可见上下文，**不唤醒**

**选 `followup`**（把微信消息当作一轮独立对话）；`steer` 只用于"打断当前轮补充信息"；`inject` 不产生回合、拿不到回复。

## 3. 等完成 + 取最终文本

**等**：`await agent.whenIdle()`（`:191`，实现 `agent.ts:237-242`）。
⚠️ **`whenIdle` 是 whole-agent 静默，不标识某条消息。** 仓库准则（`docs/defensive-patterns.md:17`）：自动化调用方必须自己定义区间，例如「从该消息的持久 inbox 回执到下一次 idle」，并把输出描述为区间输出。

**精确关联**：监听 `session/event` 直到 `agent/inbox/spliced` 的 `inserted` 含自己的 `message.id`（SDK 做法 `packages/sdk/client/src/api.ts:199-213`），再 `whenIdle()`。

**取文本（按稳定性排序）**：

| 方式 | 位置 | 评价 |
|---|---|---|
| `ctx.sessionProjections.stateOf(session,'turnOutline')` | `packages/session/session-turn-outline/src/types.ts:15-38` | **最稳**，但 `entry.response` 是**有界预览（120 字符）**，只适合短回复 |
| `ctx.on('session/event')` 取 `assistant/message` | payload `packages/core/session/src/types.ts:341-349`；参考实现 `packages/sdk/client/src/api.ts:300-311` | **完整文本**，推荐 |
| `finalAssistantOutput(events)` | `packages/subagent/subagent/src/assistant-output.ts:67`（root 导出） | 能跑，但**定位是子运行结果规则**，作为通用 IM 读取属越界使用，无稳定性承诺 |
| `sessionController` Remote / `ctx.sessionQuery.observeSession()` | `packages/api/session-controller/src/index.ts:425-521`、`packages/session-query/session-query/src/index.ts:140` | **最公开稳定的远程面** |
| `session.snapshotEvents()` / `eventAt()` / `ownEvents()` | `packages/core/session/src/index.ts:629-666` | **已 deprecated，禁止新代码使用** |

**结论**：没有比「session log + projection」更官方的单方法读取；正确写法是**自建 `session/event` 订阅**（或 turnOutline projection）取区间输出。

## 4. 入站图片

`ctx.attachments`（`@deepseek-ai/dsh-attachment`）：

```ts
async admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>  // :114
admitEncodedFile(input): Promise<FileAttachmentRef>   // :137
async saveImages(inputs): Promise<readonly ImageAttachmentRef[]>   // :98
abstract saveImage(input): Promise<ImageAttachmentRef>  // :158
abstract readImage(ref, signal?): Promise<StoredImageAttachment>   // :167
saveFile(input): Promise<FileAttachmentRef>   // :188
saveFileStream(input): Promise<FileAttachmentRef>   // :203
abstract readonly imageLimits: ImageAttachmentLimits   // :59
```

类型：`PromptContentPart` = `{type:'text',text}` | `{type:'image',mediaType,data,name?}`（base64）；`AttachmentAdmissionPart` 多一个 `{type:'file',attachment}`；`AdmittedPromptContentPart` 的 image 变成 `{type:'image',attachment:ImageAttachmentRef}`。

⚠️ **ContentBlock 的 image/file 只接受 durable ref**（`packages/llm/llm/src/types.ts:79-105`），**裸 base64 无法进消息**。

```ts
const [part] = await ctx.attachments.admitPromptContent([
  { type:'image', mediaType:'image/jpeg', data: base64 }
])
agent.followup(createUserMessage({ content:[part], source:{ kind:'wechat-message' } }))
```

- 多类型一次传整个 parts 数组（`admitPromptContent` 保序）
- 模型不支持图片时，先查 `ctx.llm.resolveModelInfo(...).inputModalities.includes('image')`（参考 `packages/api/session-controller/src/commands.ts:337-352`）
- 并发图片准入要串行化（`ApiSessionAgentController.serializeImageAdmission`，`packages/api/session-controller/src/agent.ts:370`）
- `attachments` 未挂载时 `ctx.get('attachments')` 返回 undefined，**需显式判空**

## 5. resume 前置条件与失败表现

- **必须挂载 `sessionPersistence`**，否则抛 `Error('cannot resume: session persistence is not configured...')`（`packages/core/agent-loop/src/index.ts:807-812`）
- **会话不存在 → 抛错，不返回 undefined**：`SessionPersistenceNotFoundError`（`packages/session/session-persistence/src/errors.ts:13-19`）
- 另一路持有写租约 → `SessionAlreadyOwnedError`（`errors.ts:31-37`）
- **惯用法**：先 `ctx.sessionQuery.observeSession(id)` 判断存在性（`SESSION_QUERY_SESSION_NOT_FOUND`），不存在就 `create`，存在才 `resume`（headless 就这么做：`packages/bundle/headless/src/index.ts:245-290`）
- `resume` 会修复崩溃留下的未闭合 turn（补 `turn/end {kind:'interrupted'}`）

## 6. 创建时指定 preset / 模型

| 项 | 做法 |
|---|---|
| **模型** | `agentOptions = { provider, model, reasoningEffort?, maxTokens? }`；或在 `setup` 里 `installModelSelection` |
| **agent preset** | **不在顶层选项**。`meta.agentPreset?: string` 仅持久化标签；真正 mount 靠 `setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId) }`（`packages/preset/agent-preset-registry/src/index.ts:257`） |
| **权限 preset** | **不在 create 选项里**。先 `ctx.permissionPresets.resolve(name)` 校验（`:369`），创建后 `ctx.permissionPresets.set(session, name)`（`:398`）。默认名 `workspace-write` / `danger-full-access` |

## 7. runtime root 与生命周期坑

- 省略 `parentAgent` → **runtime root**；传才是 child（额外要求子会话由父拥有）。`meta.parentSession` 只是持久化血缘，**不影响 runtime 关系**
- **必须 dispose**：`handle.dispose()` 停 loop → await 退出 → 注销 registry → 移除 session → unwind scope
- 不 dispose 的后果：
  - agent 留在 registry，session 留在 store；**重名 create 抛错**
  - 写租约不释放 → 同 id resume 抛 `SessionAlreadyOwnedError`
  - 进程活着时只能靠显式 dispose（owner fiber 卸载才自动 teardown）
- ⚠️ **已 dispose 的旧 agent 上 `followup()` 静默接受、消息丢失**。SDK 因此每次校验 `ctx.agents.get(id) !== agent`（`packages/sdk/server/src/server.ts:182-201`）—— **务必做存活校验**

**「一个微信对端一个会话」建议**：
- 用 `Map<peerId, AgentHandle>` 持有 handle
- 或会话常驻（每对端一个长驻 root）+ 只 followup，注意内存与写租约长期占用
- **同一 peer 的消息必须串行化**（多轮 followup 会连续开轮，`whenIdle` 无法区分归属）

## 8. 对方案的影响

1. **§5.2 必须改**：`kind:'plugin'` → `kind:'wechat-message'`（declare-merge）或 `kind:'user'`
2. **§5.3 取回复**：`finalAssistantOutput` 是从 subagent 借来的，**应改为自建 `session/event` 订阅**取 `assistant/message`（或 turnOutline 做短回复）
3. **`whenIdle` 语义需正确使用**：它是 whole-agent 静默，必须配 inbox 回执界定区间
4. **必须 dispose**，且 followup 前要做 `ctx.agents.get(id) === agent` 存活校验（否则消息静默丢失）
5. **resume 会抛错**，需先 `observeSession` 探测存在性
6. **图片必须经 `admitPromptContent` 转 durable ref**，裸 base64 进不了消息
