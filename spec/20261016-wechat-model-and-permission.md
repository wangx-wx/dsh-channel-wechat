# 需求规格：插件内配置「默认模型」与「会话权限」

日期：2026-10-16
分支：`dev_wechat_model_perm_20261016`
状态：**开发中**

## 1. 背景

用户提出两条：

1. 插件设置里增加**模型配置**，风格与 GUI/web 一致。
2. 插件设置里增加**权限配置**，风格与 GUI/web 一致（如「工作区内修改」「仅查看」「完全权限」），
   并明确要求**探讨能放开到多少**。

两条都是「在插件自己的详情页里配」，沿用 v0.1.2 已建立的 `plugins.bundle.config` 槽位与
分组卡片版式（见 `spec/20261016-gui-login-and-config.md`）。

## 2. 用户裁定（本规格的约束条件）

| 问题 | 裁定 |
|---|---|
| 模型的归属与作用域 | 存在**插件自己的配置**里；改动**只作用于微信通道**，不影响 GUI 会话 |
| 模型选项列表 | 必须与**环境里实际可用的模型列表一致**（实时读取，不得硬编码） |
| 是否必须与官方 Models 页完全一致 | 不必，「无法完全和官方一样也可以」 |
| 权限提供哪几档 | **三档全给**，含「完全权限」 |
| 权限改动的作用域 | **只改微信自己的会话**，用 `permissionPresets.set(session, …)` |
| 确认流程 | 宿主 `set()` 没有风险确认（见 §3.4），因此**确认由插件自己加** |
| 提权漏洞（§5） | 用户裁定**不改**：单方通道，不会有他人发消息 |

## 3. 侦察结论（决定方案的事实，均带证据）

### 3.1 官方选模型组件插件拿不到

- `packages/client/ui-model-selection/src/client/index.ts:33-37` 只再导出
  `ModelDirectory`、`ModelDirectoryResolver`、`ModelSelectInjected`、`ModelKey`；
  **`ModelSelect` 本身没有从 client 入口再导出**（它只在 `ModelSelect.tsx:64` 导出）。
- 它**不在**壳的冻结模块表里：`packages/client/web/src/platform.ts:8-14` 的
  `PLATFORM_MODULES` 恰为 9 项（react / react-dom / cordis / client-store / ui-slots /
  ui-primitives / ui-dockkit）。运行时 `require()` 会命中
  `packages/client/modules/src/client/system.ts:319-330` 的 “missed the module table” 抛错。
- 唯一替代 `dsh.client.external` 是加载**另一个插件的 graph row**
  （`system.ts:243-273`），而 `packages/client/AGENTS.md` 明文说明它不是 feature plugin
  的依赖机制。

⇒ **必须自建选择器。** 但 `Menu`（锚定下拉，带 `selectedId`/`anchor`/`onSelect`）是
primitives 正式导出且在模块表内，且**官方权限选择器就是这么实现的**
（`ui-permission-presets/src/client/PermissionRow.tsx` 的 `Menu` 用法）。
用它即可保证观感一致。

### 3.2 模型：读得到、写得进，但写入语义是「全局默认」

- 读：`ctx.agentDefaultModel.currentSelection(): ModelSelection` —
  `packages/core/agent-default-model/src/index.ts:67`（本插件已在用）。
- 写：`await ctx.agentDefaultModel.saveSelection(next)` — 同文件 `:82`，经
  `configEditor.edit()` 落到 **profile `cordis.patch.yml`** 的 `agent-default-model` 条目
  （`packages/bundle/base/cordis.patch.yml:82-87`）。
- 列模型：`ctx.llm.listProviders()`（`llm/src/index.ts:478`）、`listModels(provider)`
  （`:702`）、`resolveModelInfo()`（`:740`）。本插件已有 `LlmLike` 只声明了后者。

**关键**：`saveSelection()` 改的是**全局默认**，会影响 GUI 新建的会话。用户要求作用域
**只限微信通道**，因此**不能**用它。可行做法是复用官方在 webhook 上的先例：

- 创建/恢复会话时传 `agentOptions: { provider, model }`
  （`AgentOptions` 见 `packages/core/agent/src/runtime-types.ts:26-35`），
  本插件**已经在传**（`src/index.ts` 的 `sessionOptions`，来自全局默认）；
- 把来源从「全局默认」改为「插件配置，未配置时回退全局默认」即可，**不改架构**。

### 3.3 权限：per-session 有公开 API，且本插件已具备审批卡

- `ctx.permissionPresets.set(session, name)` —
  `packages/interaction/permission-presets/src/index.ts:398`，写 durable 事件
  （`permission/preset` + `sandbox/mode` + `approval/policy`），可重放、重启存活。
- 读：`current(session)`（`:343`）、`catalog()`（`@Remote('catalog')`，`:292`）、
  `resolve(name)`（`:369`）。
- 官方 webhook 的现成模式：创建后
  `ctx.permissionPresets.set(handle.agent.session, resolved.permissionPreset)`
  （`packages/webhook/webhook/src/session.ts:151`）。
- `CreateAgentOptions` **没有**权限字段（`packages/core/agent/src/index.ts:63-119`），
  所以只能在创建**之后**设置。

### 3.4 三个出厂预设，只有「完全权限」会关掉审批门

`packages/bundle/base/cordis.patch.yml:250-262`：

| 预设 | sandbox | approval |
|---|---|---|
| `read-only` | `read-only` | `ask` |
| `workspace-write` | `workspace-write` | `ask` |
| `danger-full-access` | `danger-full-access` | `never` |

`never` 在 approval 服务**内部、waterfall 之前**即返回 `rejected`
（`packages/interaction/user-approval/src/index.ts:275`），因此本插件
`prepend: true` 的微信审批卡（`src/bridge/cards-service.ts:190-192`）**根本不会被调用**。

⇒ 选「完全权限」= 本插件的确认机制被整体关闭。用户已确认要提供该档，因此
**插件自己必须补一个显式风险确认**，对齐官方客户端的做法（`RiskConfirmation` 组件，
`ui-permission-presets/src/client/PermissionRow.tsx:105-113` + locale `confirm.*`）。

### 3.5 宿主侧 `set()` 没有风险确认

「Enable Full access?」的勾选框**纯属客户端 UI**
（`ui-permission-presets/src/client/PermissionRow.tsx:81-84,105-113`）。服务端 `set()`
接受直接调用、无 gate。所以 §3.4 的确认必须由本插件实现，不能指望宿主。

## 4. 方案

### 4.1 配置字段（`Config`）

新增两个 **volatile** 字段（volatile 是它们能出现在表单里的唯一原因）：

| 字段 | 形态 | 语义 |
|---|---|---|
| `model` | `{ provider, model }` 可选，默认空 | 空 = 跟随 profile 全局默认；非空 = 微信会话使用它 |
| `permission` | `'read-only' \| 'workspace-write' \| 'danger-full-access'`，默认 `'workspace-write'` | 微信会话的权限预设 |

两者都**只作用于本通道创建的会话**。

### 4.2 宿主接线

- 模型：`sessionOptions` 由「全局默认」改为「`config.model` 有值则用它，否则全局默认」。
  仍在 create/resume 时传入，架构不变。
- 权限：会话**创建后**调用 `ctx.permissionPresets.set(session, config.permission)`。
  `permissionPresets` 用 `ctx.get()` 获取而非写进 `inject`——该服务在无沙箱执行器的
  组合上会构造失败（`permission-presets/src/index.ts:219-221` 明确 throw），把它写进
  `inject` 会让整行 parking，违反本仓库「可选服务用 `get()`」的不变量。

### 4.3 页面上新增两个字段

沿用现有分组卡片与字段节奏：

```
审批卡展示位置   （已有）
────────────────
默认模型         ← 新增：Menu 锚定下拉，选项来自实时模型目录
影响之后新建的微信会话；不改 GUI 的默认模型
────────────────
微信会话权限     ← 新增：SegmentedControl 三段
控制微信会话能改哪些文件；选「完全权限」需二次确认
```

- 模型：`Menu` 渲染 provider/model 两级（或扁平 `provider/model` 标签）。
  选项由宿主路由实时读取 `ctx.llm` 提供，**不硬编码**。
- 权限：`SegmentedControl` 三段；选第三段时先弹 `RiskConfirmation`，
  文案对齐官方 `confirm.*`（「确认启用完全权限？」+ 勾选「我已了解风险」）。

### 4.4 路由

在既有 `/api/channel-wechat/*` 下新增（沿用 `PANEL_PREFIX`，受 token/cookie 围栏保护）：

- `GET /models` → `{ groups: [{ id, name, models: [{ id, name }] }], current: {...} }`
- 权限选项无需新路由：三档是固定枚举，直接写进字典。

## 5. 已知边界（记录，不修）

**微信端可自行提权**：`/permission` 是 host 命令
（`permission-presets/src/index.ts:258-278`），而本插件的 `routeCommand` 把非本地命令
一律转发给 harness（`src/bridge/commands.ts:84-90`，`LOCAL_COMMANDS` 只有
`stop/status/new/cwd/help/reconnect`）。因此任何能给该微信号发消息的人发送
`/permission danger-full-access` 即可关闭审批门。

- **持久性**：写 durable session 事件，**重启后仍在**；但绑定具体会话，
  `/new`（代次 `~g<N>`）会重新按默认预设起跑。最坏影响 = 污染当前这段对话。
- **用户裁定不改**：通道为单方（`src/bridge/dispatcher.ts:10-13` 的 Q37 决策：
  `{ kind: 'user' }` 让微信消息继承与本地输入同等的权限），操作者即用户。

## 6. 不做

- 不复刻官方 Models 页的 provider/凭据管理（`llm-*` 命名空间）：那会绕过
  `remote.credentials` 的凭据入口与 `llm.discoverModels` 探测，且属重复功能。
- 不写全局 `permission.defaultPreset`：会影响 GUI 新建的会话，超出本通道范围。
- 不改模型配置的全局归属。

## 7. 验收

- 单测：配置 schema 默认值/枚举合法性；`sessionOptions` 在「插件配置优先、回退全局」两态下的取值。
- 集成（真实 `apply` + 真实 launcher）：新增接线必须有真实启动的集成测试——模型选择
  真正传到会话、权限真正落到会话事件上。
- 变异验证：改坏实现后对应测试必须失败。
