# dsh-channel-wechat

把微信（腾讯 iLink / ClawBot）接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**通道插件**。

> 状态：**M6 面板登录已完成**（v1 尚未发布）

---

## 这是什么

一个标准的 DSH **插件 + bundle**（单包），在 Harness 进程内运行，无需独立桥接进程：

```
微信用户 ⇄ 腾讯 iLink ⇄ 【本插件（DSH 进程内）】
              ├─ getUpdates 长轮询收消息
              ├─ agent.followup() 原生注入会话
              ├─ session/event → sendmessage 回发
              ├─ 审批卡（微信与 GUI 双端）
              └─ 登录面板（web / 桌面端）
```

- **协议层移植腾讯官方实现**（`@tencent-weixin/openclaw-weixin`，MIT），保真度与测试基线俱佳
- **DSH 集成层全新写**，严格遵循官方契约（类型安全，非鸭子类型）
- **多工作目录**：一个微信用户可绑定多个会话，`/cwd` 切换 = 在该目录新建会话
- **解耦长轮询与处理**：长任务期间仍收消息，`/stop` 可打断

## 登录

启动后插件会在日志里打印一个可直接打开的地址：

```
[channel-wechat] 微信登录：用手机微信打开 http://127.0.0.1:19387/api/channel-wechat/login 扫码连接
```

用**手机微信**打开它扫码，确认后**无需重启**：凭证即刻写入 `ctx.credentials`，
通道在同进程内开始轮询。

### 为什么不是 `dsh <profile> login`

因为**在挂了 web app 的 profile（web / desktop）上做不到**，这不是本插件的选择：

DSH 的启动器把**同一份完整参数列表**交给 profile 里**每个** app，各自解析。
`dsh-web-app` 的 program **只声明 flag、没有 positional**，所以 `login` 会被它判定为
`too many arguments` 并 `exit(1)` —— **boot 在到达本插件之前就结束了**。
`-- login`、`--json`、`--wechat-login`、以及把本插件的 bundle 排到 web-app 之前，
实测**全部无效**（官方 5 个解析命令行的 app 中没有一个容忍未知参数，这是刻意的设计）。

两个同类插件也都不走这条路：`dsh-wechat` 没有 CLI，只用 HTTP 页面；`dsh-weixin` 的 CLI 是
**独立可执行文件**，且 README 把面板列为首选。

CLI 的 `login`/`logout`/`status` 仍然保留，但仅在**不挂 web app** 的 profile 上有效。

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
| [docs/recon/](./docs/recon/) | **13 份侦察报告**：协议、构建、DSH 契约、同类实现评估 |
| [开发日志.md](./开发日志.md) | 按时间倒序的决策记录 |

## 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** ✅ | 包骨架 + 真组合测试 | cordis fiber 达到 `ACTIVE` |
| **M1** ⚠️ | 协议层 + 凭证持久化 | CLI 路径在 web/desktop 上不可用 → 改由 M6 面板登录 |
| **M2** ✅ | **文本端到端** | 微信发消息 → DSH 回复到达 |
| **M3** ✅ | 命令 + `/stop` | 原生命令有回执；能打断 |
| M4 | 媒体双向 + 引用 | 发图能理解，产出文件能收到 |
| M5 | 审批卡 | 微信批准/拒绝，GUI 卡同步 |
| **M6** 🔶 | 面板登录 | **已完成**：web 端实测扫码登录、扫码即启动；设置页卡片待做 |
| M7 | 发布 | `dsh plugin add dsh-channel-wechat` |

### 开发

```bash
pnpm install
pnpm test              # 单元测试（毫秒级）
pnpm test:integration  # 真组合测试：隔离 DSH_HOME 启动真实 launcher
pnpm typecheck
pnpm build
```

集成测试会在临时目录建一个隔离的 `DSH_HOME`，**不会触碰你正在使用的 dsh profile**。

## 不做的事

群聊（协议无依据）、多账号运行期、消息去重/节流（对齐官方）、提问卡（v2）、主动推送（v2）、自建权限体系。

## 许可与致谢

- 协议规范与部分实现来自腾讯 [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（**MIT**，`Copyright (C) 2026 Tencent`）
- 工程实践参考 `wechat-claude-code`（MIT）
- 本插件许可：**MIT**
