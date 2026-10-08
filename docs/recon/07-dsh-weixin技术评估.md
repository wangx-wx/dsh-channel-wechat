# 侦察报告 07：dsh-weixin 0.2.1 技术评估

> 来源：子任务 97085b95（只读分析）
> 源码：`_analysis/dsh-weixin/npm/package/`（npm tarball）与 `_analysis/dsh-weixin/gh/dsh-weixin-main/`（GitHub main）
> **交叉验证**：npm 0.2.1 与 GitHub main 的 7 个文件**逐字节相同**；npm 包直接附带完整 `.mjs` 源码（非仅构建产物）

## 1. 架构

标准 Cordis 组合包：1 个宿主插件 + 3 个纯 JS 模块 + 1 个 CLI。`index.mjs` 仅 3 行 re-export 壳。

| 文件 | 行数 | 职责 |
|---|---:|---|
| `index.mjs` | 3 | re-export `name/inject/Config/apply` |
| `src/index.mjs` | 645 | 插件本体：Config、`WeixinChannel` 类、`apply()`、`registerPushTool`、`chunkText` |
| `src/ilink.mjs` | 331 | iLink HTTP 协议 + CDN 媒体下载解密（**无 DSH 依赖**） |
| `src/panel.mjs` | 377 | `/weixin` 面板路由 + 内联 HTML |
| `src/creds.mjs` | 59 | 状态存储（原子写 + 0600） |
| `bin/login.mjs` | 165 | CLI 扫码登录（终端半块字符渲染二维码） |

源码合计约 1595 行。

## 2. 协议实现

自实现（`src/ilink.mjs`），注释声明「协议细节对齐腾讯官方 @tencent-weixin/openclaw-weixin」，硬编码官方版本号 `2.4.6`。

**覆盖度**

| 项 | 状态 | 位置 |
|---|---|---|
| 扫码登录 | ✅ 完整，8 状态全覆盖，二维码最多刷新 3 次 | `ilink.mjs:109,122`；`panel.mjs:20,135,164` |
| 长轮询 | ✅ 35s 超时，超时转空结果，退避 `min(1000*failures,15s)` | `ilink.mjs:15,72-74,130`；`index.mjs:151` |
| 发送文本 | ✅ | `ilink.mjs:142` |
| `sendTyping`/`getConfig`/`notifyStart·Stop` | ✅ | `ilink.mjs:207,192,222,229` |
| CDN 媒体 | ⚠️ **仅下载，无上传** | `ilink.mjs:274,264,254-261,245` |

**关键细节**

| 项 | 状态 | 说明 |
|---|---|---|
| `context_token` 回带 | ✅ 入站提取 + 出站塞入 | ⚠️ **但主动推送不带**：`push()` 调 `sendReply(t, undefined, text)`（`index.mjs:545`） |
| 游标持久化 | ✅ `updates-buf.json` | `index.mjs:81,140-143` |
| **`errcode -14`** | ❌ **完全未处理** | 全仓 grep `errcode\|-14` 零命中；**从不检查 `getUpdates` 的 `ret`** |
| **消息去重** | ❌ **无** | grep `message_id\|msg_id\|dedup\|seen` 零命中 |
| 限流 `ret=-2` 退避 | ✅ 指数退避 2s→16s，maxAttempts=5 | `ilink.mjs:160-190` |
| 发送侧调速 | ✅ `paceSend` 保证间隔 ≥ 2000ms | `index.mjs:497-505` |

> ⚠️ **`errcode -14` 缺口**：对照官方协议文档「任一字段为 -14 时触发一小时的账号会话暂停」——表现为**账号被静默暂停后插件无退避地空转轮询**。

## 3. DSH 集成方式

- **形态：函数式插件**（非 Service 类）。`export function apply(ctx, config)`（`index.mjs:590`）
- `inject = ['webServer','agents','tools','attachments']`（硬依赖）
- 用到的 ctx 服务：`webServer.register`、`agents.get/resume/create`、`tools.register`、`attachments.imageLimits/saveImage`；可选探测 `ctx.get()`：`agentPresets`/`agentDefaultModel`/`llm`
- 生命周期：`ctx.on('session/event')`、`ctx.on('dispose')`、`ctx.effect`
- **对外服务**：`ctx.provide('weixin', {push, sendAll, status, sessions})`（普通对象，非 Service 子类）
- `cordis.patch.yml` 仅 6 行，插一行按包名引用

## 4. 会话模型

- 映射：`session-map.json`（`{微信用户id → sessionId}`）
- 策略：**每微信用户一个独立会话**；`ensureAgentFor` 三级：内存活跃 → `agents.get` → `agents.resume` → 新建
- `cwd`：默认 `stateDir/workspace`，经 `meta.cwd` 传入
  - ⚠️ **推测**：`cwd` 只在 **create** 时传，**resume 分支未重申**（可能刻意，可能疏漏）
- **串行架构**：`handleInbound` 用 `await new Promise(...)` 等整轮结束（`index.mjs:327-346`），长轮询循环 await 它（`:146`）→ 天然单轮串行；`this.collector` 是**单字段**，靠串行保证不被覆盖
  - README「单轮串行」是**架构性事实**，非待办项

## 5. 能力清单

| 类型 | 状态 |
|---|---|
| 文字 | ✅ |
| 语音 | ✅ 走腾讯服务端转写 `voice_item.text`，无本地 ASR |
| 图片 | ⚠️ 收 + CDN 解密 + 存附件；**受视觉能力门控**（`llm.resolveModelInfo` 的 `inputModalities.includes('image')`），纯文本模型下不注入、直接友好提示 |
| 文件/视频/其它 | ❌ 提示「暂不支持」 |

**Slash 命令：❌ 没有**（grep `slash|command|/reset|/new|/help` 零命中）。README 承认「无内置清空上下文入口」，只能删 `session-map.json`。

**主动推送：✅ 三入口齐全**
1. `ctx.weixin` 服务（`push`/`sendAll`/`status`/`sessions`）
2. HTTP `POST /weixin/send`（`{to,text}`，`to:'all'` 广播）
3. 工具 `push_weixin`（缺省发给触发会话所属微信用户，适合 schedule 场景）

## 6. UI 面板 —— ★ 严重安全问题

实现：`ctx.webServer.register({kind:'prefix', path:'/weixin', handler})`，包在 `ctx.effect` 里。**主机端直出 HTML**，无需客户端插件构建。

路由：`GET /weixin`、`/weixin/status`、`/weixin/qr.svg`、`/weixin/logs`；`POST /weixin/login`、`/verifycode`、`/send`、`/logout`

### ❌ 完全没有鉴权

handler 内（`panel.mjs:237-271`）**无任何 token/session/origin 校验**。README 自己承认「没有鉴权……是本项目的 TODO」。

**可被利用的攻击面**（源码确认）：
- (a) `POST /weixin/logout` —— **登出机器人**
- (b) `POST /weixin/send` —— **以机器人身份向任意用户甚至 `to:'all'` 全量广播**
- (c) `GET /weixin/status` —— 读全部 `sessionMap`（微信用户 id）
- (d) `GET /weixin/logs` —— 读最近 200 条日志（含截断到 12 字符的用户 id，**不含 token**）
- (e) `POST /weixin/verifycode` —— 干扰登录流程

无 CSRF/Origin 防护。唯一缓解是 README 的「仅可信环境」建议。
**缓解项**：请求体 1MB 上限（`panel.mjs:35-55`）

## 7. 代码质量

- **类型：纯 JS ESM（`.mjs`），无 TypeScript、无 tsconfig、无 JSDoc 标注**。配置校验靠运行期 Schemastery
- **测试：4 个文件 37 个用例，实测全部通过**（Node v24.16）。覆盖限流退避、凭据原子写、会话关联、emoji 代理对切分、调速、推送计数、typing 幂等、视觉门控等
- **错误处理偏严谨**：大量 try/catch 降级、300 条环形日志、`stopTypingOnce` 幂等防重复
- 源码密集出现 `review S1..S12 / I1,I2,I4 / 二轮 N1,N2` 注释 → **经两轮评审并按条修复**
- CI：只有 tag 触发的 `publish.yml`；无 lint、无普通 push CI
- 缺口：无入站去重、无 `errcode -14`、不检查 `getUpdates.ret`

## 8. 依赖策略

```json
"dependencies": { "@deepseek-ai/schemastery": "^3.18.1", "qrcode-generator": "^2.0.4" }
```

**「不依赖其他 @deepseek-ai 包」的两条手段**：
1. **一切 DSH 能力走运行期服务定位**（`ctx.agents`/`ctx.tools`/…），不 import 任何 `@deepseek-ai/dsh-*` 模块
2. **手动复刻极小的类型构造函数**：自己拼 `{...input, role:'user', id:'msg-'+randomUUID()}`，注释明写「等价 createUserMessage（避免依赖独立安装时版本漂移）」

**代价**：与宿主内部事件契约是**鸭子类型耦合**——`session/event` 的事件形状无类型或版本护栏，Harness 侧契约一改就**静默失效**。

## 9. 结论摘要

**优点**：真实可用、无 native 依赖、源码随 npm 发布且与 GitHub 一致、37 项单测全绿、协议层自实现且覆盖扫码/长轮询/文本发送/图片解密。

**三个确定性缺口**：
1. **无 `/weixin` 鉴权**（README 已承认，**最高风险**）
2. **无消息去重**
3. **未处理 `errcode -14` 暂停语义、不检查 `getUpdates.ret`**

**两处推测**：`cwd` 在 resume 分支未重申；全局单 `collector` 字段依赖串行设计（脆弱但有保障）。

**它没有的**：Slash 命令（全部没有）、CDN 上传（不能发图片/文件/语音）、多账号。

## 10. 对本项目的含义

1. **鉴权缺口是可以立即改进的点**：DSH 的 `ctx.webServer` 有 `/api` 鉴权边界（侦察报告 05 提到 webhook 适配器用**隔离的第二个 WebServer**），这正好是解法。
2. **`errcode -14` 与去重是有明确正确解的**——官方实现（侦察报告 04）两者都有，直接对齐即可。
3. **它把 `context_token`/游标都做对了**，说明协议层不是难点；**难点在 DSH 侧的事件契约耦合**（鸭子类型无护栏）。
4. **它的鸭子类型策略是双刃剑**：好处是零 `@deepseek-ai` 运行时依赖、安装轻；坏处是宿主契约变更会静默失效。而我们已知 DSH 正处于 pre-stable（0.2.0-rc.1），契约还会变。
