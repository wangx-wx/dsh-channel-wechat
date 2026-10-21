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

**规则**：`Config.cwd` 故意**没有默认值**（schema 里 `required`）。`/cwd` 已实现，语义是
**结束当前会话、在新目录开始新对话**——因为会话的 `cwd` 写入后不可修改。`/reconnect` 仍未实现，
会明确回复而不是静默失败。

**为什么必填**：会话的 `cwd` 一经写入就不可迁移，而 web app 的系统提示词通过 `{{cwd}}` 读它——
没有值的提示词变量会在调用 provider 之前就让这一轮失败。给默认值等于把一个操作者从未选择的目录
悄悄写进改不了的会话，把部署错误藏起来。

**`/cwd` 的持久化**：按 peer 记在 `~/.dsh/channel-wechat/peer-sessions.json` 的 `cwds` 字段里，
与代次同文件、同一读-改-写队列。只存内存的话，重启会把切换悄悄退回配置的默认目录——
和 `/new` 当初那个缺陷同形。

**校验必须发生在拆会话之前**：路径要绝对、要存在、要是目录、要 realpath 规范化。写进 header 的
`cwd` 改不了，所以打错字只该损失一条消息，不该损失正在进行的对话。相对路径直接拒绝：
进程自己的目录在手机上不可见。

**已知边界**：`sandbox-policy` 的 `workspaceRoot` 读的是 `session.header.cwd`，不是
`workingDirectory`。所以 `workspace-write` 下切到新目录后，写文件仍按**旧**边界判定。
`danger-full-access` 没有这个限制。这一点写在 `docs/commands.md` 里，不是缺陷掩盖。

**依据**：plan-v1 §5.5、§Q47、§Q53；`src/index.ts` 的 `Config`、`src/bridge/local-commands.ts`、
`src/bridge/peer-map.ts` 的 `startNewIn`、`src/channel/directory.ts`。

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

### `cmdline` 只认领已知动作词，永不报错

**规则**：`claimAppArgument`（`src/cmdline.ts`）用 `parseCmdline` + `allowUnknownOption` +
`allowExcessArguments`，只把已知动词（`login`/`logout`/`status`）当作动作，其余一律视为「普通启动」。
它返回 `undefined` 表示 commander 自己处理了这次调用（`--help`/`--version`），调用方**不得**启动服务。

**为什么不能报错**：启动器把**同一份完整参数列表**交给 profile 里**每个** app，各自解析。别的 app 的
flag 值（如桌面端的 `--port 19387` 里的 `19387`）在形状上与一个动作词无法区分。调 `program.error()`
会请求**进程退出**，在到达本插件之前就**中止整个 boot**——实测 `--no-open --port 19387` 会崩。
误拼的动作词变成「照常启动服务」，是更小的代价。

**为什么有 `undefined` 这一支**：早期是**两行**——`startup` 行发布服务，主行 `!!js` 读它；`--help`
时 startup 行不运行、不发布服务，主行自然 dormant。合并成一行后这个保护必须显式写出来，
否则打印帮助也会开始轮询。有测试钉住（`tests/unit/cmdline.spec.ts`）。

**依据**：plan-v1 §Q28；`src/cmdline.ts`；`docs/recon/02`。

### 客户端半边：槽位名、key、`hooks` 三处错了都不报错

**规则**：客户端半边注册在 `plugins.bundle.config`，`key` 是**包名**，业务面放在保留的
`hooks` 隔间里（`src/client/client.js`）。

**违反的后果，三件都是静默的**：

| 漏掉的东西 | 后果 |
|---|---|
| 用 `plugins.item` | 那是官方设置页占用的槽位；注册成功，页面渲染在错误的组里 |
| `key` 与包名不一致 | 注册成功，**永远不渲染**，无任何报错 |
| 业务对象不放进 `hooks` | 渲染器只从该隔间合成 `use<Name>`；组件调用 hook 时在**浏览器里**抛错 |

`plugins.bundle.config` 是**已安装 bundle** 自己的配置位；`plugins.item` 是官方插件页的位。

**依据**：`packages/client/ui-plugin-manager/src/client/slot-contract.ts` 的槽位注释；
`tests/integration/client-half-runs.spec.ts`（三条变异各自被捕获）。

### 配置字段必须 `volatile` 才会出现在 GUI 表单里

**规则**：要出现在插件页表单里的字段，schema 必须标 `.volatile()`，代码用 `.get()` 读。

**为什么**：`dsh-settings` 用 `volatileForm()` 投影表单，只保留 volatile 字段；**非 volatile 字段
是「缺席」，不是「只读」**——`projectForm` 会把它从值里也删掉，写入被拒
（`Config field "x" is not volatile`）。一个 volatile 字段都没有的 entry 连 `describe()` 都不出现。

**代价**：GUI 写入会把 bundle 层的 `!!js process.cwd()` 固化成字面量路径（清空该字段可恢复）。

**依据**：`packages/settings/settings/src/schema.ts`；`tests/unit/config-schema.spec.ts`。

### 权限预设只在会话**创建时**应用，不在 resume 时应用

**规则**：`applyPermission` 只在 `PeerMap.createSession` 判定为新建时调用；`resumeSession` 返回后
**不得**再写权限。

**为什么**：权限是会话的 **durable 事件**（`permission/preset` + `sandbox/mode` + `approval/policy`），
`permissionPresets` 挂载时会用 `pinInitialPermission` 恢复它们。用户可以在微信里用 `/permission`
**临时**改本会话的权限；resume 时再套用配置会**静默撤销用户自己的选择**——症状是下一次重启后
Agent 又开始请求本该不需要的批准（或反过来），而配置页看起来毫无问题。

**代价**：改插件页的权限只影响**之后新建**的会话；已有会话保持它记录的样子。这是刻意的，
与 `cwd` 的不可变语义一致。

**依据**：`src/bridge/peer-map.ts`（`if (!resumed) this.applyPermission?.(handle)`）；
`packages/interaction/permission-presets/src/index.ts` 的 `pinInitialPermission`；
`tests/unit/peer-map.spec.ts`「does NOT re-apply the preset when resuming」。

### 权限服务用 `ctx.get()`，不写进 `inject`

**规则**：`permissionPresets` 通过 `ctx.get('permissionPresets')` 读取，**不要**加进 `export const inject`。

**为什么**：该服务在**构造时**就会 throw——「the mounted bash executor does not confine
(no sandboxMode)」。headless 那类组合没有沙箱执行器，因此**合法地**没有权限服务。写进 `inject`
会让整行 parking：频道永不启动，而 profile 看起来正常。

**依据**：`permission-presets/src/index.ts` 的构造器校验；`src/index.ts` 的 `permissionApplierOf`；
`tests/unit/permission-applier.spec.ts`。

### `danger-full-access` 会关掉本插件的审批卡

**规则**：提供该预设时**必须**先弹风险确认；**绝不能**把它设为默认值。

**为什么**：该预设自带 `approval: never`，而 `never` 在 approval 服务**内部、waterfall 之前**就返回
`rejected`——本插件 `prepend: true` 的微信审批卡**根本不会被调用**。宿主侧 `permissionPresets.set`
**没有**风险确认（官方页那个「Enable Full access?」勾选框是纯客户端 UI），所以一个跳过确认的插件
可以静默放宽会话权限。

**依据**：`packages/interaction/user-approval/src/index.ts`（`never` 的判定位置）；
`permission-presets/src/index.ts`（预设定义）；`src/channel/session-policy.ts` 的 `DEFAULT_PERMISSION`；
`tests/integration/client-half-form.spec.ts`（驱动真实组件，两个变异均被捕获）。

### 审批卡的提权选项必须写明「不再弹卡」和 `/new` 恢复

**规则**：卡片第 3 项（`session`）的文案**必须**同时说明：本会话之后不再弹审批卡，以及 `/new` 后恢复。
微信侧**不加**二次确认（个人使用），因此这段文案是唯一的风险告知。

**为什么**：选项等价于 `danger-full-access`，会走上面那条不变量——卡片立即消失。只说「全部权限」
会让用户以为那是一次性放行。

**提权的两个顺序约束**：
1. **先 `settle` 再改权限**。输掉竞争时不得提升权限，否则一条没有生效的回答也放宽了会话。
2. **session id 经 `ctx.agents` 解析成活动 session 对象**。回答到达时那一轮可能已结束；拿不到就报失败，
   不能退化成「随便找当前会话」。

**依据**：`src/bridge/cards-service.ts`（`answer` 的提权分支、`elevateSession`）、
`src/index.ts` 的 `sessionElevatorOf`；`tests/unit/cards-service.spec.ts`（4 条，含输掉竞争）；
`tests/integration/session-policy-wiring.spec.ts`（真实 `apply` 接线，变异已验证）。

### 输入状态必须能降级，且不能超过一轮的生命周期

**规则**：票据缺失、票据获取失败、状态上报被拒——一律降级为**不显示**，绝不能阻塞或失败一轮回复。
`start` 放在命令与卡片回复的提前 `return` **之后**；`stop` 放在 `finally` 里。

**为什么**：
- 输入状态是装饰。为了一个失败的票据请求而延迟回复，是用有用的部分换装饰。
- `stop` 不进 `finally` 的话，失败的一轮会留下一个「正在输入」的假象，看起来像卡死。
- 命令与卡片回复都不是「机器人在生成回复」，显示输入状态是假的。
- 上报被拒是票据在 TTL 之前失效的**唯一证据**，因此要主动 `invalidate`，否则会一直发送已知无效的值。

**依据**：`src/channel/typing-indicator.ts`、`src/wechat/typing.ts`、`src/channel/channel.ts` 的
`handleMessage`；协议 `docs/protocol/protocol_zh_CN.md:301-349`；
官方实现 `openclaw-weixin/src/messaging/process-message.ts:311-341`（5 秒续期、无票据即空操作）。

### 轮询循环没有默认运行上限

**规则**：生产路径**不得**给 `monitorLoop` 一个有限默认值。上限只能由调用方显式给出。

**为什么**：`DEFAULT_MAX_RUN_MS` 曾是 24 小时且 `src/index.ts` 从未覆盖它，通道因此会在启动满一天后
**静默停止轮询**——循环正常 `return`，没有任何错误，从用户侧与「今天没人说话」无法区分。而运行上限
到期不是 abort，`SingleRun` 曾因此保留 `current`，让 `live()` 谎报为真。

**依据**：`src/channel/monitor.ts`（`DEFAULT_MAX_RUN_MS = Infinity`）；
`src/channel/single-run.ts`（launch settle 时按 controller 身份清理槽位）；
`tests/unit/monitor-run-limit.spec.ts`、`tests/unit/single-run.spec.ts`。

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
（`^<已装版本>` 已满足新版本，pnpm 会判定「无需变更」→ 原样重装旧版并报成功），
步骤见 [`installation.md`](./installation.md#升级已安装的-profile)。

### 构建配置里两处不能改错

- `tsdown` 的 `neverBundle` 同样排除 `@deepseek-ai/*` 与 `commander`：保留单例身份，打包一份副本
  会破坏服务标识。`src/vendor/qrcode.mjs` 的 MIT 头靠构建期 `banner` 保留，删了 banner 就是
  **剥掉许可证要求的署名**（0.1.0 真的发生过）。
- `dts: true` 是必需的：`exports` 里带 `types` 面的子路径，其声明必须指向**产物**。
  曾指向 `src/startup.ts`——开发时能解析，装到别人机器上**静默退化成 `any`**。
  （`./startup` 子路径已随两行合并删除；规则本身对其它子路径仍然成立。）
- **客户端半边靠 `scripts/copy-client.mjs` 拷贝**，`tsdown` 只构建宿主半边。手写 JS 就是
  浏览器要加载的最终产物，过一遍 ESM/target 处理只会改坏它。`files[]` 里的 `lib/` 覆盖它。

**依据**：plan-v1 §Q48、§Q50；`src/index.ts` / `tsdown.config.ts`；`tests/unit/manifest.spec.ts`。

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
