# 本项目依赖的契约面

这份清单回答一个问题：**DSH 改了什么东西会伤到我们**。
`scripts/check-contract.sh` 会机械地核对它们；这里记的是「为什么它在清单里」
以及「改坏后长什么样」。

前两层是静默的——这决定了核查顺序。

## 一、服务名（`ctx.get` / `inject`）

**症状：返回 `undefined`，功能消失，启动一切正常，没有任何报错。**
大多数是可选的（`ctx.get` 而非 `inject`，见 `AGENTS.md` 的「可选服务」条），
所以缺了就是少一个能力，不是崩溃——这正是它危险的地方。

| 名字 | 用途 | 拿不到时 |
|---|---|---|
| `credentials` | 微信登录态读写 | 无法登录/读不到已存登录 |
| `llm` | 附件、模型信息 | 图片/文件降级为文字说明 |
| `attachments` | 附件存储 | 同上 |
| `commands` | 斜杠命令注册 | 命令不可用 |
| `agentPresets` | 预设选择 | 用默认预设 |
| `permissionPresets` | 权限预设 | 用默认权限 |
| `sessionPersistence` | 会话存在性探测 | **起跑前探测失效**，重启会丢入站消息 |
| `agentDefaultModel` | 当前模型选择 | 模型选择不对（`ctx.agents` 不套默认模型） |
| `webServer` | 登录面板端口 | 面板不挂载 |
| `appExit` | 退出动作 | `login` 动作无法收尾 |
| `cmdlineArgs` | `login`/`logout`/`status` | 命令行动作失效 |
| `connection`（走 `ctx.inject`） | 浏览器连接 | 面板不出现 |

`agents` 和 `commands` 声明在 `inject` 里（`src/index.ts:168`），缺了会
**整行 parking**——那是响亮的。其余走 `ctx.get`。

## 二、会话事件名（`session/event` 的 type）

**症状：跑得完一轮，但什么都不回。看起来完全健康。**

| 事件 | 用途 |
|---|---|
| `assistant/message` | 回复的唯一来源（durable 事件，不是流式片段） |
| `deliverables/presented` | 唯一该发出去的出站文件声明 |
| `approval/request` / `user-questions/request` | 交互卡（waterfall，必须 `{ prepend: true }`） |

权威清单是 `packages/core/session/src/known-event-types.ts`（生成物）。
它在 `0.2.0-rc.2 → 0.2.1-rc.1` 间只加了三个（`job/registered`、`job/settled`、
`working-directory/change`），两个我们用的都没动。

**注意**：`deliverables/presented` 与 `assistant/message` 都不在
`docs/event-producer-consumer.md` 里（那是 `ctx.emit` 的矩阵），别因此判断它们不存在。

## 三、客户端 slot

| slot | 用途 | 症状 |
|---|---|---|
| `plugins.bundle.config` | 插件详情页的配置区（keyed by npm 包名） | 配置区不渲染，**无报错** |

权威清单是 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`
（生成物，4900+ 行，含每个 seat 的「由谁挂载才存在」）。它在
`0.2.0-rc.2 → 0.2.1-rc.1` 间 +908/−196，但 `plugins.bundle.config` 的定义与
example 都没变——**这是「大改动里我们那一小块恰好没动」的典型样本**。

那个 catalog 里 `plugins.bundle.config` 的 example 就是一段可用的注册代码；
写新 slot 时抄它，比猜参数可靠。

## 四、清单字段

| 字段 | 谁读 | 改坏的后果 |
|---|---|---|
| `engines.dsh` | `evaluatePluginCompatibility` | **一旦存在就单独决定，peer 完全不参与** |
| `peerDependencies` | 同上，仅当无 `engines.dsh` | 回退路径的判定 |
| `dsh.bundle.patch` | profile loader | 指向的 patch 不被加载 |
| `dsh.client.inject` | 浏览器半边 | 页面拿不到依赖的服务 |

`engines.dsh` 的坑：`^0.2.0` **不含** `0.2.0-rc.2`（caret 挂 release 会排除同号预发布）。
实测可通过的写法是 `>=0.2.0-rc.1`。判定用 `includePrerelease: true`。

## 五、导入符号（`@deepseek-ai/*`）

签名由 typecheck 守，这里关心的是**名字还在不在**（重命名先于类型错误）。

| 包 | 符号 | 位置 |
|---|---|---|
| `dsh-llm` | `createUserMessage`、`ContentBlock`、`UserMessage` | `packages/core/llm` |
| `dsh-session` | `SessionId`、`SessionEvent` | `packages/core/session` |
| `dsh-credentials` | `credentialKey`、`CredentialKey` | `packages/core/credentials` |
| `dsh-home-paths` | `resolveDshHome` | `packages/core/home-paths` |
| `dsh-cmdline` | `parseCmdline` | `packages/boot/cmdline` |
| `dsh-attachment` | `FileAttachmentRef`、`ImageAttachmentRef`、`ImageMediaType` | `packages/core/attachment` |
| `cordis` | `Context`、`Volatile` | **`vendor/cordis`** |
| `schemastery` | default export | **`vendor/schemastery`** |

`cordis` 和 `schemastery` 在 `vendor/`，不在 `packages/`。漏掉这点会把
`Volatile` 误报成 MISS。

## 六、分层纪律（升级时别越界）

- `src/wechat/` **不得 import 任何 `@deepseek-ai/*`**——它是从腾讯
  `@tencent-weixin/openclaw-weixin` 移植的协议层，只依赖自身。DSH 升版时
  **这一层理论上零工作量**；如果要改它，说明动的是微信协议，不是 DSH。
- `src/bridge/` 只用官方文档化的 API。
- 所有 `@deepseek-ai/*` 必须在 peer + dev，**绝不进 `dependencies`**——
  那会分裂运行时身份，症状是每条消息都失败。`manifest.spec.ts` 有断言守着。
