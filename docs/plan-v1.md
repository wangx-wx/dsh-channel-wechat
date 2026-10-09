# dsh-channel-wechat — v1 实施方案（定稿）

> 状态：**决策完成，待用户确认后开始编码**
> 仓库：`https://github.com/wangx-wx/dsh-channel-wechat.git`
> 本地：`/Users/wangx/cc/dsh-channel-wechat/`
> 包名：`dsh-channel-wechat`（npm 404 可用）
> 依据：13 份侦察报告（见 `docs/recon/`）

---

## 0. 一句话

用 DSH 的官方契约重写一个微信（iLink / ClawBot）通道插件：**协议层移植腾讯官方实现**（保真度 + 测试基线），**DSH 集成层全新写**（类型安全、遵循官方 API），补齐两个现有实现各自的缺口。

## 1. 差异化定位

| 对比项 | `dsh-wechat` 0.9.11 | `dsh-weixin` 0.2.1 | **本插件** |
|---|---|---|---|
| 语言/类型 | TS strict | 纯 JS 无类型 | **TS strict** |
| 协议保真 | 入站媒体三处缺口 | 无 `-14`/去重，未读 aeskey | **对齐官方文档 + 移植官方测试** |
| 斜杠命令 | 17 个 | 无 | **DSH 原生透传 + 6 个自管** |
| 并发 | 串行阻塞长轮询 | 串行阻塞 | **解耦：长轮询独立，`/stop` 可打断** |
| DSH 契约 | 鸭子类型耦合 | 鸭子类型耦合 | **官方 API（类型安全）** |
| 面板 | 自建 HTTP API | 零鉴权 HTTP 面板 | **正规客户端插件（slot，自动两端）** |
| 多工作目录 | 有 | 无 | **有（对齐 GUI 语义）** |

**不追求超越 `dsh-wechat` 的功能广度，追求「协议正确 + 契约正规」。**

## 2. 决策台账（Q1–Q40）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 受众 | 开源插件，操作者=使用者；**不设计权限体系** |
| Q2 | 协议层归属 | 自实现协议客户端，以官方为规范 |
| Q3 | 定位 | **DSH 的一个 channel**（完整通道实现） |
| Q4/Q27 | 运行形态 | **不预设 profile**，不依赖 profile 特有服务；web/headless 均可 |
| Q5 | 回复投递 | 整段投递 + 输入状态（对齐官方） |
| Q6/Q36 | 并发 | **解耦长轮询与处理**；消息进队列，每用户串行；`/stop` 可打断 |
| Q7 | 会话生命周期 | 长期复用 + 斜杠命令 |
| Q8/Q38 | 工作目录 | **多目录、会话级绑定**；`/cwd` = 结束当前会话并在新目录新建 |
| Q9/Q22 | 消息类型 | **全部对齐**：文本/图片/语音/文件/视频/引用 |
| Q10 | 主动推送 | v1 预留接口，**v2 实现** |
| Q11 | channel 含义 | 完整通道实现 |
| Q12 | 包形态 | **单包**（同时是插件与 bundle） |
| Q13 | 登录态 | **解耦**：`login` 一次性扫码写凭证；运行态自动读取 |
| Q14/Q29 | 凭证 | **`ctx.credentials`**；其余自管 JSON（0600 原子写） |
| Q15/Q28 | 包名 | **`dsh-channel-wechat`** |
| Q16/Q23 | 斜杠命令 | DSH 原生透传 + 自管 6 个（`/stop` `/status` `/cwd` `/new` `/help` `/reconnect`） |
| Q17/Q21 | 代码起点 | **移植官方协议层 + 全新写 DSH 集成层** |
| Q18 | 差异化 | 功能缺失 / 无命令 / 协议不纯粹 → **完整 + 正规** |
| Q19 | 工作区 | 参考 GUI 多工作区（切换 = 切 Session） |
| Q20 | 长连接 | 微信侧不可；DSH 侧用进程内 `ctx.on` |
| Q24/Q33 | 审批卡 | **审批卡 v1；提问卡 v2** |
| Q25 | 多账号 | 单账号（数据结构预留 accountId 维度） |
| Q26 | 质量标准 | **TS strict + 协议层单测 + 真组合测试** |
| Q30 | 移植策略 | **全面移植 (a)+(b)**，连带官方测试；MIT 署名 |
| Q31 | 里程碑 | **垂直切片** |
| Q32 | 面板 | **正规客户端插件**（`dsh.client` + slot）；CLI 登录同时保留 |
| Q34 | 落地位置 | `/Users/wangx/cc/dsh-channel-wechat/` |
| Q35 | 去重/限流 | **对齐官方：都不做** |
| Q37 | `source.kind` | **`'user'`**（用户接受其语义） |
| Q39 | 面板内容 | 状态 + 会话映射 + 日志 + reconnect/logout |
| Q40 | 仓库/License | `github.com/wangx-wx/dsh-channel-wechat`；**MIT** |

## 3. 架构

```
微信用户 ⇄ 腾讯 iLink ⇄ dsh-channel-wechat（DSH 进程内）
                          │
        ┌─────────────────┴──────────────────┐
        │ wechat/  协议层（移植官方）          │
        │   api  auth  cdn  media  types      │
        ├─────────────────────────────────────┤
        │ channel/ 通道层（全新写）            │
        │   monitor（长轮询，独立循环）        │
        │   queue（每用户串行）                │
        │   outbound（分段/发送/typing）       │
        ├─────────────────────────────────────┤
        │ bridge/  桥接层（全新写）            │
        │   peer-map   userId → sessionId      │
        │   dispatcher 消息 → agent.followup   │
        │   reply      事件 → 微信             │
        │   commands   ctx.commands + 自管     │
        │   cards      审批卡（waterfall）     │
        ├─────────────────────────────────────┤
        │ client/  客户端半边（slot 设置页卡片）│
        └─────────────────────────────────────┘
                    │
          ctx.agents / ctx.commands / ctx.credentials
          ctx.attachments / ctx.on('session/event')
```

**三条分层纪律**（Q26「纯粹」的落地）：
1. `wechat/` **不 import 任何 `@deepseek-ai/*`**（纯协议）
2. `bridge/` 只用**官方文档化的 API**，不用 `ctx.get()` 拿未声明服务
3. 所有 `@deepseek-ai/*` 用 **peer + dev** 声明（含预发布段）

## 4. 包结构

```
dsh-channel-wechat/
├─ package.json          # dsh.bundle + dsh.client + exports
├─ cordis.patch.yml      # 只注册 Host 半边
├─ tsconfig.json
├─ tsdown.config.ts      # 方案 A：复刻 clientBundle（recon/13）
├─ LICENSE               # MIT + Tencent 版权声明
├─ README.md / README.zh.md
├─ THIRD_PARTY_NOTICES.md
├─ src/
│  ├─ index.ts           # 主插件：name/inject/Config/apply
│  ├─ config.ts          # Schemastery Config
│  ├─ startup.ts         # cmdline provider（login/logout/status）
│  ├─ wechat/            # ── 协议层（移植，标注来源）──
│  │  ├─ types.ts        api.ts        auth.ts
│  │  ├─ cdn.ts          media.ts      crypto.ts
│  │  └─ session-guard.ts
│  ├─ channel/           # ── 通道层（全新）──
│  │  ├─ monitor.ts      # 长轮询独立循环
│  │  ├─ queue.ts        # 每用户串行队列
│  │  ├─ outbound.ts     # 分段 + 发送 + typing
│  │  └─ errors.ts
│  ├─ bridge/            # ── 桥接层（全新）──
│  │  ├─ peer-map.ts     dispatcher.ts  reply.ts
│  │  ├─ commands.ts     cards.ts       workspaces.ts
│  │  └─ source.ts       # MessageSourceMap 不需（用 'user'）
│  └─ client/            # ── 客户端半边 ──
│     ├─ index.ts        # slot 注册
│     └─ Panel.tsx
├─ tests/
│  ├─ unit/              # 协议层单测（移植官方）
│  └─ integration/       # 真组合测试（boot cordis.yml）
└─ docs/
   ├─ recon/             # 13 份侦察报告
   └─ plan-v1.md         # 本文件
```

## 5. 关键实现要点（全部有侦察依据）

### 5.1 入站注入
```ts
agent.followup(createUserMessage({
  content: parts,                    // 经 admitPromptContent 转 durable ref
  source: { kind: 'user' },
}))
```
- 图片/文件：`ctx.attachments.admitPromptContent([...])` → **裸 base64 进不了消息**
- `attachments` 未挂载时 `ctx.get('attachments')` 返回 undefined，**需判空**
- 模型不支持图片时先查 `ctx.llm.resolveModelInfo(...).inputModalities.includes('image')`

### 5.2 回复投递
```ts
ctx.on('session/event', (session, event) => { ... })   // 取 assistant/message
```
- **`whenIdle()` 是 whole-agent 静默**，必须先等 inbox 回执界定区间
- **不用** `turnOutline`（120 字符预览）、**不用** `finalAssistantOutput`（越界）、**不用** deprecated 的 `snapshotEvents()`
- 出站**必须自建队列**（微信侧无补投/重放）

### 5.3 生命周期
- `Map<peerId, AgentHandle>`，必要时 dispose
- followup 前校验 `ctx.agents.get(id) === agent`（**已 dispose 的 agent 上 followup 静默丢消息**）
- `resume` 会抛错 → 先 `sessionQuery.observeSession()` 探测存在性

### 5.4 并发（Q36）
```
monitor: while(true) { await getUpdates → 入队 }     ← 独立循环，不阻塞
queue:   每用户串行消费 → agent.followup → whenIdle
/stop:   agent.cancel()
```

### 5.5 工作目录（Q38）
- 默认目录来自 `Config.cwd`
- `/cwd <path>` = **结束当前会话、在该目录新建会话**（cwd 不可变）
- v1 **不挂 `workspaceRegistry`**（它只在 web-app bundle），会话落 GUI「未分组」桶；v2 再接

### 5.6 审批卡（Q24/Q33）
```ts
ctx.on('approval/request', handler, { prepend: true })   // 必须 prepend + 不带 tag
```
- **必须自己造**：卡片 id、竞速、回执、超时、渲染、fork signal
- **`forkGuiCardSignal` 是未文档化依赖** → 必须标注技术债 + 加回归测试
- v1 只做审批卡（有 durable 审计）；提问卡 v2
- ⚠️ v1 不做提问卡 → **必须做防御**，否则 `ask_user_question` 会整轮卡住

### 5.7 客户端面板（Q32/Q39）
- `dsh.client = { platform: 'web', inject: [...] }` + `exports["./client"]`
- **自动同时覆盖 web 与桌面端**（桌面 = Electron 壳 + 完整 Web 应用）
- 用 `ctx.slots.register('settings.section', ...)` 复用 DSH UI
- 构建走**方案 A**（tsdown 复刻），必须含 `chunkFileNames` + CSS loader
- **自建构建期纯度检查**（仓库外没有官方那道门）

### 5.8 协议层移植义务
- 每个移植文件头部：`Adapted from @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)`
- 仓库根 `LICENSE` 含 Tencent MIT 全文
- `THIRD_PARTY_NOTICES.md` 记录来源

## 6. 里程碑（垂直切片）

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M0 骨架** ✅ | 包结构 + 插件骨架 + 真组合测试跑通 | ~~日志有插件名~~ → **cordis fiber 达到 ACTIVE**（见下方修订） |
| **M1 登录** | 移植 `auth` + `startup.ts` + 凭证进 `ctx.credentials` | `dsh channel-wechat login` 扫码成功，重启免登录 |
| **M2 文本端到端** | 移植 `api` + monitor 长轮询 + queue + dispatcher + reply | 微信发「hi」→ DSH 回复到达 |
| **M3 命令** | `ctx.commands` 透传 + 6 个自管命令 + `/stop` | `/plan off` 有原生回执；`/stop` 能中断正在跑的任务 |
| **M4 媒体** | 移植 `cdn`/`media` + 图片/文件/语音/视频双向 + 引用 | 发图能理解；产出文件能收到 |
| **M5 审批卡** | waterfall 监听 + 卡片渲染 + 竞速 + fork signal | 微信能批准/拒绝；GUI 卡同步消失 |
| **M6 面板** | 客户端插件 + 构建管线 + 设置页卡片 | web 与桌面端都看到卡片；登录态/映射/日志正确 |
| **M7 发布** | README 双语 + LICENSE + npm 发布 | `dsh plugin add dsh-channel-wechat` 一条命令装好 |

**M2 是第一个真实闭环**，也是「集成契约是否正确」的验证点——协议层移植量最大，但风险最高的是全新写的集成层。

### M0 完成后的验收标准修订（2026-10-09）

原 M0 验收写作「日志有插件名」，**实测该验收不可行**，两处硬阻断：

1. `packages/bundle/web-app/src/index.ts:288` 把 `auditStartupEntries` 的 warn sink 传成 `() => {}`，
   所以 `pending (waiting for service: X)` 之类诊断**不出现在 stderr**；
2. named-logger 在该表面**没有 console exporter**：`info`/`warn`/`error` 三级均不输出。

→ **已挂载与未挂载的插件产生相同的启动输出。** 故验收改为**进程内断言 `fiber.state === ACTIVE(2)`**，
与 DSH 自身 `app-boot` 测试的做法一致。M0 的 3 个 seam 全部通过且经变异验证。

**同时新增 3 条后续里程碑必须遵守的环境事实**：

- `dsh <profile> <app>` 写法非法（`too many arguments`）；正确形式是 `dsh <profile> [app-args]`，
  app 由 profile 的 `dsh.profile.bundles` 决定；
- `DSH_HOME` 可重定向 → 所有集成测试用隔离 home，不碰用户 profile；
- 本机 npm/pnpm 默认 cache 不可写（EPERM）→ 用 `pnpm-workspace.yaml` 的 `storeDir: .pnpm-store`。
  ⚠️ **不是** `.npmrc` 的 `store-dir`——pnpm 11 静默忽略后者（实测：改成绝对路径/任意值，
  `pnpm store path` 均不变），早期记录此处有误，已更正。


## 7. 已知风险与技术债

| 风险 | 说明 | 对策 |
|---|---|---|
| **`forkGuiCardSignal` 未文档化** | 依赖 `req` 共享可变 + GUI 用 `req.signal` 当展示寿命 | 标注技术债；加「微信答→GUI 卡消失」回归测试 |
| **`prepend: true` 漏了静默失败** | 不加则永远轮不到，无报错 | 单测断言 handler 被调用 |
| **`kind:'user'` 语义** | 微信消息继承人类授权（用户已接受） | 若接群聊/不可信来源，改 declare-merge 自建 kind |
| **构建纯度门在仓库外不可用** | 漏检 → 浏览器运行时报错 | 自建构建期检查脚本 |
| **`errcode -14` 未实测** | 会话过期行为需真机验证 | M2 后用测试号实测 |
| **群体无依据** | 协议未定义 | 已划掉，不做 |
| **主动推送需历史会话** | `context_token` 只来自入站 | README 写明；v2 实现 |
| **微信侧无补投** | 发送失败即丢 | 自建出站队列 |

## 8. 不做的事（明确边界）

- ❌ 群聊（协议无依据，recon/10）
- ❌ 多账号运行期（v1 单账号，数据结构预留）
- ❌ 消息去重 / 发送节流（Q35 对齐官方）
- ❌ 提问卡（v2）
- ❌ 主动推送（v2，接口预留）
- ❌ 独立 HTTP 面板（用客户端插件替代）
- ❌ 自建权限体系（Q1）

## 9. 下一步

1. 用户确认本方案
2. 建目录结构 + `package.json`/`tsconfig`/`tsdown.config.ts`
3. 从 **M0 骨架**开始编码

---

## 附：许可与致谢

- 协议规范与部分实现来自腾讯 [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（MIT）
- 工程实践参考 `wechat-claude-code`（MIT）
- 本插件许可：**MIT**
