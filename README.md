# dsh-channel-wechat

[English](./README.en.md) | 中文

把微信（腾讯 iLink / ClawBot）接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**通道插件**。

> 状态：**v0.2.1 已发布到 npm**（自本版起版本号跟随 DSH 主次，见下方「版本号与兼容性」）。登录与配置都在 GUI 插件页里完成；插件在 profile 中只占一行。
> 插件页现在还能选**默认模型**与**微信会话权限**（三档，完全权限带风险确认，只作用于微信会话）。
> 出站文件已**真机验证**；`svr_id` 引用与 `message_id` 精度为**已知记录项**（见 [plan-v1 §Q45](./docs/plan-v1.md)）。

### 版本号与兼容性

本插件版本号是 **`<DSH 主>.<DSH 次>.<我们自己的补丁号>`**（不带 `rc`/`alpha`）：
`0.2.x` 配 DSH `0.2` 那一代，`0.3.y` 配 DSH `0.3` 那一代。**`x` 完全归我们**——DSH 发
`0.2.2` 我们不改号，只有本插件自己有改动才 +1。

**能否安装由 `engines.dsh` 的下界判定**，`>=0.2.0-rc.1`，**刻意不设上界**：

| DSH 版本 | 能否安装 | 是否已验证 |
|---|---|---|
| `0.2.0-rc.2`（打包桌面端） | ✅ | ✅ 集成测试 99 项全通过 |
| `0.2.1-rc.1`（npm 安装，真 launcher） | ✅ | ✅ 集成测试 99 项全通过 |
| `0.2.x` 其余 / `0.3.x` / `1.x` | ✅ | ⚠️ 未逐一实测 |
| `0.2.0-rc.1` 以前 | ⛔ 安装时被拒绝并说明原因 | — |

> 表里「99 项全通过」是**跳过 0 项**的完整运行。历史上曾记过「`0.2.0-rc.2` 84 项通过、
> 跳过 15 项」，那是**误归因**：跳过的是 `client-half-runs`，它需要 checkout 里的
> `ui-theme` 源码和 react，与 DSH 版本无关。同一份测试在 `0.2.0-rc.2` 上、
> 只要源码树可得，同样跑满 99 项。

**"能装"与"已验证"是两件事。** 不设上界是因为：加天花板会让 DSH 每发一个新版本、
本插件未重发之前用户就装不上——对通道插件来说"立刻不能用"比"未实测版本上运行"更糟。

---

## 安装

```bash
dsh plugin --profile <你的 profile> add dsh-channel-wechat
```

装完**重启 DSH**。就这么简单——`add` 会自动构建、并把包注册进 profile 的 `bundles` 层。

> **想立刻装到刚发布的版本，要显式关掉观察期**：pnpm 有供应链安全观察期（`minimumReleaseAge`，默认 24 小时），
> 刚发布的版本会被**跳过**，于是装到上一个版本。注意 **`@latest` 不管用**——观察期在版本解析之后才生效，
> 实测 `add pkg@latest` 和 `add pkg` 结果一样（都装了旧版）。要用：
>
> ```bash
> dsh plugin --profile <你的 profile> add dsh-channel-wechat@latest --config.minimumReleaseAge=0
> ```
>
> 已实测：pnpm 11.7.0 与 11.9.0 下，加这个参数装到最新，不加则装到上一个版本。
> 不加 `@latest` 只加参数同样有效。**代价**是该版本未经观察期，风险自负。
>
> **装完必须完全退出并重启**，见下方「已知问题」里的静态模块图一条。

### 装完怎么用

1. 打开 GUI，进入侧边栏 **Plugins**（插件）→ 点开 **dsh-channel-wechat** 这张卡片
2. 卡片里点 **登录微信**，页内会显示二维码
3. 用**手机微信**扫码确认（需要验证码时页内输入），**无需重启**：凭证即刻写入，长轮询开始
4. 之后直接在微信里给这个 bot 发消息即可，DSH 的回复会回到微信

同一个页面下方就是本插件的设置（`cwd` / `cards`），改完点保存即可生效，不必再手改 YAML。

> 没有 GUI（headless 之类不挂 web app 的 profile）时，仍可用 `dsh <profile> login` 在终端
> 打印二维码。注意：**挂了 web app 的 profile（web / desktop）上这条命令用不了**——web app
> 自己的参数解析器会先拒绝这个位置参数，boot 在到达本插件前就结束了（原因见下方「登录」一节）。

⚠️ **`cwd` 要设对**：它决定所有微信会话的工作目录，**会话创建时写入且不可变**。
不设的话取启动器的 `process.cwd()`，**桌面端那是 `~/.dsh/profiles/desktop`**——不该让 agent
在里面干活。现在可以在插件的设置页里直接改（只影响之后新建的会话），也可以继续写 profile：

```yaml
- id: channel-wechat
  config:
    cwd: /你的/工作目录
    cards: wechat        # 微信独占卡片（默认）；改 both 则 GUI 也弹
```

### 其他安装方式

从 Git 仓库（pnpm 会用 `prepack` 自动构建）或本地 tarball：

```bash
dsh plugin --profile <你的 profile> add github:wangx-wx/dsh-channel-wechat
dsh plugin --profile <你的 profile> add ./dsh-channel-wechat-0.1.0.tgz
```

从 Git 安装时 pnpm 会**拒绝执行构建脚本**，首次失败并打印一行 `allowBuilds` 配置，
把它加进 profile 的 `pnpm-workspace.yaml` 再跑一次即可（pnpm 的安全机制，非本插件问题）：

```yaml
allowBuilds:
  dsh-channel-wechat@<pnpm 打印的那串完整键>: true
```

⚠️ **不要直接 `add` 一个本地目录**：那会建立 `link:`，而 **`link:` 不会执行构建**。
仓库里 `lib/` 是 gitignore 的，于是装出来的包**没有 `lib/`**，启动时报
`failed to import` 并**静默不加载**。真要这么做，必须先 `pnpm install && pnpm build`。

> **`bundles` 是什么**：`dependencies` 说「下载什么」，profile 的 `dsh.profile.bundles` 说「**加载**什么」。
> 只进前者不进后者 → 包装好却**永不加载**，`--dump-config` 一行都没有且不报错。
> `dsh plugin add` 会两处都写；**手工 `link:` 只写前者**，这正是桌面端曾「装了却从不生效」的原因。

## 这是什么

一个标准的 DSH **插件 + bundle**（单包），在 Harness 进程内运行，无需独立桥接进程：

```
微信用户 ⇄ 腾讯 iLink ⇄ 【本插件（DSH 进程内）】
              ├─ getUpdates 长轮询收消息
              ├─ agent.followup() 原生注入会话
              ├─ session/event → sendmessage 回发
              ├─ 审批卡 + 提问卡（微信与 GUI 双端）
              └─ 插件页（GUI）：登录 / 退出登录 / 配置
```

- **协议层移植腾讯官方实现**（`@tencent-weixin/openclaw-weixin`，MIT），保真度与测试基线俱佳
- **DSH 集成层全新写**，严格遵循官方契约（类型安全，非鸭子类型）
- **会话与工作目录**：目录由 profile 的 `cwd` 配置决定（会话创建时写入，之后不可变）。`/cwd` 命令已注册但**尚未实现**，目前会明确回复「尚未实现」而不是静默失败
- **解耦长轮询与处理**：长任务期间仍收消息，`/stop` 可打断
- **GUI 里就能登录与配置**：插件带一个客户端半边（手写 lazy-CJS，无构建步骤），
  注册进 Plugins 页的 `plugins.bundle.config` 槽位

## 登录

**首选入口是 GUI**：侧边栏 **Plugins** → **dsh-channel-wechat** → **登录微信**。
页内显示二维码，扫码确认后**无需重启**：凭证即刻写入 `ctx.credentials`，
通道在同进程内开始轮询。同页还有「退出登录」，会先停掉轮询再删除凭证。

没有 GUI 时（不挂 web app 的 profile），终端里跑：

```bash
dsh <profile> login     # 终端打印二维码
dsh <profile> status    # 看已存了什么
dsh <profile> logout    # 退出登录
```

### 为什么 web / desktop 上用不了 `dsh <profile> login`

因为**在挂了 web app 的 profile 上做不到**，这不是本插件的选择：

DSH 的启动器把**同一份完整参数列表**交给 profile 里**每个** app，各自解析。
`dsh-web-app` 的 program **只声明 flag、没有 positional**，所以 `login` 会被它判定为
`too many arguments` 并 `exit(1)` —— **boot 在到达本插件之前就结束了**。
`-- login`、`--json`、`--wechat-login`、以及把本插件的 bundle 排到 web-app 之前，
实测**全部无效**（官方 5 个解析命令行的 app 中没有一个容忍未知参数，这是刻意的设计）。

两个同类插件也都不走这条路：`dsh-wechat` 没有 CLI，只用 HTTP 页面；`dsh-weixin` 的 CLI 是
**独立可执行文件**，且 README 把面板列为首选。

### 为什么只有一个插件条目

早期版本在 profile 里是**两行**：一行 `dsh-channel-wechat/startup` 负责解析 `login` 这类
app 参数（只有声明 `inject` 的行才会拿到命令行），另一行是通道本身。

现在合成一行：`cmdlineArgs` 由**每个**启动器在 tree 挂载前提供，所以主行可以直接声明它。
这样 GUI 上只有一张卡片，而 CLI 能力在不挂 web app 的 profile 上照旧。

## 与同类插件的差异

| | `dsh-wechat` | `dsh-weixin` | **本插件** |
|---|---|---|---|
| 类型 | TS strict | 纯 JS | TS strict |
| 协议保真 | 入站媒体三处缺口 | 无 `-14`/去重 | 对齐官方 + 移植官方测试 |
| 斜杠命令 | 17 个 | 无 | 原生透传 + 6 个自管 |
| 并发 | 串行阻塞 | 串行阻塞 | 解耦 + 可打断 |
| 面板鉴权 | 路由裸奔 | 零鉴权 | **挂在 `/api` 后，复用 GUI 的 token 墙** |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/plan-v1.md](./docs/plan-v1.md) | **实施方案（定稿）**：决策台账、架构、里程碑、风险 |
| [docs/design.md](./docs/design.md) | 早期设计稿（v0.3，部分已由 plan-v1 取代） |
| [docs/事实核查.md](./docs/事实核查.md) | 协议性质核查与结论修正 |
| [docs/invariants.md](./docs/invariants.md) | **不变量的详细依据**：为什么、违反后果、证据在哪 |
| [spec/](./spec/) | **需求规格归档**，按日期递增 |
| [docs/recon/](./docs/recon/) | **13 份侦察报告**：协议、构建、DSH 契约、同类实现评估 |
| [docs/dev-log/](./docs/dev-log/) | 开发日志：按时间倒序的决策与变更记录（每版本一份） |

## 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** ✅ | 包骨架 + 真组合测试 | cordis fiber 达到 `ACTIVE` |
| **M1** ⚠️ | 协议层 + 凭证持久化 | CLI 路径在 web/desktop 上不可用 → 改由面板登录 |
| **M2** ✅ | **文本端到端** | 微信发消息 → DSH 回复到达 |
| **M3** ✅ | 命令 + `/stop` | 原生命令有回执；能打断 |
| **M4** ✅ | 媒体双向 + 引用 | 发图 ✅ / 引用 ✅ / **出站文件 ✅ 真机已验证** |
| **M5** ✅ | 审批卡 + 提问卡 | 微信批准/拒绝/回答提问；`cards: wechat` 时 GUI 不重复弹卡 |
| **M6** ✅ | GUI 登录与配置 | 插件页内扫码登录 / 退出登录；`cwd`、`cards` 可在页内编辑 |
| **M7** ✅ | 发布 | **v0.1.1** 首次经全新 profile 实测装好并加载 |
| **M8** ✅ | GUI 页 + 单条目 | **v0.1.2**：插件页内扫码登录 / 退出登录 / 配置；profile 里只占一行 |
| **M9** ✅ | 模型与权限配置 | 插件页内可选**默认模型**与**微信会话权限**（三档，含完全权限并带风险确认） |

## 数据落在哪里

| 内容 | 位置 |
|---|---|
| **聊天记录** | `~/.dsh/sessions/<cwd 转义>/channel-wechat-<peerId>[~g<N>]/session.v4.jsonl.zstd` |
| 插件状态 | `~/.dsh/channel-wechat/`（游标 + 会话代次） |
| **诊断日志** | `~/.dsh/channel-wechat/log/channel-wechat-YYYY-MM-DD.log` |
| 登录凭证 | `~/.dsh/.credentials.yaml`（DSH 的凭证体系，非本插件私有） |

**聊天记录由 DSH 自己落盘**（`ctx.agents` → `sessionPersistence`），本插件不写会话文件。格式是 **zstd 压缩的 JSONL**，用 `zstd -d -c <文件> | less` 查看。

**日志每天一个文件，保留 7 天。** 文件名按**本地日期**。桌面端尤其需要它：host 进程的 stdout 交给 Electron 主进程，而那里没有终端也不写日志，**没有这个文件就什么都看不到**。

⚠️ **日志留 7 天，但聊天记录永不删除**——`/new` 只是换一个会话目录，旧会话会一直累积（DSH 的会话接口没有删除 API）。

## 已知问题（记录，未修）

| 问题 | 影响 | 触发条件 |
|---|---|---|
| 引用**自己的消息**时客户端只发 `svr_id` | 显示 `[引用] （引用的消息内容未能读取）`；引用 Agent 的消息正常 | 需先建消息缓存才能还原 |
| `message_id` 声明为 `number`，服务端是 uint64 | 仅影响一条错误日志里的数字 | 超过 2^53，且要做引用缓存时 |
| **装完不重启，插件页没有配置区** | 登录与配置面板整块不显示，**且无任何报错** | Host 先启动、包后落盘（从插件页安装时的常态） |

取舍与实测数据见 [plan-v1 §Q45](./docs/plan-v1.md)。

### 已知问题详述：装完必须重启

**症状**：插件装好、宿主侧一切正常（`/api/channel-wechat/status` 返回 200、日志有扫码提示、
`dsh-channel-wechat` 的卡片和版本号都显示），但**插件详情页里那块配置区完全不出现**——
没有登录/扫码，也没有 `cwd`、模型、权限。控制台和日志都没有报错。

**这不是本插件的缺陷，也不受版本影响。** 根因在宿主 `@deepseek-ai/dsh-client-modules`：

- 它把插件的浏览器半边（`lib/client.js`）编进启动图，只有进了图，浏览器才会执行
  `ctx.slots.register('plugins.bundle.config', …)`，配置区才有内容。
- 它的包解析结果带**永久缓存**，解析失败记为 `null` 后**不再失效**，直到进程重启。
- 所以只要 **Host 启动时包还不在 `node_modules`**，那一行就永远进不了图：
  `/plugins/??dsh-channel-wechat/client.js` 一直 404，配置区一直空白。

这个窗口在**从插件页安装时是常态**——Host 早就在跑，pnpm 之后才把包装上。无论装哪个版本
没有区别，因为失效发生在第一次解析时，与后续装哪个版本无关。

**判定方法**：先排除「只是没刷新页面」——**完全退出并重启 DSH**。重启后配置区出现，就是这条；
仍然不出现，才需要继续查别的原因。

**为什么记在这里而不是修**：修复点在宿主的 `dsh-client-modules`（负缓存要可失效），不在本仓库。
本插件只能做规避，不能改变宿主行为。

规避方式一条：**装完/升级完插件，完全退出并重开 DSH。**

### 已知边界：微信端可以自己放宽权限

`/permission` 是 DSH 的原生命令，而本插件把**非本地命令一律转发**给 harness（本地命令只有
`stop`/`status`/`new`/`cwd`/`help`/`reconnect`）。所以在微信里发

```
/permission danger-full-access
```

就会把当前会话的审批关掉（该预设自带 `approval: never`，会在本插件的审批卡之前就判定，**卡片不再出现**）。

- **持久性**：它写的是会话自己的持久事件，**重启后仍在**；但只作用于那一个会话，`/new` 会按默认重新起跑。
- **为什么不改**：本通道按设计是**单方**的（`docs/invariants.md` 的 Q37：微信消息继承与本地输入同等的权限），操作者本人就是用户。若将来服务群聊或不可信来源，这个假设必须推翻。
- 插件页里的「微信会话权限」作用于**之后新建**的会话，不回改已有会话——尊重你在会话内的临时选择。

### 开发

```bash
pnpm install
pnpm test              # 单元测试（毫秒级）
pnpm test:integration  # 真组合测试：隔离 DSH_HOME 启动真实 launcher
pnpm typecheck
pnpm build             # 发布前 `prepack` 会自动执行
```

**发布新版本**：见 [docs/release.md](./docs/release.md)（切官方源 → 发布 → 静候审核 → 切回镜像源）。

集成测试会在临时目录建一个隔离的 `DSH_HOME`，**不会触碰你正在使用的 dsh profile**。

它们需要一个真实的 launcher 来启动，默认用**本地 DSH 仓库**（走
`node apps/cli/lib/bin.js`，不需要 Electron，可指向任意版本）：

```bash
DSH_CHECKOUT=/path/to/deepseek-harness pnpm test:integration  # 覆盖仓库位置
```

若该仓库不存在，则回退到 `DeepSeek Harness.app` 内的 `dsh` shim。

## 不做的事

群聊（协议无依据）、多账号运行期、消息去重/节流（对齐官方）、主动推送（v2）、自建权限体系。

> **提问卡在 v1 已实现**（不是 v2）：`ask_user_question` 若无人认领会永久卡住整轮，所以它和审批卡一起做，见 [plan-v1 §Q42](./docs/plan-v1.md)。
>
> **「自建权限体系」不包括选择权限档位**：插件页里的「微信会话权限」用的是 DSH 自己的
> `ctx.permissionPresets`，只是把选择权放到插件页，没有另起一套。详见下方「已知边界」。

## 许可与致谢

- 协议规范与部分实现来自腾讯 [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（**MIT**，`Copyright (C) 2026 Tencent`）
- 工程实践参考 `wechat-claude-code`（MIT）
- 本插件许可：**MIT**
