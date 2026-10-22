# dsh-channel-wechat 开发说明

本仓库把微信（腾讯 iLink / ClawBot）接入 DeepSeek Harness。它是一个同时提供 host bundle 和浏览器端的 channel 插件，运行在 Harness 进程内，不启动独立桥接进程。

用户安装和使用说明见 [README.md](./README.md)；贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 常用命令

```bash
pnpm install
pnpm build             # 生成 lib/，并复制浏览器端 client.js
pnpm typecheck
pnpm test              # unit 项目
pnpm test:integration  # integration 项目，真实 launcher + 隔离 DSH_HOME
pnpm test:all

# 单文件或单用例
pnpm exec vitest run --project unit tests/unit/reply.spec.ts
pnpm exec vitest run --project unit -t 'the id space'
```

干净 checkout 首次执行 `pnpm typecheck` 可能因 `exports` 指向尚未生成的 `lib/*.d.ts` 失败；先运行 `pnpm build`。集成测试默认使用 `tests/support/harness.ts` 中的本地 DeepSeek Harness checkout，可用 `DSH_CHECKOUT=/path/to/deepseek-harness` 覆盖；测试使用临时 `DSH_HOME`，不会修改真实 profile。

发布步骤以 [docs/release.md](./docs/release.md) 为准，不要凭常识改写。

## 代码分层

```text
src/index.ts       插件装配、Config、apply、命令行动作认领
src/wechat/        iLink 协议、登录、媒体与 API
src/channel/       长轮询运行时、面板、会话代次、诊断
src/bridge/        消息分发、回复、命令、卡片、媒体与文件
src/client/        GUI 浏览器端（手写 lazy-CJS）
src/vendor/        内联第三方代码
```

必须保持的边界：

- `src/wechat/` 不得 import `@deepseek-ai/*`；协议层保持可独立测试。
- `@deepseek-ai/*` 只能作为 peer + dev 依赖，不能进入 `dependencies` 或被打包复制；宿主必须共享同一运行时实例。
- `src/client/client.js` 由 `scripts/copy-client.mjs` 复制到 `lib/`，不要为它引入 bundler。
- 可选 host 服务通过 `ctx.get()` 获取；不要把 headless 合法缺失的服务加入 `inject`。
- 所有诊断使用 `reporterFor(ctx)`，保证终端和日志文件都能看到。

更完整的模块关系见 [docs/architecture.md](./docs/architecture.md)。

## 关键不变量

修改相关实现前先读 [docs/invariants.md](./docs/invariants.md) 和 [docs/plan-v1.md](./docs/plan-v1.md)。尤其注意：

- 会话 id 是 `channel-wechat-<peerId>[~g<N>]`；启动前必须探测既有 session，`/new` 只增加会话代次。
- 回复必须订阅 durable `session/event` 的 `assistant/message`；不订阅会导致整轮完成但没有微信回复。
- 交互卡监听需要 `{ prepend: true }`；卡片回复和 `/stop` 必须绕过 peer 队列，避免死锁。
- 媒体失败要降级为文本说明，不得吞掉入站消息。
- 出站文件只发送 `deliverables/presented` 声明的文件，不扫描工作目录。
- `cwd` 必填且在会话创建后不可变；`/cwd` 与 `/reconnect` 已注册但尚未实现，必须明确回复。
- `ctx.agents` 不会自动套用默认模型；创建会话时读取 `ctx.agentDefaultModel.currentSelection()`。
- 命令行只认领 `login`、`logout`、`status`，不能因其他 app 的参数调用 `program.error()` 终止整个 boot。

## 测试纪律

### 分层与断言

- `tests/unit/**` 验证可注入协作者；`tests/integration/**` 验证真实 `apply`、发布产物和隔离 launcher。
- 新增生产接线必须有真实 `apply` 启动的集成测试，不能只在单测里注入同一个 sink。
- 重要行为应有变异验证：改坏实现时，声称覆盖该行为的测试必须失败。
- 断言应保留清晰的失败形状；不要通过静默降级、删除测试或放宽检查规避问题。
- **断言前先问：这是「观察到的现状」还是「想要的语义」。** 把现状写成断言会把缺陷锁死：
  `reply.spec.ts` 曾断言「含 `tool-call` 的消息也要发」，于是「一句话挂个冒号」的真缺陷
  被测试保护了很久，没人再怀疑它。

### 跑测试的硬规则

- **一次只跑一个 vitest 进程。** 集成测试会真实启动 DSH launcher 并各自绑定端口；两个进程
  同时跑会互相抢资源，`client-half-form` 这类套件会整片假失败（实测 16/16 全红，单独跑 16/16 全绿）。
  跑集成前先确认没有别的 vitest 在跑。
- **中断集成测试后必须清理孙进程。** vitest 通过 `cmd /c`（Windows）拉起 DSH launcher，
  那是**孙进程**：杀掉 vitest/pwsh 不会级联终止它，父进程一死它就脱管，继续空转烧 CPU。
  实测一次会话中残留 15 个孤儿进程、3.98 GB 内存、约 8 万秒 CPU。
  清理前先判定「父进程已死 + 不在真实应用进程树内」，逐个复验再动手：

  ```powershell
  # 找出父进程已不存在的 DSH launcher
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
  $ids = @{}; foreach ($p in $all) { $ids[[int]$p.ProcessId] = $p }
  $all | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -and -not $ids.ContainsKey([int]$_.ParentProcessId) }
  ```

- **`pnpm test:all` 可以跑，但中断它代价高。** 实测它能正常完成（787 passed，22s）；问题在于它同时
  启动多个真实 launcher，一旦中途 Ctrl-C 或超时，就会有多个孙进程同时脱管。日常用分项目命令
  （`pnpm test` 仅 unit，实测 4.9s；`pnpm test:integration` 单独跑），只在提交前完整验证时用 `test:all`，
  并等它自然结束。
- **超时要显式设置。** 默认 5s 对集成套件不够；跑整套时给 `--testTimeout=20000 --hookTimeout=20000`。
- 集成测试需要 launcher：源码 checkout 用 `DSH_CHECKOUT`，打包版用 `DSH_PACKAGED_SHIM`
  （Windows 上形如 `D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd`）。

### 测异步行为

- **测顺序时，被排序的副作用必须真的异步。** 变异验证若在错误顺序下仍然通过，先检查这点：
  `send` 里不含 `await` 时，发送会在同一批微任务里完成，错误顺序也能通过。
- **生产代码的 `await` 数量是契约的一部分。** 抽模块时「行为等价」不等于「时序等价」：
  把 `prepareMedia` 抽成独立 `async` 模块（多一个挂起点）就让入站投递推后一个微任务，
  `runtime.spec.ts` 的回复测试立刻变红。通常无事可做的步骤，应在任何 `await` 之前返回。
- 等待某个状态成立时用轮询（`until(...)`），不要用固定 `setTimeout` 猜时间。

### 跨平台

- **测试里不要硬编码某一平台的路径。** `path.isAbsolute` 是平台绑定的：`D:\work\next` 在 Windows
  上是绝对路径，在 Linux 上不是。这类字面量会让测试在 Windows 绿、在 ubuntu 红——CI 就是这样挂的，
  而且失败点在校验分支，压根没走到被测代码。需要绝对路径时按 `process.platform` 拼。
- **纯字符串处理不受此限。** `deliverables.ts` 自己判断「POSIX 或 Windows 都算绝对」，不经过
  `node:path`，所以可以在任一台机器上断言另一种拼写；`peer-map`/`peer-session-store` 只把 cwd
  当字符串存取，同样安全。**判断依据是「这段代码是否调用 `node:path` 或真的访问文件系统」**，
  不是「路径长什么样」。
- **只在 Windows 上绿的测试等于没验证。** 本机是 Windows，跑绿不代表 CI 绿；涉及平台行为的改动，
  提交前用 WSL 跑一遍 `pnpm test`（导出干净树到 WSL 原生文件系统，别复用 Windows 的 `node_modules`）。

## 开发流程

- 从 `origin/main` 切需求分支：`dev_<需求>_<yyMMdd>`。
- 用 TDD 开发，每个小功能完成即提交；整体完成后**等用户确认**再合入 `main`。
- 提交格式 `type(scope): desc`；type 取 `feat` / `fix` / `docs` / `style` / `refactor` / `test` / `chore` / `perf`。
  历史提交是英文散文式描述，不追溯改写。
- 代码规模：除测试文件外，单个生产代码文件原则上不超过 **500** 行，确有必要时不得无故超过 **700** 行。
  统计物理行数（含空行和注释）。生成代码、声明式配置等确有合理原因的可例外，但不要借拆分制造过度设计。
  `src/index.ts` 目前超过 700 行，拆分是独立改动。

## 文档与协作

- README 只保留用户入门、配置、排障和文档索引；详细架构、协议、决策和历史放在 `docs/` 或 `spec/`。
- `spec/` 只放按 `YYYYMMDD-<slug>.md` 命名的需求规格；被推翻的规格保留原文并标注取代关系。
- `docs/dev-log/` 记录版本变更、被推翻的判断和实测证据。
- 变更前保留用户已有修改；未经明确授权，不执行破坏性清理、强制 reset、推送、发布或合并。
- 完成文档或代码任务后，报告实际执行过的命令、通过项、失败原因和未验证事项。
- 发布任务使用 [skills/release-workflow/SKILL.md](./.dsh/skills/release-workflow/SKILL.md)；`docs/release.md` 只保存发布事实和历史陷阱。

## 文档地图

| 文档 | 用途 |
|---|---|
| [README.md](./README.md) | 用户安装、使用、数据位置和排障入口 |
| [docs/configuration.md](./docs/configuration.md) | 配置字段、默认值和生效方式 |
| [docs/commands.md](./docs/commands.md) | 微信内可用命令 |
| [docs/development.md](./docs/development.md) | 开发、构建和测试 |
| [docs/architecture.md](./docs/architecture.md) | 模块关系和运行时边界 |
| [docs/invariants.md](./docs/invariants.md) | 不变量、后果和证据 |
| [docs/plan-v1.md](./docs/plan-v1.md) | 决策台账、里程碑和技术债 |
| [docs/protocol/protocol_zh_CN.md](./docs/protocol/protocol_zh_CN.md) | 腾讯 iLink 协议副本 |
| [skills/release-workflow/SKILL.md](./.dsh/skills/release-workflow/SKILL.md) | 发布主流程 |
| [docs/release.md](./docs/release.md) | 发布事实与历史陷阱 |
