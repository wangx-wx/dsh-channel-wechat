# DSH 微信插件设计方案（v0.2，待评审）

> 目标：写一个 **DSH 插件**，让微信里的机器人成为 DSH 的入口——用户在微信发消息，DSH 起任务、干活、把结果发回微信。
> 微信协议依据**腾讯官方**开源项目 [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 及其官方公开协议文档，不依赖其运行。
>
> v0.2 修订：撤回 v0.1 中「非官方协议 / 风控风险」的错误判断，详见 [事实核查.md](./事实核查.md)。

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 交付物 | 一个 DSH 插件包，GitHub 维护，`dsh plugin add` 安装 |
| 微信接入 | 插件进程内直连 iLink 协议（`ilinkai.weixin.qq.com`），不依赖 OpenClaw |
| 协议依据 | 腾讯官方 `openclaw-weixin` 的公开协议文档（MIT），按文档实现 |
| DSH 接入 | `ctx.agents.create()/resume()` 驱动会话，`whenIdle()` 后取最终回复 |
| 登录 | 插件自带 cmdline provider（`dsh wechat login`），**不做 package bin** |
| 会话映射 | 一个微信对端 = 一个 DSH Session，持久化映射 |
| 回复 | v1 整轮结束发一次 + 输入状态；v2 再上中间进度 |

**需注意的边界**：官方协议文档自述其范围是「当前插件的行为」，**不等于完整服务端契约**；插件未覆盖的边界行为需在 P0 阶段实测验证。见 §8。

---

## 1. 目标与非目标

### 目标
1. 微信单聊发消息 → DSH 建/续会话 → 执行 → 回复发回微信。
2. 支持文字、图片、文件（v1 至少文字 + 图片）。
3. 扫码登录一次，凭证持久化，重启免登录。
4. 长轮询稳定运行：session 过期自恢复、游标续传、去重；限流/熔断作为可配置自保项。
5. 完全符合 DSH 插件规范，能过 harness 的门禁。

### 非目标
- 不做群聊（协议上支持，但 v1 不做，且你确认过只单聊）。
- 不做 Web UI 面板（v1；v2 可选 settings 卡片）。
- 不提供 HTTP 服务端 / webhook 入口——DSH 只允许 `dsh` profile 启动应用。
- 不实现 OpenClaw 插件形态。

---

## 2. 微信侧协议（依据腾讯官方协议文档）

### 2.1 端点与鉴权

Base：`https://ilinkai.weixin.qq.com`

每个 CGI 请求带 header：

```
Content-Type: application/json
Authorization: Bearer <botToken>
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <随机 base64 4 字节>
```

### 2.2 登录（扫码）

```
GET  /ilink/bot/get_bot_qrcode?bot_type=3
   → { ret, qrcode, qrcode_img_content }

GET  /ilink/bot/get_qrcode_status?qrcode=<id>      # 每 3s 轮询，超时 60s
   → status: wait | scaned | confirmed | expired
   confirmed → { bot_token, ilink_bot_id, baseurl, ilink_user_id }
```

`qrcode_img_content` 是二维码内容，需本地渲染成图（终端用 `qrcode-terminal`）。

### 2.3 收消息（长轮询）

```
POST /ilink/bot/getupdates    { get_updates_buf? }     # 超时 35s
  → { ret, sync_buf, get_updates_buf, msgs[] }
```

`WeixinMessage` 关键字段：

```ts
{
  seq?, message_id?, from_user_id?, to_user_id?, create_time_ms?,
  message_type?, message_state?, item_list?: MessageItem[], context_token?
}
```

- `context_token`：**每消息下发，回发时必须原样带回**。按 `accountId:userId` 持久化，重启后仍要用。
- `get_updates_buf`：长轮询游标，需持久化以便断线续传。

### 2.4 发消息

```
POST /ilink/bot/sendmessage   { msg: { to_user_id, ... }, ... }
POST /ilink/bot/sendtyping    { ilink_user_id, typing_ticket, status }
POST /ilink/bot/getconfig     { ilink_user_id, context_token? }  → typing_ticket
```

### 2.5 媒体

```
POST /ilink/bot/getuploadurl  → upload_param
     CDN: https://novac2c.cdn.weixin.qq.com/c2c  (AES-128-ECB 加密上传)
```

参考项目里 `src/cdn/`（加密、上传、图片解密）是完整可参考的实现。

### 2.6 稳定性要点

分两类——**官方协议要求的**必须实现，**第三方项目自保的**作为可选配置。

**（a）官方协议要求（必须实现）**

| 机制 | 依据 | 说明 |
|---|---|---|
| 会话过期处理 | 官方文档 `getUpdates` 行：`ret` 或 `errcode` 为 `-14` 触发**一小时**账号会话暂停 | `bot_token` 失效，暂停后需重新扫码；官方 `session-guard.ts` 即此实现 |
| 游标持久化 | 官方文档：仅当返回的 `get_updates_buf` 非空才保存并更新 | 断线续传 |
| `context_token` 回传 | 官方文档接入建议：回复会话时回传入站消息的 `context_token` | 缺失时官方也会发，但「不能证明服务端一定接受」 |
| 上传成功判定 | 官方文档：HTTP 200 **且** `x-encrypted-param` 非空 | 4xx 立即终止，其他失败最多 3 次 |
| 启动/停止通知 | 官方文档：启动发 `notifyStart`，停止发 `notifyStop` | 生命周期信号 |
| 二维码状态机 | 官方文档 8 态：`wait`/`scaned`/`confirmed`/`expired`/`need_verifycode`/`verify_code_blocked`/`scaned_but_redirect`/`binded_redirect` | 含 `redirect_host` 切换与验证码分支 |

**（b）可选自保措施（来自第三方 `wechat-claude-code`，非官方要求）**

> 核查确认：腾讯官方插件**没有**发送节流与熔断，说明不节流直发是可接受的。
> 以下作为 `Config` 可调项保留，默认值待 P0 实测决定。

| 机制 | 参考参数 | 说明 |
|---|---|---|
| 发送节流 | 同用户间隔 2500ms | 第三方为防限流所加；官方无此实现 |
| 熔断 | 30s 窗口内首次限流 → 断 30s | 第三方代码注释自陈借鉴 Hermes 适配器 |
| 消息去重 | 按 `message_id` 保留最近 1000 条 | 长轮询可能重发，属防御性 |
| 待发队列 | 失败消息落盘，下条消息到达时 flush | 依赖「新消息重置配额」这一第三方假设，需实测 |
| 消息分片 | 微信单条长度上限 | 长回复切开，官方文档未给上限值，需实测 |

**判断标准**：官方文档有明文的一律实现；仅第三方有的先做成可配置、默认关闭或保守，P0 实测后再定默认值。

---

## 3. 架构总览

```
┌─────────┐   微信协议     ┌──────────────────────────────────────┐
│  微信    │ ◄──────────► │            DSH 进程                    │
│  用户    │  长轮询/发送   │                                      │
└─────────┘               │  ┌────────────────────────────────┐  │
                          │  │ dsh-wechat 插件                 │  │
                          │  │                                │  │
                          │  │  wechat/  协议客户端            │  │
                          │  │    login  accounts  api         │  │
                          │  │    monitor(长轮询) send  media  │  │
                          │  │         │                       │  │
                          │  │  bridge/ 会话桥                │  │
                          │  │    peer-map    对端→SessionId   │  │
                          │  │    dispatcher  消息→agent       │  │
                          │  │    reply       结果→微信        │  │
                          │  │         │                       │  │
                          │  │         ▼                       │  │
                          │  │  ctx.agents / ctx.attachments   │  │
                          │  └────────────────────────────────┘  │
                          │  Session log（的唯一真相源）          │
                          └──────────────────────────────────────┘
```

**关键原则**：微信侧只做协议与传输，不持有对话状态；**对话状态的唯一真相源是 DSH session log**，对端映射表只存 `userId → SessionId` 这种指针。

---

## 4. 包结构

单包（不做 monorepo）：

```
dsh-wechat/
├─ package.json          # name/@scope, type:module, dsh.bundle, prepare 脚本
├─ cordis.patch.yml      # bundle 层：插入插件行
├─ tsconfig.json
├─ src/
│  ├─ index.ts           # 主插件：name/inject/Config/apply
│  ├─ login-cli.ts       # cmdline provider：dsh wechat login/logout/status
│  ├─ wechat/
│  │  ├─ api.ts          # 6 个端点 + 限流/熔断
│  │  ├─ login.ts        # 扫码两阶段
│  │  ├─ accounts.ts     # 账号凭证持久化
│  │  ├─ monitor.ts      # 长轮询 + 断线退避 + 去重
│  │  ├─ send.ts         # 发送 + 分片 + 输入状态
│  │  ├─ media.ts        # 图片/文件收发
│  │  ├─ crypto.ts       # AES-128-ECB
│  │  ├─ types.ts        # 协议类型
│  │  └─ errors.ts       # ret 码分类
│  ├─ bridge/
│  │  ├─ peer-map.ts     # userId → SessionId 持久映射
│  │  ├─ dispatcher.ts   # 入站消息 → agent
│  │  ├─ reply.ts        # whenIdle → 取回复 → 发送
│  │  └─ commands.ts     # /reset /status 等
│  └─ config.ts
├─ tests/
└─ README.md
```

依赖声明（依据 [recon/03](./recon/03-依赖声明与发布规则.md)）：

| 包 | 位置 | 理由 |
|---|---|---|
| `@deepseek-ai/cordis` | peer + dev | 框架实例必须与宿主共享 |
| `@deepseek-ai/dsh-agent` | peer + dev | 跨实例身份 |
| `@deepseek-ai/dsh-session` | peer + dev | `SESSION_FORMAT_VERSION` 需共享 |
| `@deepseek-ai/dsh-credentials` | peer + dev | 若只 import `credentialKey` 可放 dependencies |
| `@deepseek-ai/dsh-cmdline` | peer + dev | 作为普通插件引用（app 组合包才放 dependencies） |
| `@deepseek-ai/schemastery` | **dependencies** | 运行时校验器，官方明示；跨拷贝靠 `Symbol.for` |
| `commander`、`zod`、`qrcode-terminal` | dependencies | 独立第三方 |

> ⚠️ **peer 版本区间必须含预发布段**。宿主是 `0.2.0-rc.1`，实测 `"^0.2.0"` 对它是 **false**（安装被拒），必须写 `"^0.2.0-rc.1"` 或 `"*"`。
> ⚠️ 不要用 `latest`：官方包的 latest tag 停在旧版本（`dsh-*` 甚至为 `0.0.1-rc.1`）。

---

## 5. 关键设计决策

### 5.1 会话映射

```ts
// storage domain，非 session 数据
type PeerRecord = {
  sessionId: string        // DSH Session
  createdAt: number
  lastSeenAt: number
  // 不存对话内容——那是 session log 的职责
}
// key: `${accountId}:${peerUserId}`（单聊时即 userId）
```

- 首次来消息 → `ctx.agents.create({ sessionId, agentOptions })` → 记录映射。
- 后续 → `ctx.agents.resume({ sessionId })`；resume 失败（session 被删）→ 清映射、重建。
- 存储选 `ctx.storageDomain`（需要 `dsh-storage` + backend 挂载）或插件自管 JSON 文件。**建议后者**：少一个部署依赖，且这份数据丢了只是重建会话。

### 5.2 入站消息 → DSH

**这是最关键的合规点：模型可见 ⟺ logged。**

```ts
agent.followup(createUserMessage({
  content: [part],
  source: { kind: 'wechat-message' },   // 需 declare-merge，见下
}))
```

**★ 修正（v0.3）**：v0.2 曾写 `source: { kind: 'plugin', plugin: 'wechat' }`，**这是无效的**。`packages/core/agent/README.md:56` 的该示例是过时文档；format v4 **明确拒绝** `kind:'plugin'`，持久化时抛 `SessionFormatError`。详见 [recon/06](./recon/06-会话桥接API精确签名.md)。

正确做法是 declare-merge 自己的 kind：

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'wechat-message': { kind: 'wechat-message'; fromUserId: string; messageId: string }
  }
}
```

选 `kind:'wechat-message'`（独立归属语义）而非 `kind:'user'`：后者会被 goal 等工具当作「人类指令」，而微信消息不等于本机用户操作。先例见 `packages/webhook/webhook/src/types.ts:71-83`。

- 必须走 `followup()`（= `send(msg,'next-turn',true)`），不能是进程内临时变量——否则模型看到了日志里没有的东西。
- `steer` 只用于「打断当前轮补充信息」；`inject` 不产生回合、拿不到回复。
- 图片/文件经 `ctx.attachments.admitPromptContent()` 落成 **durable ref**，再以内容块进入消息。**裸 base64 无法进消息**（`packages/llm/llm/src/types.ts:79-105`），也不能只传 URL。

```ts
const [part] = await ctx.attachments.admitPromptContent([
  { type: 'image', mediaType: 'image/jpeg', data: base64 },
])
```

- 模型不支持图片时先查 `ctx.llm.resolveModelInfo(...).inputModalities.includes('image')`。
- `attachments` 未挂载时 `ctx.get('attachments')` 返回 undefined，**需显式判空**。

### 5.3 回复投递

```
agent.followup(msg)
  → 立刻 startTyping()（微信顶部"对方正在输入"）
  → 超过 N 分钟未完成，发一条安抚消息
  → 等待「本条消息的持久 inbox 回执」再 whenIdle()     ← 见下
  → 从 session log 订阅取本轮 assistant/message 文本
  → splitMessage() 分片 → sendText()
```

**★ 修正（v0.3）**：v0.2 写「取最终输出用 `finalAssistantOutput`」——它虽然从 `@deepseek-ai/dsh-subagent` 根导出且能跑，但**定位是子代理运行结果规则**，作为通用 IM 读取属越界使用，无稳定性承诺。

正确做法：**自建 `session/event` 订阅**取 `assistant/message`：

```ts
ctx.on('session/event', (session, event) => {
  if (event.type !== 'assistant/message') return
  const text = event.data.message.content
    .filter(b => b.type === 'text').map(b => b.text).join('')
})
```
（参考实现 `packages/sdk/client/src/api.ts:300-311`）

**`whenIdle()` 的正确用法**：它是 **whole-agent 静默，不标识某条消息**。仓库准则（`docs/defensive-patterns.md:17`）要求自动化调用方**自己定义区间**：先监听 `session/event` 直到 `agent/inbox/spliced` 的 `inserted` 含自己的 `message.id`（SDK 做法 `packages/sdk/client/src/api.ts:199-213`），再 `whenIdle()`。

**不要用** `session.snapshotEvents()` / `eventAt()` / `ownEvents()`——已 `@deprecated`，新代码禁止。
**不要用** `sessionProjections` 的 `turnOutline` 取正文——它的 `response` 是 **120 字符有界预览**，只能做短回复。

**生命周期必做**：
- 持有 `Map<peerId, AgentHandle>`，必要时 `dispose()`
- followup 前校验 `ctx.agents.get(id) === agent` —— **已 dispose 的 agent 上 followup 会静默接受、消息丢失**
- 同一 peer 的消息必须串行化（`whenIdle` 不区分归属）

**create vs resume**：`resume` 在会话不存在时**抛错**（`SessionPersistenceNotFoundError`），且要求挂载 `sessionPersistence`。惯用法是先 `ctx.sessionQuery.observeSession(id)` 探测存在性，不存在才 `create`。

**v2 中间进度**：监听 `session/event` 或 `agent/assistant-stream`，按工具 `phase=start/end` 分流——参考 [recon/04](./recon/04-官方渠道行为核对.md)（官方只报工具名+状态，丢弃入参/结果正文）。

### 5.4 登录与二维码呈现（已验证可行）

DSH **禁止 package bin 与独立应用入口**（`verify-application-entrypoints` 会把它们全部拒绝）。所以不能在插件包里放 `bin/login.js`。

正确做法：**cmdline provider + consumer 两段式结构**。依据见 [recon/02](./recon/02-命令行入口与二维码登录.md)。

**已验证**：`dsh wechat login` → profile = `wechat`，app-args = `["login"]`，`login` 不会被吃掉（源码 + 运行时实测 + 官方单测三重确认）。

```ts
// startup.ts —— provider 行，发布服务
import { Command } from 'commander'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

export const name = 'wechat-startup'
export const inject = ['cmdlineArgs']          // 唯一必需注入

export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile wechat')
    .argument('[action]', 'login to print the QR code')

  program.action(() => {
    const action = program.args[0]
    if (action !== undefined && action !== 'login') {
      program.error(`error: unknown action ${JSON.stringify(action)}`)
    }
    ctx.provide('wechatStartup', { action })   // 必须先校验、后发布
  })

  parseCmdline(ctx, program)                   // 必须在 action 之后
}
```

```yaml
- insert:
    - id: wechat-startup
      name: '@acme/dsh-wechat/startup'
    - id: wechat-login
      name: '@acme/dsh-wechat/login'
      inject: [wechatStartup]
      config:
        action: !!js ctx.wechatStartup.action ?? 'none'
```

**契约要点**：`parseCmdline` 走 `ctx.get()` 取 `cmdlineArgs`/`appExit`；程序必须至少有一个 command 声明 action；help/错误路径会 `appExit` 且**不发布服务**，因此依赖它的行不会激活。

**二维码呈现方式（按推荐度）**：
1. **终端 ASCII + stdout** —— 推荐，与 `dsh wechat login` 的交互模型同构（先例：web-app 启动后 `console.log` 打印 URL）
2. 注册 HTTP 路由渲染二维码页并打印 URL
3. 自带 client 半边做设置卡片/Plugins 页面（最重，可显示登录状态）

> ⚠️ **没有兜底机制**：官方文档明言「没有读取方的应用会忽略自己的参数」。若插件不解析 `login`，`dsh wechat login` 会**静默什么都不做**。登录入口必须由插件自己提供。
> ⚠️ 终端二维码在 DSH 仓库**无第一方先例**，也没有包依赖 `qrcode`；需自带编码器（`qrcode-terminal` 为候选）。

### 5.5 凭证与状态存储

| 数据 | 位置 | 理由 |
|---|---|---|
| `botToken` | `ctx.credentials.set(ref, ...)` | 插件持有的授权凭证，正是 credentials 的设计用途；配置与日志永不出现明文 |
| `context_token` | 插件自管文件（0600） | 协议运行时状态，非用户秘密 |
| `get_updates_buf` | 同上 | 断线续传游标 |
| `userId → sessionId` | 同上 | 指针数据，丢了重建 |
| 待发队列 | 同上 | 发送失败时暂存，下条消息到达时重试（依赖第三方假设，待实测） |

### 5.6 媒体

- 入站图片/文件 → 下载解密 → `ctx.attachments` 提交 → 作为内容块进消息。
- 出站 → 从 session 里识别产出文件（`deliverables` seam）→ CDN 加密上传 → 发送。
- v1 可以只做入站图片 + 出站纯文本，媒体留在 v2。

### 5.7 并发与串行化

- 单聊下同一用户的消息**必须串行**：正在处理时新消息要么排队、要么打断（`cancel()`）。
- 建议 v1 用「正在处理则排队」，配合 `/reset` 清理；比 `steer()` 打断更可预期。
- 长轮询循环必须挂在 `ctx.effect()` 上，插件卸载时能干净停止。

### 5.8 指令面

两个选择：

- **A**：复用 DSH 的 `ctx.commands.register()`——微信 `/plan`、`/reset` 直接打到 DSH 命令面，与 Web UI 共享语义。
- **B**：插件自管 slash 命令（像参考项目那样 `/clear` `/model` `/status`）。

**建议 A 为主 + B 兜底**：DSH 原生命令走 `ctx.commands`，机器人运行状态类命令（`/reconnect`、`/whoami`）插件自管。注意 DSH 命令语法要求「斜杠在字节零位 + 小写名」，与微信侧一致，天然兼容。

---

## 6. DSH 约束合规检查

| 约束 | 本方案怎么做 |
|---|---|
| 只有 `dsh` profile 能启动应用 | 不做 bin；登录走 cmdline provider |
| 插件导出形态二选一 | 函数插件：`name`/`inject`/`Config`/`apply`，**无 default export** |
| 注册即 effect | 长轮询、监听器全部 `ctx.effect()` 包裹，dispose 可停 |
| 模型可见 ⟺ logged | 入站消息走 `followup()`，图片走 attachments |
| 无硬编码 tunable | 轮询间隔、限流窗口、超时、分片长度全部进 `Config` |
| 配置错误大声失败 | 缺 `botToken` 时加载即报错，不静默空转 |
| 不新增 `as unknown` | 协议 JSON 在**边界**做 zod/schemastery 校验后转类型 |
| 跨边界 id 用 branded | `SessionId` 已是 branded；`peerUserId` 建议 `Branded` |
| 包 README 与 JSDoc | 按 `docs/cookbook/adding-a-package.md` 补齐，含 Model Experience 段 |
| 真组合测试 | 必须有 boot 真实 `cordis.yml` 的测试，不能只 `ctx.plugin()` 手挂 |

---

## 7. 分阶段计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 验证** | 扫码登录 + 长轮询 + 收一条消息回显 | 终端扫码成功，微信发「hi」能收到「hi」 |
| **P1 桥接** | 接 `ctx.agents`，一通完整对话 | 微信提问 → DSH 执行 → 回复到达 |
| **P2 稳定** | 限流/熔断/过期恢复/去重/分片 | 杀进程重启后免登录且能续聊 |
| **P3 媒体** | 图片入站、文件出站 | 发图能理解，产出文件能收到 |
| **P4 打包** | bundle manifest、README、CI、npm 发布 | `dsh plugin add` 一条命令装好 |

**P0 先做**：它是唯一能证伪整个方案的地方（协议是否仍按文档工作、边界行为是否与文档一致）。

---

## 8. 风险与未决问题

### 真实风险

1. **协议文档的覆盖面小于服务端实际契约**。官方文档自述：「客户端类型和行为**不能代表完整的服务端契约**……超出这些源码所体现范围的服务端要求，需要**另行验证**」。自行实现时，插件未覆盖的边界行为（某字段服务端是否必填、错误码分支、消息长度上限）需实测确认。**这是主要风险，且属于文档完备性问题，不是安全性问题。**
2. **会话会真实过期**。`errcode -14` 表示 `bot_token` 失效，官方处理为暂停 1 小时后重新扫码。需对齐实现，否则表现为静默停止收消息。
3. **协议随版本演进**。官方以 `channel_version` 上报版本，并有 `assertHostCompatibility` 做宿主版本门禁。建议本插件也做版本探测，失败时**明确报错**而非静默降级。

> 已撤回：v0.1 曾称本协议「非官方」「有风控封号风险」。核查确认 `openclaw-weixin` 为腾讯官方 MIT 项目且协议文档公开，**该判断无依据，详见 [事实核查.md](./事实核查.md)**。

### 需你决策
4. **回复投递**：v1 只发最终结果（推荐，不刷屏），还是同时发中间进度？
5. **并发策略**：处理中来的新消息，排队还是打断？
6. **会话生命周期**：长期复用同一 Session（靠 compaction 控上下文），还是支持 `/reset` 手动重开？
7. **工作目录**：DSH agent 在哪个 workspace 干活？固定目录，还是按微信用户映射？
8. **权限 preset**：微信是外部输入源，v1 给什么权限？**建议最小权限 + 显式白名单。**

### 待实测确认
9. ~~`dsh wechat login` 的 app-args 传递路径~~ —— **已解决**，见 [recon/02](./recon/02-命令行入口与二维码登录.md)。
10. 微信单条消息长度上限（官方文档未给出，影响分片策略）。
11. 是否需要发送节流/熔断（官方无此实现，先做成可配置，实测定默认值）。
12. 企微/个人微信是否都能用同一协议（官方 README 针对个人微信扫码）。
13. **协议实现分歧项 5 处**（限流语义、非零 ret 时是否保存游标、消息去重必要性、并发模型、`ret:-2` 含义）——两实现行为不一致，需真机抓包判定。见 [recon/01 §5](./recon/01-协议层移植可行性.md)。
14. **终端二维码渲染**：DSH 无第一方先例，需自带编码器。
15. **out-of-tree 发布链路**：仓库内无完整可发布实例可参考，需自行趟通。

---

## 9. 验收标准（v1）

- [ ] 终端扫码登录成功，凭证落 `ctx.credentials`，重启免登录
- [ ] 微信单聊发文字，DSH 建会话并回复，session log 里有带 `source` 的 durable user message
- [ ] 图片入站能被模型看到
- [ ] 进程杀掉重启后，同一用户继续原会话
- [ ] 遇 `errcode -14` 时暂停并按文档恢复，不静默失联
- [ ] 插件 dispose 后长轮询停止，无残留连接
- [ ] `cordis.yml` 真组合测试 + 单元测试通过
- [ ] README 含 config 表、Model Experience、Known Limitations

---

## 附：与两个参考项目的关系

| | `wechat-claude-code` | `openclaw-weixin` | 本方案 |
|---|---|---|---|
| 形态 | 独立 CLI/daemon | OpenClaw 插件 | **DSH 插件** |
| 微信协议 | 自实现 | 自实现 | 复用同一套 iLink 协议 |
| 大脑 | Claude Code（CLI 子进程） | OpenClaw agent | **DSH agent** |
| 可参考 | `src/wechat/` 全套协议、`TurnRouter`、分片、限流 | `src/api/`、`src/messaging/`、渠道抽象、媒体 | 两者都参考协议层，桥接层自己写 |

**不直接依赖它们**：两者都不是 npm 可复用的协议库（`openclaw-weixin` 强依赖 `openclaw` peer）。协议实现需在本插件内独立完成，但可以按 MIT 许可参考甚至移植相关代码——**发布前需确认两个项目的 LICENSE 与署名要求**。
