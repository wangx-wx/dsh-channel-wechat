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

- `tests/unit/**` 验证可注入协作者；`tests/integration/**` 验证真实 `apply`、发布产物和隔离 launcher。
- 新增生产接线必须有真实 `apply` 启动的集成测试，不能只在单测里注入同一个 sink。
- 重要行为应有变异验证：改坏实现时，声称覆盖该行为的测试必须失败。
- 断言应保留清晰的失败形状；不要通过静默降级、删除测试或放宽检查规避问题。

## 文档与协作

- README 只保留用户入门、配置、排障和文档索引；详细架构、协议、决策和历史放在 `docs/` 或 `spec/`。
- `spec/` 只放按 `YYYYMMDD-<slug>.md` 命名的需求规格；被推翻的规格保留原文并标注取代关系。
- `docs/dev-log/` 记录版本变更、被推翻的判断和实测证据。
- 变更前保留用户已有修改；未经明确授权，不执行破坏性清理、强制 reset、推送、发布或合并。
- 完成文档或代码任务后，报告实际执行过的命令、通过项、失败原因和未验证事项。
- 发布任务使用 [skills/release-workflow/SKILL.md](./skills/release-workflow/SKILL.md)；`docs/release.md` 只保存发布事实和历史陷阱。

## 文档地图

| 文档 | 用途 |
|---|---|
| [README.md](./README.md) | 用户安装、使用、数据位置和排障入口 |
| [docs/configuration.md](./docs/configuration.md) | 配置字段、默认值和生效方式 |
| [docs/development.md](./docs/development.md) | 开发、构建和测试 |
| [docs/architecture.md](./docs/architecture.md) | 模块关系和运行时边界 |
| [docs/invariants.md](./docs/invariants.md) | 不变量、后果和证据 |
| [docs/plan-v1.md](./docs/plan-v1.md) | 决策台账、里程碑和技术债 |
| [docs/protocol/protocol_zh_CN.md](./docs/protocol/protocol_zh_CN.md) | 腾讯 iLink 协议副本 |
| [skills/release-workflow/SKILL.md](./skills/release-workflow/SKILL.md) | 发布主流程 |
| [docs/release.md](./docs/release.md) | 发布事实与历史陷阱 |
