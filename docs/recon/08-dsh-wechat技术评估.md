# 侦察报告 08：dsh-wechat 0.9.11 技术评估 + 版本门禁核实

> 来源：子任务 85892da2（只读分析）
> 源码：`_analysis/dsh-wechat/gh/dsh-wechat-main/`（GitHub main，TS，14,165 行）
> npm 产物：`_analysis/dsh-wechat/npm/package/`（**仅 dist/**，无 src、无 sourcesContent）
> 取证：GitHub main 的 version = **0.9.11，与 npm 一致** → 以源码为基准；`master` 404

## 1. 架构

| 模块 | 行数 | 说明 |
|---|---:|---|
| `src/index.ts` | 537 | 入口 |
| `src/weixin/*` | 1,399 | 协议层 |
| `src/bridge/bridge.ts` | **4,328** | 桥接层（**单文件占全仓 31%**） |
| `src/bridge/slash.ts` | 1,073 | 本地命令表 |
| `src/dsh/*` | 2,256 | DSH 集成（含 `session-log.cjs` 688 行**重实现 zstd 会话读取**） |
| `src/adapter/*` | 1,369 | 适配层 |
| `src/client.js` | 412 | UI |

## 2. 协议实现 —— 四项关键细节全部实现

协议层是**移植**（文件头注明 Adapted from `@tencent-weixin/openclaw-weixin` + wechat-opencode）。

| 项 | 状态 | 位置 |
|---|---|---|
| `context_token` 回带 | ✅ 缓存 + 多处回带 | `bridge.ts:1206-1208,4061,4142,4215,4231` |
| `get_updates_buf` 持久化 | ✅ 读/推进落盘/登出清空 | `monitor.ts:62-76,242-245,79-86` |
| **`errcode -14`** | ✅ **双形态识别**：JSON body + undici 因畸形 Content-Length 抛的 `InvalidArgumentError`（走 cause 链）；**跳过重试**；notifyStart 重建 + 5s→5min 指数退避 | `api.ts:97-101,114-138,254-257`；`monitor.ts:20-37,125-189` |
| **消息去重** | ✅ `message_id`/`seq` + `from_user_id`，30min/4096；**首个 await 前同步占位** | `bridge.ts:1161-1166,1177-1185` |

**额外亮点**：识别「HTTP 200 + `ret:-2` + prepare failed」这一真实限流响应并转缓存，不误判成功（`api.ts:56-69`）。

### ⚠️ 入站媒体三处协议保真缺口（比对官方协议文档）

| 缺口 | 后果 |
|---|---|
| 未读 `image_item.aeskey`（grep 确认 inbound 路径零出现） | 违反「aeskey 优先于 media.aes_key」 |
| 无 key 时 `return null` 而非按明文处理 | 与官方「两者都无则按明文下载」不符 |
| 未用 `full_url`（`types.ts:48-52` 无该字段） | 与官方「优先 full_url」不符 |

## 3. DSH 集成方式

- **`export const inject = []`（空数组）**
- 靠 **`ctx.get()` 结构化类型** + **条件 `ctx.inject([...])`**
- 写死 init 注入：`tools`、`commands`、`systemPrompt`、`webServer`
- `ctx.get` 取：agents/sessionQuery/workspaceRegistry/agentPresets/agentDefaultModel/permissionPresets/llm/settings/sessionProjections/sessionProjectionCache
- 自己 vendored 了一份 `createUserMessage`（`dsh/messages.ts`），与 `dsh-weixin` 同样的鸭子类型策略

## 4. 会话模型

- `state.json` 里 `users: Record<userId, UserState>`，**数据结构支持多用户，但运行期强制单用户**（`:1205` 锁首个 peer，`:1170,1201` 忽略他人）
- `cwd` 四层优先级：config 默认 → 建用户时快照 → `cwdExplicit=true` 后不被设置页覆盖 → `sessions.ts:143-150` 写 `meta.cwd`
- 会话 id 用 `session-${uuid}`（与 GUI 同款），并 `attachSession` 挂工作区
- resume 失败可选换新会话

## 5. 能力清单

- 入站：文本/图片/文件/视频/语音/**引用**；群消息丢弃
- 出站：文本（4000 分片）/图片/视频/文件/打字指示器/**执行过程合并**
- 本地命令 **17 个**（含 `/rp`、`/rq`、`P{n}=` 定向回复）；DSH 原生命令经 `ctx.commands` **动态分发**
- **审批/提问卡 ✅**：waterfall 竞速 + **分叉 signal 只 abort GUI 卡不碰 turn signal** + 软超时不代决策
- **主动推送 ✅** 三个口：`send_wechat` 工具、每轮输出、跨会话 notify（默认关）

## 6. 代码质量

- `strict` + `noUncheckedIndexedAccess`，**零 `@ts-ignore`/`TODO`**
- **40 test 文件 / 493 用例 / 112 describe**，含 issue 编号回归测试
- 注释质量高（解释"为什么"+引用上游 PR/issue）
- 缺陷：`media.ts:100-103` 空 if 死代码；**`src/client.js` 412 行因 `checkJs:false` 完全无类型检查**；出站语音推测不可达
- ⚠️ `bridge.ts` **4,328 行单文件**

## 7. ★ 版本门禁：README 宣称不实（已由 DSH 源码独立核实）

`dsh-wechat` 的 package.json **无 `dependencies`、无 `peerDependencies`**，只有：
```json
"engines": { "node": ">=20.0.0", "dsh": ">=0.2.0-rc.2" }
```
README:36 宣称「低于该版本的 DSH 安装时会被拒绝」。

### 核实结论：**该宣称不实**

**证据一（决定性）**：`packages/boot/app-boot/src/plugin-compatibility.ts:60-72` 的第一行逻辑：
```ts
if (!Object.hasOwn(fields, 'peerDependencies')) return undefined
```
**没有 `peerDependencies` 就直接跳过整个检查。** 而 `dsh-wechat` 完全没有 peerDependencies ⇒ **安装期无任何版本门禁**。

**证据二**：`packages/util/package-manifest/src/types.ts:23-24` 的 JSDoc 原话：
> `/** Runtime requirements; DSH compatibility is **declarative until a reader enforces it**. */`

**证据三**：`packages/boot/app-boot/src/` 全目录 grep `engines` **零命中**；全仓 `engines` 命中项里没有一处读取 `engines.dsh`。

**证据四**：门禁确实读 peer，且判定用 `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`。

⇒ **DSH 版本门禁读 `peerDependencies`，不读 `engines.dsh`。** 这与 [recon/03](./03-依赖声明与发布规则.md) 的结论一致，并给出了决定性代码证据。

## 8. 依赖策略：两条并列合法路线

| 路线 | 代表 | 手段 | 代价 |
|---|---|---|---|
| **A：声明 peer** | recon/03 推荐 | `peerDependencies` + `devDependencies` | 用户需处理 peer 版本；**获得安装期门禁** |
| **B：零依赖** | `dsh-wechat` / `dsh-weixin` | `ctx.get()` + 结构化类型；手写 vendored 小工具 | 真·零运行时依赖、安装轻；**失去安装期门禁**，只靠运行期 `console.warn` |

`dsh-wechat` 选 B，取舍是有意识的。**唯一真问题是 README 该处宣称不实**。

另：发布包含 `.js.map`/`.d.ts.map`，偏离 DSH 仓内约定（但 out-of-tree 无门禁约束）。

## 9. README 已知边界可信度

第 223-238 行共 **7 条 + 1 条宏观边界**（Markdown 过滤策略 / 执行过程无折叠 / 卡片竞速与重启丢失 / `send_wechat` 共享 10 条预算 / preset 需空白会话 / 去重不持久化不跨实例 / 会话创建串行）。

**逐条核查全部能在源码找到对应，常量值一致**（30min、4096、10、7、100）。
⇒ **该章节可信**——与 §7 的 engines 宣称形成对比。

## 10. 两个实现对比（综合 recon/07 + 08）

| 维度 | `dsh-wechat` 0.9.11 | `dsh-weixin` 0.2.1 |
|---|---|---|
| 语言/类型 | **TypeScript strict + noUncheckedIndexedAccess** | 纯 JS，无类型 |
| 规模 | 14,165 行 | 1,595 行 |
| 测试 | **40 文件 / 493 用例** | 4 文件 / 37 用例 |
| `errcode -14` | ✅ 双形态识别 + 退避 | ❌ **完全未处理** |
| 消息去重 | ✅ 30min/4096 | ❌ **无** |
| Slash 命令 | ✅ 17 个 + DSH 原生命令动态分发 | ❌ **完全没有** |
| 审批/提问卡 | ✅ waterfall 竞速 + 分叉 signal | ❌ 无 |
| 主动推送 | ✅ 三口 | ✅ 三口 |
| 媒体出站 | ✅ 图片/视频/文件 | ❌ **仅下载，不能发** |
| 多用户 | 数据结构支持，**运行期强制单用户** | 每用户独立会话 |
| 鉴权 | 设置页 + `/wechat/qr` 路由（细节未查） | ❌ **完全无鉴权（安全缺口）** |
| 依赖 | 零 deps / 零 peer | schemastery + qrcode-generator |
| 版本门禁 | ❌ 无（且 README 宣称不实） | ❌ 无 |
| 活跃度 | 0.9.11，2026-10-07 | 0.2.1，2026-08-15 |
| 月下载 | **3,935** | 474 |
| 更新记录 | 37 版本 | 7 版本 |

## 11. 对项目决策的含义

1. **`dsh-wechat` 在工程成熟度上明显领先**：TS strict、493 用例、`-14`/去重/命令/审批卡全有、媒体出站完整。**它不是"能用的原型"，是打磨过的产品。**
2. **要超越它的成本很高**：14,165 行 + 493 用例 + 37 个版本迭代的积累。
3. **两个实现共同的架构弱点**：都靠鸭子类型耦合宿主契约（vendored `createUserMessage`、`ctx.get` 无类型护栏）。在 DSH pre-stable 阶段（0.2.0-rc.1，契约仍会变）这是真实风险。
4. **可改进点依然存在**：`dsh-weixin` 的鉴权缺口、`dsh-wechat` 的入站媒体三处协议保真缺口、`bridge.ts` 单文件 4,328 行。但这些是**对已有项目的贡献**，而非新造轮子的理由。
