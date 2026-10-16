# 不变量与约束

[`CLAUDE.md`](../CLAUDE.md) 只列规则，本文件是它们的**详细依据**：为什么存在、违反了会发生什么、
证据在哪个文件或哪条决策。

这些规则的共同点是**违反后不会报错**——要么行为悄悄变错，要么启动静默失败，要么在真实用户那里
才暴露。这正是它们值得写下来的理由：不写，下一个人就要重新踩一遍。

---

## 一、会静默改变行为的

### 会话 id 是 peer 的纯函数

**规则**：peer → `channel-wechat-<escaped peerId>[~g<N>]`。起跑前必须先探测这个 id 是否已有持久化状态
（`sessionExists`），再决定 `create` 还是 `resume`。

**违反的后果**：id 在重启后不变，而 DSH 已经把状态落了盘。对已存在的 id 直接调 `create`，注册表会拒绝
——**拒绝之后本次进程的每一条入站消息都被丢掉**。形状是「通道看起来健康，但用户发什么都没有回复」，
不是崩溃。

**`/new` 为什么不删会话**：`sessionPersistence` 没有删除 API（只有 `create`/`open`/`flush`/`stat`/`list`），
所以「结束会话」只能实现为**换一个 id**：代次 +1，持久化到 `~/.dsh/channel-wechat/peer-sessions.json`，
下一个会话变成 `...~g<N>`。代次持久化，所以重启后 `/new` 仍然成立（只在内存里转就会 resume 回旧对话）。

**记录在案的代价**：会话文件随 `/new` 次数累积且永不删除；peer id 若含 `~` 会被 escape 而孤立旧会话
（真实微信 id 为 `[A-Za-z0-9_.@-]@im.wechat`，不可能含 `~`）。

**依据**：plan-v1 §Q41；`src/bridge/peer-map.ts`、`src/index.ts` 的 `sessionExistsOf`。

### 回复读的是 durable `assistant/message` 事件

**规则**：回复路径订阅 `ctx.on('session/event', …)`，从 committed 的 `assistant/message` 事件取文本。

**违反的后果**：不订阅 → 收得到消息、跑得完一轮、**什么也不回**，而通道看起来完全健康。
所以 `sessionEvents` 是 `ChannelOptions` 的**必填**参数而非可选默认值。这个失败单测看不见——
只有生产接线真的订阅了才是被断言的东西。

**不要用**：`turnOutline`（120 字符预览）、`finalAssistantOutput`（越界）、deprecated 的 `snapshotEvents()`。
另外 `whenIdle()` 是 **whole-agent 静默**，无法区分是谁的回合结束，必须先等 inbox 回执界定区间。

**依据**：plan-v1 §5.2；`src/bridge/reply.ts`。

### 交互卡：必须 `prepend: true`，且回复要绕过 peer 队列

**规则**：`approval/request` 与 `user-questions/request` 两条 waterfall 的监听都必须带 `{ prepend: true }`；
卡片回复**不走** `peers.runExclusive`。

**违反的后果，两件都是静默的**：

| 漏掉的东西 | 后果 |
|---|---|
| `prepend: true` | GUI 自己的 answerer 先跑并抢走请求，本通道**再也看不到**，且**没有任何报错** |
| 绕过队列 | **死锁**。提问的那一轮正阻塞在 `ask_user_question` 里，而它持有该 peer 的队列，回复永远到不了 |

`/stop` 也是为同样的理由绕过队列的。

**测试盲区**：直接调 `handleMessage` 的测试绕过 `serialize`，**看不见**这个死锁。
死锁回归测试走**真实 poll 循环**。

**两条 seam 的不对称**（这决定了实现形状）：

| | `approval/request` | `user-questions/request` |
|---|---|---|
| 有 id 吗 | 最多 `callId` | **完全没有** |
| durable 事件 | 有 | **没有** |
| 超时 | 无 | 无 |
| 无人认领 | 返回 `'unavailable'` | 抛 `NO_PROVIDER` |

因为没有 id，卡片 id（`P1`、`P2`…，要手输在手机上所以短且大小写不敏感）是本插件自己发的，
两条 seam **共用同一个 id 命名空间**，否则同一句话可能命中两张卡。

**记录在案的技术债**：提问卡没有 durable 事件，重启后未答的卡会变成**幽灵卡**；
`cards: both` 且微信先答时，GUI 卡会滞留到该轮结束（`forkGuiCardSignal` 是未文档化依赖，**故意不用**）。

**依据**：plan-v1 §Q42、§5.6；`src/bridge/cards-service.ts`、`src/channel/channel.ts`。

### 媒体失败绝不吞掉消息

**规则**：CDN 报错、字节不被 store 接受、模型不支持图片——一律降级为**追加在文本后的说明**。

**为什么**：媒体是用户所说内容的**附加物**，不是被听见的前提。丢掉整轮消息的代价远大于少一张图。

**两个易错点**：

- 图片类型靠**嗅探前导字节**判定：线上不带 media type，而 store 会校验「声明的类型」与字节是否一致。
- 模型的图片能力要**按消息 await 查询**，不能先缓存为 `false` 再异步补——那样每次运行的第一张图
  都会退化成标签。查询失败答「否」：谎报支持的代价是 provider 拒掉整条消息，反过来的代价只是一张图。

**依据**：plan-v1 §Q43；`src/bridge/media.ts`。

### 出站文件只发 `deliverables/presented` 声明的

**规则**：只发 `present` 工具写的 durable 事件所声明的文件，**绝不扫描目录**。

**为什么**：DSH **没有**「把文件发给用户」的一等 API，`deliverables/presented`（载荷是路径）是唯一信号。
而「产出了文件」和「这个文件是给你的」是两件事——Agent 写报告时会顺手写一堆临时脚本和中间数据。

**邻接陷阱**：`workspace/changes` 事件描述**本轮碰过的所有文件**，正是绝不该发的那个，且它的文件清单
存在 projection 而非事件里，**所以事件名是唯一的判别依据**。测试用「带 files 数组的非 present 事件」
把这个判别钉住。

**上传的两个静默失败点**：成功判定是响应头 `x-encrypted-param`（**不是状态码**），缺它就没有可引用的
下载参数；`filesize` 必须是**密文（填充后）大小**，服务端拿它核对实际 POST 的内容。

**有意不做**：`present` 事件里的 `description` 被丢弃，文件不带说明发出（用户裁定，2026-10-14）。
若要补，做法是把它作为一条**独立文字请求**发出——参考实现里文字与媒体本就是两条长度 1 的 `item_list`。

**依据**：plan-v1 §Q44；`src/bridge/deliverables.ts`、`src/bridge/send-file.ts`。

### `cwd` 必填且会话创建后不可变

**规则**：`Config.cwd` 故意**没有默认值**（schema 里 `required`）。`/cwd` 与 `/reconnect` 已注册但
**未实现**，会明确回复而不是静默失败。

**为什么必填**：会话的 `cwd` 一经写入就不可迁移，而 web app 的系统提示词通过 `{{cwd}}` 读它——
没有值的提示词变量会在调用 provider 之前就让这一轮失败。给默认值等于把一个操作者从未选择的目录
悄悄写进改不了的会话，把部署错误藏起来。

**依据**：plan-v1 §5.5、§Q47；`src/index.ts` 的 `Config`、`src/bridge/local-commands.ts`。

### 可选服务用 `ctx.get()`，不要写进 `inject`

**规则**：`attachments` / `llm` / `agentPresets` / `connection` 用 `ctx.get()` 读取并判空。
只有「没有它就该等」的服务才进 `inject`：`agents` / `commands` / `credentials` / `wechatStartup` /
`agentDefaultModel`。

**违反的后果**：`inject` 里声明一个在 headless 上合法缺失的服务，会让**整行 parking**，通道压根不启动。
`mountPanelRoutes` 尤其如此：面板需要 `ctx.connection`，而它只在面向浏览器的 host 上存在。

**依据**：plan-v1 §Q4/Q27；`src/channel/mount.ts`、`src/index.ts` 的 `presetsOf`。

### `ctx.agents` 不套用默认模型

**规则**：`ctx.agents` 自己**不应用**默认选择，每个调用方都要读 `ctx.agentDefaultModel.currentSelection()`
并传进去。

**违反的后果**：没有模型的会话在 `{{model}}` 处失败，用户看到的是「消息发出去了，没有回复」。
`agentDefaultModel` 因此进了 `inject`——等这个服务，比启动起来却每轮都失败要好。

**依据**：plan-v1 §Q52；`src/index.ts` 的 `modelSelectionOf`。

### 所有诊断走 `reporterFor(ctx)`

**规则**：任何要人看见的诊断都通过 `reporterFor(ctx)` 发出（终端 + 每日日志文件双写）。
reporter 是**每 ctx 一个**（`WeakMap`），否则多个调用点会开出多个 sink 盖同一个文件。

**为什么**：桌面端 host 的 stdout 被 pipe 给 Electron 主进程，而主进程**没有终端、也不写日志文件**。
绕过 reporter 的诊断在桌面端等于不存在。同一个盲区已经三次咬人：Q50 的 `skipping profile bundle`、
Q52 的 `name mismatch`（都只写 stderr），以及**登录地址**——它曾经是唯一不落盘的诊断，
插件完全正常而用户两眼一抹黑。

**依据**：plan-v1 §Q46、§Q51；`src/channel/report.ts`、`src/channel/log-file.ts`。

### `startup.ts` 只认领已知动作词，永不报错

**规则**：`parseCmdline` + `allowUnknownOption` + `allowExcessArguments`，只把已知动词
（`login`/`logout`/`status`）当作动作，其余一律视为「普通启动」。

**为什么**：启动器把**同一份完整参数列表**交给 profile 里**每个** app，各自解析。别的 app 的 flag 值
（如桌面端的 `--port 19387` 里的 `19387`）在形状上与一个动作词无法区分。调 `program.error()`
会请求**进程退出**，在到达本插件之前就**中止整个 boot**——实测 `--no-open --port 19387` 会崩。
误拼的动作词变成「照常启动服务」，是更小的代价。

**依据**：plan-v1 §Q28 与 `src/startup.ts` 的注释；`docs/recon/02`。

---

## 二、打包与依赖（会以发布事故的形式惩罚）

### `@deepseek-ai/*` 绝不能进 `dependencies`

**规则**：所有 DSH 包声明在 `peerDependencies` + `devDependencies`。

**违反的后果**：`pnpm add` 会把它们**实体装进 profile**，于是同一个包在进程里有**两份不同 inode 的
副本**。`cosmokit`（cordis 微内核的响应式底座）用 `Symbol.for("cosmokit.volatile.write")` 做模块级
状态，插件用自己的副本 = **第二套模块图**，`ctx.effect()` 于是跨了两个响应式系统，
症状是 `no agent factory registered` / `cannot create effect on inactive context`。

**版本号完全一致**，所以**任何版本检查都发现不了，只有 inode 不同**。这条是 0.1.0 真实用户的
「每条消息都失败」的根因（plan-v1 §Q50）。

**自查**：装完看 profile 的 `node_modules/@deepseek-ai/` 应为**空**。
`tests/unit/manifest.spec.ts` 有 `keeps dsh runtime packages out of dependencies` 守着。

### `lib/` 是 gitignore 的 → 本地目录安装会静默装成空包

`dsh plugin add <本地目录>` 建立 `link:`，而 **`link:` 不执行构建**。于是装出来的包**没有 `lib/`**，
启动时报 `failed to import` 并**静默不加载**。从 npm 或 tarball 安装没有这个问题（`prepack` 自动构建）。

### `dependencies` ≠ `dsh.profile.bundles`

前者说「**下载**什么」，后者说「**加载**什么」，两者独立。只在 `dependencies` 里 → 包**装好但永不加载**：
`--dump-config` 一行都没有，**且不报错**。`dsh plugin add` 两处都写；**手工 `link:` 只写前者**——
这正是桌面端曾「装了却从不生效」的原因。升级已安装的 profile 还必须**带版本号**
（`^0.1.0` 已满足新版本，pnpm 会判定「无需变更」→ 原样重装旧版并报成功），见 `docs/release.md` §四之二。

### 构建配置里两处不能改错

- `tsdown` 的 `neverBundle` 同样排除 `@deepseek-ai/*` 与 `commander`：保留单例身份，打包一份副本
  会破坏服务标识。`src/vendor/qrcode.mjs` 的 MIT 头靠构建期 `banner` 保留，删了 banner 就是
  **剥掉许可证要求的署名**（0.1.0 真的发生过）。
- `dts: true` 是必需的：`exports["./startup"]` 声明了 `types` 面，而它必须指向**产物**。
  曾指向 `src/startup.ts`——开发时能解析，装到别人机器上**静默退化成 `any`**。

**依据**：`docs/release.md` 附「两个历史陷阱」；plan-v1 §Q48、§Q50；`src/index.ts` / `tsdown.config.ts`。

---

## 三、测试纪律

- `tests/unit/**` 是可注入协作者的单元测试；`tests/integration/**` 断言**发布产物**（`globalSetup`
  先跑 `pnpm build`），并用真实 launcher + 隔离 `DSH_HOME` 启动真组合。
- **本仓库反复复发的缺陷模式**：单测自己注入 sink/collaborator，于是**没有一个测试能观察到 `apply`
  到底有没有把它接上**。已发生至少四次（`sessionExists`、`sessionEvents`、`cwd`、`presets`、
  `onUnreadableQuote`、reporter 的 `also`）。**任何新增的生产接线，都要补一个「真实 `apply` 启动」
  的集成测试。**
- **变异验证是这里的惯例**：改坏实现后测试**必须**失败，否则那个测试没有在测它声称的东西。
  本项目已多次出现「变异存活」（测试全绿但变异没被抓到），每次都是靠补一个新的集成测试解决的。
- **失败要有形状**：本项目的取舍是宁可启动失败也不静默降级。这与「文档要如实」是同一条原则的两个面
  ——README 曾三处写出代码没兑现的承诺（§Q47、§Q48）。

---

## 相关

- [`../CLAUDE.md`](../CLAUDE.md) —— 规则的一句话版本，以及命令、分层、开发规范
- [`plan-v1.md`](./plan-v1.md) —— 决策台账 Q1–Q52，每条都带依据、代价与实测证据
- [`release.md`](./release.md) —— 发布实测步骤
- `../README.md` —— 用户面的已知问题与「不做的事」
