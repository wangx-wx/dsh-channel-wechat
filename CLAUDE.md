# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

把微信（腾讯 iLink / ClawBot）接入 DeepSeek Harness 的 **channel 插件**。单包同时是插件与 bundle，
运行在 Harness 进程内（没有独立桥接进程）。用户面说明见 [`README.md`](./README.md)。

## 常用命令

```bash
pnpm install
pnpm test              # 单元测试（毫秒级）
pnpm test:integration  # 真组合：先 pnpm build，再用真实 launcher 启动隔离 DSH_HOME
pnpm test:all
pnpm build             # tsdown → lib/（prepack 自动执行）
pnpm typecheck

# 单文件 / 单用例
pnpm exec vitest run --project unit tests/unit/reply.spec.ts
pnpm exec vitest run --project unit -t 'the id space'
```

⚠️ **干净 checkout 上 `pnpm typecheck` 会失败，直到 `pnpm build` 跑过一次**：集成测试 import
`dsh-channel-wechat/startup`，该子路径经 `exports` 解析到 `lib/startup.d.ts`。

集成测试要真实 launcher，默认用本地 DSH 仓库（`tests/support/harness.ts` 的 `DEFAULT_CHECKOUT`），
`DSH_CHECKOUT=` 可覆盖，不存在时回退到 `DeepSeek Harness.app` 的 dsh shim。它们用临时目录作
`DSH_HOME`，**不会触碰开发者的真实 profile**。

**发版**：照 [`docs/release.md`](./docs/release.md) 走。那是实测步骤，含两个已踩过的陷阱，不要凭常识重写。

## 分层

```
index.ts        装配点：name / inject / Config / apply，把下面各层接起来
startup.ts      独立 entry（dsh-channel-wechat/startup），解析 app 参数并 provide wechatStartup
login-command.ts / credentials.ts   CLI 登录动作 + 凭证读写（存 ctx.credentials）

wechat/   协议层 —— 移植腾讯 @tencent-weixin/openclaw-weixin（MIT）。**不得 import 任何 @deepseek-ai/***
          api / crypto / cdn / cdn-upload / media-download / inbound / login-* / qr / types
channel/  通道层 —— monitor（长轮询，独立循环）/ channel（五件事的接线）/ runtime（从凭证起跑）
          single-run（一次运行的所有权）/ mount + panel + login-routes（登录面板）
          log-file + report（落盘诊断）/ cursor-store / peer-session-store（会话代次）
bridge/   桥接层 —— peer-map（peer↔session + 串行化）/ dispatcher（消息→agent.followup）
          reply（assistant/message→微信）/ commands + local-commands + native-commands
          cards + pending-cards + cards-service / media / deliverables / send-file
vendor/   内联的 qrcode-generator；MIT 头靠 tsdown 的 banner 保留，见 THIRD_PARTY_NOTICES.md
```

**三条分层纪律**：`wechat/` 不 import 任何 `@deepseek-ai/*`；`bridge/` 只用官方文档化的 API；
所有 `@deepseek-ai/*` 走 peer + dev 声明。

## 关键不变量

这些规则的共同点是**违反后不会报错**——行为悄悄变错、启动静默失败，或到真实用户那里才暴露。
一句话版本如下，**详细依据、违反后果与证据见 [`docs/invariants.md`](./docs/invariants.md)**：

- **会话 id 是 peer 的纯函数**（`channel-wechat-<peerId>[~g<N>]`）；起跑前必须 `sessionExists` 探测，
  否则每次重启丢掉本进程**全部**入站消息。`/new` 不是删会话（无删除 API），是代次 +1 并持久化。
- **回复读 durable `assistant/message` 事件**（`session/event`）。不订阅 → 跑得完一轮却什么也不回，
  且看起来完全健康。所以 `sessionEvents` 是必填。
- **交互卡监听必须 `{ prepend: true }`**，否则 GUI 抢走请求且**无任何报错**；
  **卡片回复必须绕过 peer 队列**，否则与提问中的那一轮**死锁**（`/stop` 同理）。
  直接调 `handleMessage` 的测试看不见这个死锁，回归测试走真实 poll 循环。
- **媒体失败绝不吞掉消息**——一律降级为追加在文本后的说明。
- **出站文件只发 `deliverables/presented` 声明的**，绝不扫描目录；`workspace/changes` 正是绝不该发的那个，
  **事件名是唯一判别依据**。
- **`cwd` 必填且创建后不可变**（故意无默认值）；`/cwd`、`/reconnect` 已注册但未实现，会明确回复。
- **可选服务用 `ctx.get()` 拿，不要写进 `inject`**（`attachments`/`llm`/`agentPresets`/`connection`
  在 headless 上合法缺失，声明进 `inject` 会让整行 parking）。
- **`ctx.agents` 不套用默认模型**，调用方须自己读 `ctx.agentDefaultModel.currentSelection()`。
- **所有诊断走 `reporterFor(ctx)`**（终端 + 日志文件双写）：桌面端 stdout 不落盘，
  绕过 reporter 的诊断在桌面端等于不存在。
- **`startup.ts` 只认领已知动作词、永不报错**：`program.error()` 会中止整个 boot。
- **`@deepseek-ai/*` 绝不进 `dependencies`**（须在 peer + dev）。装进 profile 会**分裂运行时身份**，
  版本号一致、**只有 inode 能发现**，症状是每条消息都失败。`manifest.spec.ts` 有断言守着。
- **`lib/` 是 gitignore 的**：本地目录 `add` 建 `link:`，而 `link:` 不跑构建 → 静默装成空包。
  `dependencies`（下载）≠ `dsh.profile.bundles`（加载），只进前者则永不加载且不报错。

## 测试纪律

- `tests/unit/**` 是可注入协作者的单元测试；`tests/integration/**` 断言**发布产物**并用真实 launcher
  启动隔离 `DSH_HOME`。
- **本仓库反复复发的缺陷模式**：单测自己注入 sink/collaborator，于是**没有一个测试能观察到 `apply`
  有没有把它接上**。已发生至少四次。**任何新增的生产接线，都要补一个「真实 `apply` 启动」的集成测试。**
- **变异验证是惯例**：改坏实现后测试必须失败，否则那个测试没在测它声称的东西。
- 断言失败要有形状：宁可启动失败也不静默降级。

## 开发规范

1. **提交**：完成一个任务、测试通过后**先提交**。格式 `type(scope): desc`，type 取 `feat` / `fix` /
   `docs` / `style` / `refactor` / `test` / `chore` / `perf`。（历史提交是英文散文式描述，不追溯改写。）
2. **需求规格归档**：`spec/` **只放需求规格**，文件名按日期递增（`YYYYMMDD-<slug>.md`），
   格式参考 `/to-spec`。被推翻的规格**在原文打标记**（superseded + 指向取代者），不要删除。
   文档与开发规范不进 `spec/`。
3. **开发日志**：`docs/dev-log/`，**每个版本提交一次**，记录详细变更（含被推翻的判断与实测证据）。
4. **开发流程**：确定需求 → **从 `origin/main` 切需求分支**（`dev_<需求>_<yyMMdd>`）→ 更新或归档规格 →
   用 `/tdd` 开发并测试 → **每个小功能完成即提交** → 推送到远程 →
   整体完成后**等用户确认**再合入 `main`。
5. **发版**：记录开发日志 → `npm publish` → 打 tag → 建 GitHub Release。步骤以 `docs/release.md` 为准。

> [`docs/plan-v1.md`](./docs/plan-v1.md) 的决策台账（Q1–Q52）是这些规范的**既有先例**：每条决策都带依据、
> 代价与实测证据，被推翻的判断也留在原地并注明。新决策照这个密度写。

## 文档地图

| 文档 | 内容 |
|---|---|
| `docs/plan-v1.md` | **实施方案（定稿）**：决策台账 Q1–Q52、架构、里程碑、风险与技术债。改架构前先读。 |
| `docs/invariants.md` | **不变量的详细依据**：为什么、违反后果、证据在哪个文件或哪条决策 |
| `docs/release.md` | 发布实测步骤 + 两个历史陷阱 |
| `docs/recon/01–13` | 13 份侦察报告：协议、构建、DSH 契约、同类实现评估。有精确行号依据。 |
| `docs/recon/_analysis/` | 第三方源码只读证据，**gitignore，不进仓库** |
| `docs/design.md` / `docs/事实核查.md` | 早期设计稿与协议性质核查（部分已被 plan-v1 取代） |
| `docs/protocol/protocol_zh_CN.md` | 腾讯协议文档副本 |
| `spec/` | **需求规格归档**，按日期递增 |
| `docs/dev-log/` | 开发日志，每版本一份 |
| `README.md` / `README.en.md` | 用户面：安装、用法、**数据落点**、已知问题、不做的事 |

**数据落在哪里**（会话 / 插件状态 / 诊断日志 / 凭证四处路径）见 README 的「数据落在哪里」一节。
要点：日志留 7 天，但**聊天记录永不删除**——`/new` 只是换一个会话目录。

**已知问题（记录，未修）**：见 [`README.md`](./README.md) 的「已知问题」与 plan-v1 §Q45 / §Q52。
动手前先读——两处都论证过「为什么现在不修」以及触发条件。
