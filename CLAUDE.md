# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

把微信（腾讯 iLink / ClawBot）接入 DeepSeek Harness 的 **channel 插件**。单包同时是插件与 bundle，
运行在 Harness 进程内（没有独立桥接进程）。

## 常用命令

```bash
pnpm install
pnpm test              # 单元测试（vitest --project unit，毫秒级）
pnpm test:integration  # 真组合测试：先 pnpm build，再用真实 launcher 启动隔离 DSH_HOME
pnpm test:all          # 全部
pnpm typecheck         # tsc --noEmit（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）
pnpm build             # tsdown → lib/（prepack 会自动执行，发布时不必手动）
```

单个测试文件 / 单个用例：

```bash
pnpm exec vitest run --project unit tests/unit/reply.spec.ts
pnpm exec vitest run --project unit -t 'the id space'
pnpm exec vitest run --project integration tests/integration/channel-real-loop.spec.ts
```

⚠️ **干净 checkout 上 `pnpm typecheck` 会失败，直到 `pnpm build` 跑过一次**：集成测试 import
`dsh-channel-wechat/startup`，而该子路径经 `exports` 解析到 `lib/startup.d.ts`。先 `pnpm build` 再 typecheck。

集成测试需要真实 launcher，默认指向本地 DSH 仓库
`/Users/wangx/workspace/aaa/github/deepseek-harness`（`tests/support/harness.ts` 的 `DEFAULT_CHECKOUT`），
可用 `DSH_CHECKOUT=/path/to/deepseek-harness` 覆盖；该路径不存在时回退到 `DeepSeek Harness.app` 的 dsh shim。
它们用临时目录作 `DSH_HOME`，**不会触碰开发者的真实 profile**。

**发布新版本**：照 `docs/release.md` 走（切官方源 → 2FA → `npm publish` → 静候审核 → 切回镜像源 → tag → Release）。
该文件记录的是实测步骤，含两个已踩过的陷阱，不要凭常识重写。

## 分层（改代码前先看这一节）

```
index.ts        装配点：name / inject / Config / apply，把下面各层接起来
startup.ts      独立 entry（dsh-channel-wechat/startup），解析 app 参数并 provide wechatStartup
login-command.ts / credentials.ts   CLI 登录动作 + 凭证读写（存 ctx.credentials）

wechat/   协议层 —— 移植腾讯 @tencent-weixin/openclaw-weixin（MIT）。**不得 import 任何 @deepseek-ai/***
          api / crypto / cdn / cdn-upload / media-download / inbound / login-machine / login-runner / qr / types
channel/  通道层 —— monitor（长轮询，独立循环）/ channel（五件事的接线）/ runtime（从凭证起跑）
          single-run（一次运行的所有权）/ mount + panel + login-routes（登录面板）/ log-file + report（落盘诊断）
          cursor-store（轮询游标）/ peer-session-store（会话代次）
bridge/   桥接层 —— peer-map（peer↔session + 串行化）/ dispatcher（消息→agent.followup）
          reply（assistant/message→微信）/ commands + local-commands + native-commands / cards + pending-cards + cards-service
          media / deliverables / send-file
vendor/   内联的 qrcode-generator；MIT 头靠 tsdown 的 banner 保留，见 THIRD_PARTY_NOTICES.md
```

关键不变量（每一条的替代做法都会**静默**失败，所以有测试钉住）：

- **peer 的会话 id 是 peer 的纯函数**：`channel-wechat-<escaped peerId>[~g<N>]`。`/new` 不是删除会话
  （`sessionPersistence` 没有删除 API），而是把代次 +1 并持久化到 `~/.dsh/channel-wechat/peer-sessions.json`。
  因此起跑前必须探测会话是否已存在（`sessionExists`）——否则每次重启都对已存在的 id 调 `create`，
  被注册表拒绝后**丢掉本次进程的全部入站消息**。
- **回复读的是 durable `assistant/message` 事件**（`session/event`）。不订阅这个面 → 收得到消息、
  跑得完一轮、**什么也不回**，且看起来完全健康。`sessionEvents` 因此是必填参数而非默认值。
- **交互卡的两条 seam 形状不对称**：`approval/request` 与 `user-questions/request`。监听**必须**
  `{ prepend: true }`，否则 GUI 自己的 answerer 先跑并抢走请求，本通道**再也看不到且没有任何报错**。
  卡片 id（`P1`、`P2`…）是本插件自己发的，两条 seam **共用同一个 id 命名空间**。
  **卡片回复必须绕过 peer 队列**：提问的那一轮正阻塞在 `ask_user_question` 里并持有该队列，
  走队列的回复会**死锁**。直接调 `handleMessage` 的测试绕过 `serialize`，看不见这个死锁——回归测试走真实 poll 循环。
- **媒体失败绝不吞掉消息**：CDN 报错、字节不被 store 接受、模型不支持图片，一律降级为追加在文本后的说明。
- **出站文件只发 `deliverables/presented` 声明的**，绝不扫描目录。`workspace/changes` 描述的是
  「本轮碰过的所有文件」，正是绝不该发的那个；**事件名是唯一判别依据**。
- **`cwd` 必填且会话创建后不可变**。`Config.cwd` 故意没有默认值：默认值会把一个操作者从未选择的目录
  悄悄写进无法迁移的会话。`/cwd` 已注册但**未实现**，会明确回复而不是静默失败（同 `/reconnect`）。
- **可选服务用 `ctx.get()` 拿，不要写进 `inject`**。`attachments` / `llm` / `agentPresets` / `connection`
  在 headless 上是合法缺失；声明进 `inject` 会让整行 parking，通道压根不启动。只有「没有它就该等」
  的服务（`agents` / `commands` / `credentials` / `wechatStartup` / `agentDefaultModel`）才进 `inject`。
- **`ctx.agents` 不套用默认模型**，调用方必须自己读 `ctx.agentDefaultModel.currentSelection()` 传进去。
  没有模型的会话在 `{{model}}` 处失败，用户看到的是「消息发出去了，没有回复」。
- **所有诊断走 `reporterFor(ctx)`**（终端 + 每日日志文件双写）。桌面端 host 的 stdout 交给 Electron
  主进程，**没有终端也不落盘**；绕过 reporter 的诊断在桌面端等于不存在。
- `startup.ts` **只能认领已知动作词，永不报错**：一个 profile 里每个 app 收到同一份参数列表，
  `program.error()` 会请求进程退出并**中止整个 boot**。

## 构建约束（会以发布事故的形式惩罚违规）

- **`@deepseek-ai/*` 必须在 `peerDependencies` + `devDependencies`，绝不能进 `dependencies`。**
  装进 profile 会分裂运行时身份：`cosmokit` 的 `Symbol.for("cosmokit.volatile.write")` 分属两套模块图，
  于是 `ctx.effect()` 跨系统 → `no agent factory registered` / `cannot create effect on inactive context`。
  版本号一致，**只有 inode 能发现**。`tests/unit/manifest.spec.ts` 有专门的断言守着这条。
- `tsdown` 的 `neverBundle` 同样排除 `@deepseek-ai/*` 与 `commander`（保留单例身份）；`dts: true` 是必需的，
  因为 `exports["./startup"]` 声明了 `types` 面，而它必须指向**产物**而不是 `src/`。
- `lib/` 是 gitignore 的。从**本地目录** `dsh plugin add` 会建 `link:`，而 `link:` **不执行构建** →
  装出来的包没有 `lib/`，启动时 `failed to import` 并**静默不加载**。
- `dependencies`（下载什么）与 profile 的 `dsh.profile.bundles`（加载什么）是两处。只进前者 →
  包装好却**永不加载**，`--dump-config` 一行都没有且不报错。

## 测试纪律

- `tests/unit/**` 是可注入协作者的单元测试；`tests/integration/**` 断言**发布产物**（`globalSetup` 先 `pnpm build`），
  并用真实 launcher + 隔离 `DSH_HOME` 启动真组合。
- **本仓库反复出现的一个缺陷模式**：单测自己注入 sink/collaborator，于是**没有一个测试能观察到
  `apply` 到底有没有把它接上**。已发生至少四次（`sessionExists`、`sessionEvents`、`cwd`、`presets`、
  `onUnreadableQuote`、reporter 的 `also`）。**任何新增的生产接线，都要补一个「真实 `apply` 启动」的集成测试。**
- 变异验证是这里的惯例：改坏实现后测试**必须**失败，否则那个测试没有在测它声称的东西。
- 断言失败要有形状：本项目的取舍是**失败要可观测**，宁可启动失败也不静默降级。

## 数据落在哪里

| 内容 | 位置 |
|---|---|
| 聊天记录（DSH 自己落盘，本插件不写） | `~/.dsh/sessions/<cwd 转义>/channel-wechat-<peerId>[~g<N>]/session.v4.jsonl.zstd` |
| 插件状态 | `~/.dsh/channel-wechat/`（游标 + 会话代次） |
| 诊断日志（7 天，按本地日期分文件） | `~/.dsh/channel-wechat/log/channel-wechat-YYYY-MM-DD.log` |
| 登录凭证 | `~/.dsh/.credentials.yaml`（DSH 的凭证体系） |

日志留 7 天，但**聊天记录永不删除**——`/new` 只是换一个会话目录，旧会话会累积。

## 开发规范（用户约定，2026-10-16 起）

1. **提交规范**：完成一个任务、测试通过后**先提交代码**。格式 `type(scope): desc`，
   type 取 `feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore` / `perf`。
   （历史提交是英文散文式描述，不追溯改写；新提交按此格式。）
2. **规格归档**：讨论结果归档到 `spec/`，文件名按**日期递增**（`YYYYMMDD-<slug>.md`），
   内容格式参考 `/to-spec`（Problem Statement / Solution / User Stories / Implementation Decisions /
   Testing Decisions / Out of Scope / Further Notes）。**前期规格被推翻时，在原文上打标记**（标注 superseded
   并指向取代它的文件），不要删除。
3. **开发日志**：归档到 `docs/dev-log/`，**每个版本提交一次**，记录详细的变更记录（含被推翻的判断与实测证据）。
4. **开发流程**：确定需求 → **从 `origin/main` 切需求分支**（命名 `dev_<需求>_<yyMMdd>`）→ 更新或归档规格 →
   用 `/tdd` 开发并测试 → **每个小功能完成即提交** → 整体完成后**等用户确认**再合入 `main`；
   需求分支也要推送到远程。
5. **发版**：记录开发日志 → `npm publish` → 打 tag → 建 GitHub Release。步骤以 `docs/release.md` 为准。

> `docs/plan-v1.md` 的决策台账（Q1–Q52）是这些规范的**既有先例**：每条决策都带依据、代价与实测证据，
> 被推翻的判断也留在原地并注明。新决策照这个密度写。

## 文档地图

| 文档 | 内容 |
|---|---|
| `docs/plan-v1.md` | **实施方案（定稿）**：决策台账 Q1–Q52、架构、里程碑、风险与技术债。改架构前先读。 |
| `docs/recon/01–13` | 13 份侦察报告：协议、构建、DSH 契约、同类实现评估。有精确行号依据。 |
| `docs/release.md` | 发布实测步骤 + 两个历史陷阱 |
| `docs/design.md` / `docs/事实核查.md` | 早期设计稿与协议性质核查（部分已被 plan-v1 取代） |
| `docs/protocol/protocol_zh_CN.md` | 腾讯协议文档副本 |
| `README.md` / `README.en.md` | 用户面：安装、用法、已知问题、不做的事 |
| `docs/recon/_analysis/` | 第三方源码只读证据，**gitignore，不进仓库** |

## 已知问题（记录，未修；动手前先读 plan-v1 §Q45）

- 引用**自己的消息**时客户端只给 `svr_id`（不内联原文）→ 显示「（引用的消息内容未能读取）」。
  要还原需自建消息缓存（plan-v1 §Q45① 已论证不做）。
- `message_id` 声明为 `number` 而服务端是 uint64。**只改类型完全无效**——精度在 `JSON.parse` 就丢了，
  必须仿参考实现在 parse 前把 `message_id` / `msg_id` / `svr_id` 引号化。触发条件是做引用缓存时。
- plan-v1 §Q52：插件**尚未在启动时校验默认模型可用性**。不可用的模型和缺失的 `cwd` 是同一类错误，
  目前只有后者有形状。
