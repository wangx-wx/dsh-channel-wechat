# dsh-channel-wechat

把微信（腾讯 iLink / ClawBot）接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**通道插件**。

> 状态：**M1 登录已完成**（v1 尚未发布）

---

## 这是什么

一个标准的 DSH **插件 + bundle**（单包），在 Harness 进程内运行，无需独立桥接进程：

```
微信用户 ⇄ 腾讯 iLink ⇄ 【本插件（DSH 进程内）】
              ├─ getUpdates 长轮询收消息
              ├─ agent.followup() 原生注入会话
              ├─ session/event → sendmessage 回发
              ├─ 审批卡（微信与 GUI 双端）
              └─ 设置页面板（web / 桌面端）
```

- **协议层移植腾讯官方实现**（`@tencent-weixin/openclaw-weixin`，MIT），保真度与测试基线俱佳
- **DSH 集成层全新写**，严格遵循官方契约（类型安全，非鸭子类型）
- **多工作目录**：一个微信用户可绑定多个会话，`/cwd` 切换 = 在该目录新建会话
- **解耦长轮询与处理**：长任务期间仍收消息，`/stop` 可打断

## 与同类插件的差异

| | `dsh-wechat` | `dsh-weixin` | **本插件** |
|---|---|---|---|
| 类型 | TS strict | 纯 JS | TS strict |
| 协议保真 | 入站媒体三处缺口 | 无 `-14`/去重 | 对齐官方 + 移植官方测试 |
| 斜杠命令 | 17 个 | 无 | 原生透传 + 6 个自管 |
| 并发 | 串行阻塞 | 串行阻塞 | 解耦 + 可打断 |
| 面板 | 自建 HTTP API | 零鉴权面板 | 正规客户端插件（自动两端） |

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
| **M1** ✅ | 扫码登录 + 凭证持久化 | 重启免登录 |
| **M2** | **文本端到端** | 微信发消息 → DSH 回复到达 |
| M3 | 命令 + `/stop` | 原生命令有回执；能打断 |
| M4 | 媒体双向 + 引用 | 发图能理解，产出文件能收到 |
| M5 | 审批卡 | 微信批准/拒绝，GUI 卡同步 |
| M6 | 设置页面板 | web 与桌面端都可见 |
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
