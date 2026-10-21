# 架构概览

插件是一个同时包含 host bundle 与浏览器 client half 的 npm 包，运行在 Harness 进程内，不启动独立桥接进程。

```text
微信 ⇄ 腾讯 iLink ⇄ channel-wechat（DSH 进程内）
                         ├─ wechat/：协议、登录、媒体、长轮询
                         ├─ channel/：运行时、会话代次、面板、诊断
                         └─ bridge/：消息分发、回复、命令、卡片、文件
```

- 入站消息由 `agent.followup()` 注入 DSH 会话。
- 出站回复读取 `session/event` 的 durable `assistant/message` 事件，再调用微信发送接口。
- 一轮对话期间通过 `getconfig` 取得的票据周期上报 `sendtyping`，让微信显示「对方正在输入」；票据缺失或失败时静默跳过。
- 会话 id 是 peer 的纯函数；`/new` 通过代次创建新会话，旧记录不会删除。
- `/cwd` 与 `/new` 共用同一条代次机制，只是多记一个按 peer 的工作目录：会话 header 的 `cwd` 不可改，
  所以「切换工作目录」只能是「在新目录开始新对话」。目录校验在 `channel/directory.ts`，
  先校验再拆会话。
- 可选 host 服务（例如 GUI connection、attachments、llm、skills）按需通过 `ctx.get()` 获取，缺失时不阻塞 headless 通道。
- 浏览器端配置注册在 `plugins.bundle.config`，页面路由位于 `/api/channel-wechat`，复用宿主的 token fence。

更细的决策依据和不变量见 [plan-v1.md](./plan-v1.md) 与 [invariants.md](./invariants.md)；协议副本见 [protocol/protocol_zh_CN.md](./protocol/protocol_zh_CN.md)。
