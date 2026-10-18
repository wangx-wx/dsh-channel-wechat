# dsh-channel-wechat — v1 实施方案（定稿）

> 状态：**决策完成，待用户确认后开始编码**
> 仓库：`https://github.com/wangx-wx/dsh-channel-wechat.git`
> 本地：`/Users/wangx/cc/dsh-channel-wechat/`
> 包名：`dsh-channel-wechat`（npm 404 可用）
> 依据：13 份侦察报告（见 `docs/recon/`）

---

## 0. 一句话

用 DSH 的官方契约重写一个微信（iLink / ClawBot）通道插件：**协议层移植腾讯官方实现**（保真度 + 测试基线），**DSH 集成层全新写**（类型安全、遵循官方 API），补齐两个现有实现各自的缺口。

## 1. 差异化定位

| 对比项 | `dsh-wechat` 0.9.11 | `dsh-weixin` 0.2.1 | **本插件** |
|---|---|---|---|
| 语言/类型 | TS strict | 纯 JS 无类型 | **TS strict** |
| 协议保真 | 入站媒体三处缺口 | 无 `-14`/去重，未读 aeskey | **对齐官方文档 + 移植官方测试** |
| 斜杠命令 | 17 个 | 无 | **DSH 原生透传 + 6 个自管** |
| 并发 | 串行阻塞长轮询 | 串行阻塞 | **解耦：长轮询独立，`/stop` 可打断** |
| DSH 契约 | 鸭子类型耦合 | 鸭子类型耦合 | **官方 API（类型安全）** |
| 面板 | 自建 HTTP API | 零鉴权 HTTP 面板 | **正规客户端插件（slot，自动两端）** |
| 多工作目录 | 有 | 无 | **有（对齐 GUI 语义）** |

**不追求超越 `dsh-wechat` 的功能广度，追求「协议正确 + 契约正规」。**

## 2. 决策台账（Q1–Q40）

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 受众 | 开源插件，操作者=使用者；**不设计权限体系** |
| Q2 | 协议层归属 | 自实现协议客户端，以官方为规范 |
| Q3 | 定位 | **DSH 的一个 channel**（完整通道实现） |
| Q4/Q27 | 运行形态 | **不预设 profile**，不依赖 profile 特有服务；web/headless 均可 |
| Q5 | 回复投递 | 整段投递 + 输入状态（对齐官方） |
| Q6/Q36 | 并发 | **解耦长轮询与处理**；消息进队列，每用户串行；`/stop` 可打断 |
| Q7 | 会话生命周期 | 长期复用 + 斜杠命令 |
| Q8/Q38 | 工作目录 | **多目录、会话级绑定**（设计目标）；`/cwd` = 结束当前会话并在新目录新建 —— **v1 未实现**，见 Q47 |
| Q9/Q22 | 消息类型 | **全部对齐**：文本/图片/语音/文件/视频/引用 |
| Q10 | 主动推送 | v1 预留接口，**v2 实现** |
| Q11 | channel 含义 | 完整通道实现 |
| Q12 | 包形态 | **单包**（同时是插件与 bundle） |
| Q13 | 登录态 | **解耦**：`login` 一次性扫码写凭证；运行态自动读取 |
| Q14/Q29 | 凭证 | **`ctx.credentials`**；其余自管 JSON（0600 原子写） |
| Q15/Q28 | 包名 | **`dsh-channel-wechat`** |
| Q16/Q23 | 斜杠命令 | DSH 原生透传 + 自管 6 个（`/stop` `/status` `/cwd` `/new` `/help` `/reconnect`） |
| Q17/Q21 | 代码起点 | **移植官方协议层 + 全新写 DSH 集成层** |
| Q18 | 差异化 | 功能缺失 / 无命令 / 协议不纯粹 → **完整 + 正规** |
| Q19 | 工作区 | 参考 GUI 多工作区（切换 = 切 Session） |
| Q20 | 长连接 | 微信侧不可；DSH 侧用进程内 `ctx.on` |
| Q24/Q33 | 审批卡 | **审批卡 + 提问卡都 v1**（提问卡原定 v2，见 Q42 修订） |
| Q25 | 多账号 | 单账号（数据结构预留 accountId 维度） |
| Q26 | 质量标准 | **TS strict + 协议层单测 + 真组合测试** |
| Q30 | 移植策略 | **全面移植 (a)+(b)**，连带官方测试；MIT 署名 |
| Q31 | 里程碑 | **垂直切片** |
| Q32 | 面板 | **正规客户端插件**（`dsh.client` + slot）；CLI 登录同时保留 |
| Q34 | 落地位置 | `/Users/wangx/cc/dsh-channel-wechat/` |
| Q35 | 去重/限流 | **对齐官方：都不做** |
| Q37 | `source.kind` | **`'user'`**（用户接受其语义） |
| Q39 | 面板内容 | 状态 + 会话映射 + 日志 + reconnect/logout |
| Q40 | 仓库/License | `github.com/wangx-wx/dsh-channel-wechat`；**MIT** |

### Q41（实现期新增）：`/new` 如何真正开新会话

**背景**：`/new` 原先只 dispose 句柄，但会话 id 是 peer 的纯函数、持久化会话仍在，所以下一条消息 `resume` 回**同一个**会话 —— 与它对用户的承诺相反。

**约束**：`sessionPersistence` **没有任何删除 API**（只有 `create`/`open`/`flush`/`stat`/`list`），JSONL 后端的 `rm` 是私有的。所以「结束会话」只能实现为「换一个 id」。

**结论**：每个 peer 维护一个**持久化的会话代次**（`channel-wechat/peer-sessions.json`，0600 原子写）。
- 代次 0 = 现有 id（`channel-wechat-<peerId>`），**不迁移**，已有会话照常 resume。
- `/new` → 代次 +1，下一条消息用 `channel-wechat-<escape(peerId)>~g<N>`。
- 代次持久化，所以重启后 `/new` 仍然成立（只在内存里转，重启就会 resume 回旧对话）。
- 旧会话留在磁盘上（无删除 API）；用户能在 GUI 里继续读到它，优于被静默 resume。

**代价（记录在案）**：会话文件随 `/new` 次数累积；peer id 若含 `~` 会被 escape 而孤立旧会话（真实微信 id 为 `[A-Za-z0-9_.@-]@im.wechat`，不可能含 `~`）。

**顺带修掉的回归**：原 `agentFor` 用 `sessionIdFor(peerId)` 重建 id，代次化后原生命令（`/goal`、`/compact`）会去找代次 0 的 agent。已删除这处**重复的 id 推导**：`native-commands` 改为接收**已解析的 agent**，由 channel 提供。

### Q42（实现期新增）：审批卡与提问卡一起做，且默认只发微信

**背景**：原计划 v1 只做审批卡、提问卡留 v2，并只做「防御」。真实会话证明防御不够：`ask_user_question` 被 GUI 的 answerer 抢先后，整轮**永远**等不到答案 —— 会话日志停在 `tool/call ask_user_question`，`tool/result` 数量为 0。所以提问卡不是 v2，是 v1 的必需项。

**两条 seam 的不对称（决定了实现形状）**：

| | `approval/request` | `user-questions/request` |
|---|---|---|
| 服务键 | `ctx.approval` | `ctx.userQuestions` |
| 有 id 吗 | 最多 `callId` | **完全没有** |
| durable 事件 | 有（`approval/asked`/`decided`） | **没有** |
| 超时 | 无 | 无 |
| 无人认领 | 返回 `'unavailable'` | 抛 `NO_PROVIDER` |
| 失败方向 | 可 fail-closed | **任何答案都是编造** |

因为没有 id，卡片 id 是本插件自己发的（`P1`、`P2`…，手输在手机上所以要短且大小写不敏感），两条 seam **共用同一个 id 命名空间**，否则同一句话可能命中两张卡。

**`prepend: true` 是强制的**：不带它 GUI 自己的 answerer 先跑并抢走请求，本通道**再也看不到**，且**没有任何报错**。

**配置项 `cards: 'wechat' | 'both'`**（默认 `'wechat'`）：
- `wechat`：认领，且**永不调用 `next()`** —— 一张卡只在一个地方可答。
- `both`：`Promise.race([本通道, next()])`，先答者胜。**代价**：微信先答后**无法撤回 GUI 卡**（`forkGuiCardSignal` 是未文档化依赖，故意不用），GUI 卡会滞留到该轮结束。

**超时**（30 分钟，人类耐心而非技术约束）：
- 审批 → `'unavailable'`（fail-closed）。
- 提问 → **reject**。给一个编造的答案是错的；给「作废」是诚实的。

**队列死锁（本次真正的核心风险）**：卡片回复到达时，提问的那一轮正阻塞在 `ask_user_question` 里，而**那一轮正持有该 peer 的队列**。所以任何走 `peers.runExclusive` 的回复**永远到不了**。卡片回复必须像 `/stop` 一样**绕过队列**。

> 直接调用 `handleMessage` 的测试**绕过 `serialize`**，因此**看不见**这个死锁。现有的死锁回归测试走**真实 poll 循环**。

**已知技术债（记录在案）**：
- 提问卡**没有 durable 事件**，重启后未答的卡会**变成幽灵卡**（内存里的等待者已不存在）。审批卡有审计事件，不受影响。
- `both` 模式微信先答时的 GUI 卡滞留。

### Q43（M4 实现期）：媒体用 ECB 全文解密，且失败绝不吞掉消息

**下载/解密**（`src/wechat/crypto.ts` + `media-download.ts`）：
- **AES-128-ECB，无 IV，PKCS#7**，**整个响应体都是密文**（无明文前缀）。
- **没有 md5 派生密钥** —— 密钥由服务端随消息下发。`aes_key` 有**两种编码**：
  - base64(16 原始字节)：**图片**用；
  - base64(32 位 hex 字符串)：**文件/语音/视频**用，需**再 hex 解码**。
  读错编码 → 解密失败，表现为「文件损坏」而非「key 读错」，所以 `parseAesKey` 分类后**拒绝**，不硬试。
- 图片另有 item 级 `aeskey`（**裸 hex**，优先于 `media.aes_key`）→ 在解析期统一转成 base64，让下载路径**只认一种编码**。
- 无 key = 对象**未加密**，直接拷贝（硬解会 padding 失败）。

**上传**（S2 用）：`getuploadurl` → POST 密文 → 读响应头 `x-encrypted-param` → 作为 `sendmessage` 的 `encrypt_query_param`。**下载参数本身就是引用**，没有额外 id。

**★ 核心纪律：媒体失败绝不吞掉消息。** CDN 报错、字节不被 store 接受、模型不支持图片 —— 全部降级为**追加在文本后的说明**，而不是丢弃整轮。媒体是用户所说内容的**附加物**，不是被听见的前提。图片类型靠**嗅探前导字节**判定（线上不带 media type，而 store 会校验声明类型与字节是否一致）。

**S1e 踩到的坑（记录在案）**：第一版把模型图片能力**先缓存为 false 再异步查询**，会导致每次运行的第一张图都退化成标签。验收测试抓到了；现在改为**按消息 await 查询**，查询失败答「否」（谎报支持的代价是 provider 拒掉整条消息，反过来的代价只是一张图）。

**顺带查实的既有缺陷（未修，S4 处理）**：`WeixinMessage.message_id` 我们写 `number`，而服务端是 **uint64**。已实测：`JSON.parse` 下 `9007199254740993` 与 `9007199254740992` **会碰撞成同一个值**。参考实现用 JSON 预扫描把这三个字段（`message_id`/`msg_id`/`svr_id`）**引号化**后再 parse。

**语音**：服务端已给 `voice_item.text` 转写，且无 provider 接受音频 → **不下载**。**发语音不支持**（`media_type=4` 只有类型定义，参考实现从未调用）。

### Q44（M4 出站）：只发 `present` 声明的文件；署名义务已履行

**为什么只发 `present` 声明的**：DSH **没有**「把文件发给用户」的一等 API。唯一信号是 `present` 工具写的 durable 事件 `deliverables/presented`（载荷是**路径**）。
**「产出了文件」和「这个文件是给你的」是两件事**：Agent 写报告时会顺手写一堆临时脚本/中间数据。按 `present` 发 → 只收到成品；扫描所有文件 → 收到一堆垃圾。所以**不做路径扫描**。

**邻接陷阱（实测发现）**：`workspace/changes` 事件描述**本轮碰过的所有文件**，正是绝不该发的那个。它的文件清单存在 projection 而非事件里，所以**事件名是唯一的判别依据**。测试里用「带 files 数组的非 present 事件」把这个判别钉住。

**上传的两个静默失败点**：
- 成功判定是响应头 `x-encrypted-param`，**不是状态码**。缺它就没有可引用的下载参数，记成功会发出指向空气的消息。
- `filesize` 必须是**密文（填充后）大小**，服务端拿它核对实际 POST 的内容。

**引用 `ref_msg`（出站）无法判定**：参考实现从未设置过，只有入站读取。**未实现**，也不假装支持。

**已履行的 MIT 署名义务（实测核对，非采信）**：
- 新增 `THIRD_PARTY_NOTICES.md`（含 Tencent 非标准 MIT 全文 + qrcode-generator 段）；MIT 正文与原文逐字符比对一致。
- 补齐 4 个派生文件缺失的头：`api.ts`（`classifyFetchError` 含**5 条协议文档中不存在的描述串**，这正是判定「非规范、属派生」的依据）、`login-machine.ts`、`login-runner.ts`（`480_000`/`35_000`/3 次刷新预算 + 3 条逐字文案）、`types.ts`（类型表出自**本身就是 Repo B 的**文档）。
- ★ **`docs/protocol/protocol_zh_CN.md` 是 Repo B 同名文件的逐字节副本**（md5 双侧一致）——**只看代码的审查不可能发现**。它随仓库公开（但不进 npm 包）。
- ★ **已发布的 `lib/index.js` 曾剥掉 vendored qrcode-generator 的 MIT 头**（打包器内联时丢弃 banner）。已用构建期 banner 修复，让署名跟随真正包含该代码的文件。

**留档的保留意见**：`src/bridge/cards.ts` 的卡片文案追溯到 **dsh-wechat / wechat-opencode 而非 Repo B**，而对方的 `approval-format.ts` 自身没有出处头 → 若追求完全干净，这条线索需单独核查。

**刻意不发 `present` 的 description（用户裁定，2026-10-14）**：`present` 事件里的 `description` 字段目前被丢弃，文件不带说明发出。这是**已知且有意的取舍**，不是遗漏：用户实测后认为现状（另有模型自己的文字回复 + 微信可横向滚动）已经够用，不值得再加一条消息。⚠️ 若将来要补，做法是把 description 作为一条**独立文字请求**发出——参考实现里文字与媒体本就是两条 `item_list` 长度 1 的请求。

### Q45（M4 收尾）：两处**只记录、不修复**的已知问题（用户裁定，2026-10-14）

**① 真机新证据：引用「Agent 的回答」可行，引用「用户自己的消息」不可行。**

这是关于 `svr_id` 分支的**第一条现场证据**，且与推测方向一致。微信客户端对**对方**的消息（Agent 发的）仍内联携带 `ref_msg.message_item`，对**自己**的消息只给 `svr_id`。也就是：

| 引用对象 | 客户端行为 | 我们 |
| --- | --- | --- |
| Agent 的消息 | 内联 `message_item` | ✅ `[引用] <原文>` |
| 用户自己的消息 | 只有 `svr_id` | ⚠️ `[引用] （引用的消息内容未能读取）` |

与参考实现文档对得上：*"新版微信客户端可能只在引用消息中提供服务端消息 ID（`svr_id`），而不再携带被引用消息的正文"*。

**为什么不修**：要还原 `svr_id` 必须自建消息缓存（上游为此写了 **656 行 + SQLite**）。逐段核过那 656 行后确认，**其中约 480 行与「文本引用还原」无关**：媒体生命周期（受管目录/配额/孤儿回收）~241 行、多账号隔离与单例生命周期 ~77 行、历史路径迁移 46 行、定时 GC。**纯文本核心（建表 + `put` + `find` + `open`）约 135 行**；若复用本仓库已有的 JSON 原子写模式（`peer-session-store.ts`），**约 80–100 行**即可，**不需要引入 SQLite**（且已实测本机 Node v24.16.0 的 `node:sqlite` 可用——不用它是**主动选择**，不是能力限制）。

**仍然不做的理由**：缓存**救不了历史消息**（只能还原插件启用后、且它亲眼见过的消息），而「引用自己几分钟前说的话」在微信里**用户自己看得见原文**，收益有限。当前降级形状已经**诚实**：模型知道「你在回复某条消息」，可以反问，而不是对着一个没有主语的问题硬猜。

**② `message_id` 的 `number` 精度风险：潜伏，未修。**

`src/wechat/types.ts:147` 把 `message_id` 声明为 `number`，而服务端是 **uint64**。实测：

```
{"message_id":18446744073709551615}
  → JSON.parse 后 18446744073709552000   （值变了）
  → 且 18446744073709551615 与 ...614 会碰撞成同一个值
```

**修正一处此前的夸大**：曾判断「我们现在就在用这个 number 当身份」。**复核后不成立**——全仓库该字段仅 5 处（3 处类型声明、1 处赋值、1 处读取），**唯一读取点是 `dispatcher.ts:128` 的一条错误日志字符串**；它不进 session、不做判断、`buildUserMessage` 完全不碰。所以**当前唯一的实际后果是：万一 id 超 2^53，某条错误日志会打印一个错的数字。这是潜在风险，不是现存缺陷。**

⚠️ **动手时注意**：只把类型改成 `string` **完全无效**——精度在 `JSON.parse` 阶段就已丢失，改类型只会让类型系统撒谎。必须仿参考实现的 `parseWeixinApiJson`，**在 parse 之前**对 `message_id`/`msg_id`/`svr_id` 做 JSON 字符串边界感知的引号化（约 50 行 + 测试）。

**触发条件（何时才修）**：等要做引用缓存时——那时 `message_id` 从「日志字段」变成「**查表 key**」，id 碰撞的后果从「日志难看」升级为「**引用内容张冠李戴**」。在那之前不动。

### Q46（发布后新增）：诊断落盘到每日日志文件

**为什么必须做**：`console` + 命名 logger 在**终端**够用（两个真机缺陷就是靠它发现的），但在**桌面端不够**——host 子进程的 stdout 被 `pipe` 给 Electron 主进程，而主进程**没有终端、也不写日志文件**（已核对 `host-process.ts` 与 `main.ts`，无落盘）。所以「只有夜里才发生的问题」在桌面端**不留任何痕迹**。这正好会重现 Q45① 的盲区（当时靠 `boot28.log` 才发现"引用了但读不出"）。

**形状**：`~/.dsh/channel-wechat/log/channel-wechat-YYYY-MM-DD.log`，**按本地日期分文件**，**保留 7 天**。

- **文件名用本地日期分量**，不用 `toISOString`——后者在 UTC 午夜翻页，会把西半球"晚上"的报告记到明天。测试断言经 `Intl.DateTimeFormat` 取值（**不同代码路径**，且不依赖时区；手写字面量只在 UTC+8 成立）。
- **清理挂在"当天第一次写"上，不用定时器**：进程未必活得够久让 interval 触发，而挂在写上则"没人运行的那段时间"不会让清理落后。
- **只删自己命名的文件**（前缀+后缀双重过滤），`peer-sessions.json` 等必须留下——测试用真实文件名钉住这一点。
- **sink 绝不抛出，也不闩死**。为"失败后仍能继续"写测试时**发现了我自己第一版的 bug**：`prepared` 缓存了"目录已建、窗口已清"，失败后不清掉它，一次坏写就会**让这个 sink 在进程余生里彻底沉默**——正是这个文件要终结的那个形状。

**顺带修掉三处绕过 reporter 的诊断**（用户裁定"全部诊断"）：`channel stopped`、`channel failed to start`、`login panel failed to connect`。**这三条恰恰是最要命的**（整条通道挂掉）。为统一走向，reporter 改为**每 ctx 一个**（`WeakMap`），否则三个调用点会开出三个 sink 盖同一个文件。

**本仓库那个反复出现的缺陷模式，这次提前拦住了**：所有单测都自己注入 sink，因此**没有一个能观察到 `apply` 到底建没建**——与 `sessionExists`/`sessionEvents`/`cwd`/`presets`/`onUnreadableQuote` 完全同形。所以补了**真实 `apply` 启动**的集成测试：变异「不给 reporter 传 `also`」→ 失败。

**第二个变异一开始存活**：`channel stopped` 改回走 logger，测试仍全绿。补一个"通道在首次轮询前就死"的集成测试（故意不提供 `agentDefaultModel`）后，该变异被捕获。

**真机验证**（真实实例，非仅测试）：首次写入自动建目录 → 文件 `0600` → 重启后**第 8 天被删、9–15 天保留、`peer-sessions.json` 未动**。

**留档的不对称**：日志留 7 天，但**聊天记录永不删除**（`sessionPersistence` 无删除 API，见 Q41）。`/new` 只是换目录，旧会话一直累积。

### M4 收尾记录：出站文件真机验证通过（2026-10-15）

M4 最后一项此前一直记为「代码完成，待真机实测」。真机验证通过，**无代码改动**。

**为什么这次能验、上次不能**：10-14 21:39 其实已经跑过一轮（会话里有真实的 `deliverables/presented`、真实生成了 `个人信息表.xlsx`），但**结局看不出来**——`ad0ccfd`「记录成功的发送，而不只是失败」是 21:43 才提交的，比那轮晚 4 分钟。所以那次**日志里既没有成功行也没有失败行**，无法区分「发出去了」和「压根没跑」。这正是那行日志被加进来的原因，这次它兑现了价值。

**验证方式**（真实实例，非测试）：

| 环节 | 证据 |
|---|---|
| 1. 模型声明交付物 | 会话事件 `deliverables/presented`：`files[0].path = /private/tmp/wxtest/小王.xlsx` |
| 2. 文件合法 | 有效 zip/xlsx，9 个 entry，4995 字节 |
| 3. 取上传地址 → 上传密文 | 日志**无任何失败行**；`sendFileToPeer` 的 `catch` 会记下失败，沉默即四步全通 |
| 4. 发消息 | `[channel-wechat] 已发送文件: /private/tmp/wxtest/小王.xlsx → o9cq801j8x36C_4pcNTQF6aAqKIg@im.wechat` |
| 5. 用户端 | **用户确认手机微信收到该文件** |

**方法上的一个要点**：`onSent` 是在 `await sendFileToPeer(...)` **之后**调用的，所以它证明的是「整条链路走完」（HTTP 200 且 `x-encrypted-param` 非空），而不是「开始发送」。这与 Q46 里那条「失败的形状与成功无法区分」是同一类教训的反面——**这次成功的形状是可观测的**。

**证据链止于本机**：第 5 步是唯一无法在进程内自证的环节，所以它必须由人来确认。服务端的静默丢弃仍是理论上未排除的失败模式，但既有真机确认，M4 据此收敛。

### Q47（M4 收尾）：两处「文档比代码乐观」的修正，以及 `/cwd` 移入 v2

M4 真机验证通过后逐份复核 README，发现**两处描述与代码不符**。两处都不是代码缺陷，而是**文档替代码许下了没兑现的承诺**——用户装完照第一屏试就会撞墙。

**① `/cwd` 被写成已可用。** README 的功能列表写「**多工作目录**：`/cwd` 切换 = 在该目录新建会话」，而 `src/bridge/local-commands.ts:43` 对 `/cwd` 直接回「尚未实现」。这是**最外层门面**的过度承诺，比内部注释更严重。

改法：把该条改为**如实描述**——目录由 profile 的 `cwd` 配置决定、会话创建时写入且不可变，`/cwd` 已注册但未实现、**且会明确回复而不是静默失败**。后者是这个插件的一贯取舍（失败要有形状），值得在门面上就说明。

**② 提问卡被列进「不做的事（v2）」。** 两版 README 的「不做的事」都写着「提问卡（v2）」，但它**在 v1 里已经实现**：`src/bridge/cards-service.ts:193` 监听 `user-questions/request`，27 个单测 + 真循环死锁回归覆盖。计划 §Q42 专门论证过「提问卡不是 v2，是 v1 的必需项」（不认领会让整轮永久卡住）。**计划改了，README 没跟上**——与上一处的方向相反，这处是**文档比代码悲观**，同样失真。

改法：从「不做的事」移出并注明它为什么必须在 v1；M5 行与架构图同步补上提问卡。

**`/cwd` 正式移入 v2**（不再是「v1 待补」）：它要「结束当前会话 + 在新目录新建 + 让新路径跨重启持久」，等于给 `PeerSessionStore` 增加**按 peer 存 cwd** 的维度，且 `peer-map` 的 `cwd` 目前是构造期单值。收益是少数用户的多目录需求，成本是一次状态模型扩展——按「简单优先」留给 v2。设置页卡片同理（v1 客户端插件零代码），一并移入 v2。

### Q48（M7 收尾）：README 的安装指引**三条全错**，逐条实测后才写对

用户问「我该如何安装、实际使用」。此前从未有人从零装过一次——**M7 验证的是 tarball 这一条路，
而 README 教的是 `add dsh-channel-wechat`**，两者不是一回事。实测三条路：

| 方式 | 结果 | 原因 |
|---|---|---|
| `add dsh-channel-wechat`（README 原写法） | ❌ **404** | **包从未发布到 npm**（实测 `npm view` → E404）。README 的第一条指令对任何用户都不可执行 |
| `add github:...` | ⚠️ 能成，但**首次必失败** | pnpm 拒绝执行 git 依赖的构建脚本，须手工把 `allowBuilds` 键写进 profile 的 `pnpm-workspace.yaml` 再重跑 |
| `add <本地目录>` | ❌ **静默装成空包** | 生成 `link:`，而 **`link:` 不跑构建**；`lib/` 又被 gitignore，于是启动时 `failed to import`、**不加载也不崩** |
| `add <tarball>` | ✅ 干净 | `prepack` 自动构建 |

**两条被实测钉住的机制**（README 已写明）：

1. **`add` 会顺带把包写进 profile 的 `bundles`**。只进 `dependencies` 而不进 `bundles`，包装好却**永不加载**——`--dump-config` 里一行都没有，且不报错。桌面端 profile 正是被手工 `link:` 挂过，所以「装了却从不生效」。
2. **本地目录安装不等于构建**。必须先在目录里 `pnpm install && pnpm build`；否则 `lib/` 不存在，失败形状是 `failed to import` 这种**看得出来**的，但若没看启动日志就会被当成「装成功了」。

**这次的教训与 Q47 同源，但更严重**：Q47 是**文档描述**与代码不符，Q48 是**文档的核心指令压根跑不通**。
两者的根因都是**只验证了自己关心的那条路**——M7 验了 tarball，就默认 README 的 npm 指令也能用。
**「我验证过 A」不等于「我文档里写的 B 也对」。**

### Q49（M7 收官）：发布到 npm 成功，途中撞上 **staged publishing** 这道新门

用户登录 npm 并开启 2FA 后发布成功。`dsh-channel-wechat@0.1.0` 现已上线，
并**经全新 profile 从 npm 实测装好、真实启动、打印登录行**（不只是看发布回执）。

**中途两个卡点，都值得记录**：

**① 首次发布被 403 拒绝——token 缺少 2FA 能力。**
```
403 Two-factor authentication or granular access token with bypass 2fa enabled is required
```
账号当时 `two-factor auth: disabled`，而 token 是 **granular** 类型（`npm_` 前缀）却**未勾选 "Bypass 2FA"**。
npm 要求二者满足其一。用户开启 2FA 后即通过。
（附带发现：`npm token list` 对新式 granular token 返回空数组，**不能用它判断 token 是否存在**。）

**② 发布回执是 `202 Accepted`，但注册表上出现的是 `0.0.0-stage`，不是 `0.1.0`。**

这是个**新手会误判为「发错包」的现象**：npm 现在对**新包**启用
[staged publishing](https://docs.npmjs.com/staged-publishing/)——`npm publish` 先把包送进暂存区，
注册表上发一个**公开占位版本 `0.0.0-stage`**（描述字面写着 *"Temporary package placeholder for staged publishing"*），
真正的内容要**审核通过并批准**后才可见。实测时间线：

| 时刻 | 事件 |
|---|---|
| 14:16:41 | `PUT` → **202 Accepted** |
| 14:16:48 | `0.0.0-stage` 占位出现（`latest = 0.0.0-stage`） |
| 14:18:58 | **`0.1.0` 出现，`latest` 切到 `0.1.0`** |

所以「发完立刻 `npm view` 看到 0.0.0-stage」**是正常的中间态**，不是发错了。
另一个坑：本机 npm **11.13.0 没有 `stage` 子命令**，无法主动查暂存状态——
`npm view` 才是可靠的观测点。这两点已写进本记录，供下次发布参考。

**③ 真机验证（不是只看回执）**：`add dsh-channel-wechat` 装入全新隔离 profile →
`dependencies` 得到 `^0.1.0`、`bundles` **自动写入** → 包内含真实 `lib/` 四个文件 →
`--dump-config` 出现本插件两层 → 真实启动打印登录行。**M7 至此收敛。**

**④ 遗留瑕疵（如实记录）：npm 上的 README 是旧版。**
节奏错了——**先发布、后修文档**。`0.1.0` 在 22:16 发出，而修正安装指引的
`12e91de` 是 22:22（见 Q48）才提交，因此 **npm 页面上的 README 至今写着
「尚未发布到 npm，用 `github:` 安装」**——与它已经上线这件事自相矛盾
（registry 的 `readme` 字段为证）。同一版本号不可重发，只能等下一版修正。

**根因**：`prepack` 打包的是**工作区当时的内容**，不是「最后一次提交」。文档没定稿就发，
页面就会一直挂着旧说明。**教训：发布前先把文档定稿并提交。** 已写进发布 skill 的第 2、5 步（`.dsh/skills/release-workflow/SKILL.md`）。

> 已核对：**`src/` 与 `package.json` 自发布点起零变化**，只有文档变过 ——
> 所以把 tag 指向更新后的 HEAD 仍是准确的（tag 打于 `04c5bb2`）。

### Q50（0.1.0 真实使用后）：**我们把 DSH 核心包装进了 profile，分裂了运行时**

**现象**（用户真机，桌面端安装 `0.1.0` 后）：插件**加载正常**、路由**能响应**（实测对照 `200` vs 不存在的路径 `404`），但**每条微信消息都失败**，日志依次出现：

```
inbound message failed: no agent factory registered (load an agent-loop plugin)
inbound message failed: cannot create effect on inactive context
```

**排查中被推翻的三个假设**（都写下来，因为它们看起来都很像答案）：

| 假设 | 为何不成立 |
|---|---|
| 「`agent-loop` 的 6 个注入服务缺了」 | dump 出的 **1308 行**配置树里，`agent-loop` 行存在且 6 个提供者齐全 |
| 「默认模型 `deepseek-flash` 不存在」 | `agent-loop` 的 config 只是 `agents: []`，**不读默认模型**；且 GUI 自身能正常对话 = factory 在进程里是好的 |
| 「桌面端宿主 `desktop-host` 与 cli 行为不同」 | 用**完全相同的配置**在隔离环境跑 cli 版本，**能正常创建会话并回复** |

**真正的根因**（社区手册命中）：官方仓库 **issues 被关闭**（只用 Discussions），但社区维护的
[deepseek-harness-handbook](https://github.com/sandbaseai/deepseek-harness-handbook) 中
[`duplicate-core-runtime-closure`](https://github.com/sandbaseai/deepseek-harness-handbook/blob/main/docs/en/troubleshooting/duplicate-core-runtime-closure.md)
一条**精确描述**了它：

> A third-party profile dependency should own its genuinely external dependencies. Its DSH runtime
> contracts should be compatible peers resolved from the Host closure. **Installing missing core
> peers into the profile may silence the package manager while splitting runtime identity.**
> **do not add DSH core packages as profile dependencies.**

**我们的错误**：`package.json` 的 `dependencies` 里有 **`@deepseek-ai/schemastery`**（DSH 核心包），
于是 `pnpm add` 把它**实体装进 profile**。铁证 —— **同版本、不同 inode 的两份副本**：

```
3.18.4  inode 12121912  ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery
3.18.4  inode 12148791  ~/.dsh/profiles/node_modules/@deepseek-ai/schemastery   ← 官方核心闭包
```

**机制**：`cosmokit`（`cordis` 微内核的响应式底座）里有
`Symbol.for("cosmokit.volatile.write")`。插件用自己的副本 = **第二套模块图**，
于是 `ctx.effect()` 跨了两套响应式系统：Host 的 `cordis` 在实例 A 上注册 factory，
插件在实例 B 上申请 effect → `no agent factory` / `inactive context`。
**版本号一致**，所以**任何版本检查都发现不了，只有 inode 不同**。

**修复**：把 `@deepseek-ai/schemastery` 从 `dependencies` 移到 `peerDependencies`（+`devDependencies`
供本地构建），让它由 Host 闭包解析。修复后 profile 的 `node_modules/@deepseek-ai/` **为空**，
只剩真正的第三方依赖 `commander`。

**为什么 M7 没抓到**：当时验证的是「**tarball 装进全新 profile 能加载**」——
而 `schemastery` 副本在**全新 profile** 里同样会装进去，只是**没有历史会话/真实对话去触发**。
**「装得上」和「能工作」是两件事**，与本项目 Q47/Q48/Q49 是同一个模式的又一次复发。
测试缺口也一致：清单测试当时**只检查「声明的 import 都有声明」**，
**没有任何测试问过「哪些包根本不该装进 profile」**。已补
`keeps dsh runtime packages out of dependencies`（修复前失败、修复后通过，变异验证过）。

### Q51（0.1.0 真实使用后）：登录地址是**唯一不落盘**的诊断

**现象**：桌面端首次使用时，用户**看不到登录地址**，且 `~/.dsh/channel-wechat/log/` **目录根本不存在**。

**两个原因叠加**：

| 环节 | 事实 |
|---|---|
| 登录地址提示 | 走 `console.log`（`src/index.ts:201`）→ **只写终端** |
| 桌面端 | host 的 stdout 交给 Electron 主进程，**没有终端、也不写日志文件** |
| 日志文件 | **只在有账号可轮询时**才写第一条（`polling as`）→ 未登录时**正常也不创建** |

结果：**插件完全正常，用户却两眼一抹黑** —— 而 Q46 建这个日志功能的理由**恰恰就是**「桌面端 stdout 不落盘」。

**修复**：登录地址改走 `reporterFor(ctx)`，终端与日志文件**双写**。补集成测试
`writes the login address to the log file, not only to a terminal`（**无账号**状态下启动真实
`apply`，断言文件含完整地址与端口）—— 修复前 `condition never held`，修复后通过，变异验证过。

**顺带**：`.gitignore` 加 `*.tgz`（`npm pack` 会在仓库根留包）。

### Q52（0.1.1 真机验收）：默认模型不可用时**没有形状**，以及一条只有 stderr 才说的诊断

修完 Q50/Q51 并发布 `0.1.1` 后真机验收，又暴露两件事。

**① 默认模型指向不存在的模型 → 每条消息 400，而插件一字不报。**

`desktop` profile **没有** `agent-default-model` 覆盖，于是用 base 的默认
`deepseek-official / deepseek-flash`；而该 profile 的 `llm-deepseek` 只提供
`deepseek-v4.1-flash` 与 `deepseek-v4-pro`。结果每条消息：

```
turn/end | {"reason":{"kind":"error","error":{"message":"unknown provider for model deepseek-flash",
           "code":"INVALID_REQUEST","status":400}}}
```

对照 `web` profile（**能用**）：它有显式覆盖，`model: deepseek-v4.1-flash`。**差别就是这一行配置。**

**这是我这轮排查中的一次判断失误，值得记录**：我早先提出「默认模型可能不对」，随后**自己推翻了**，
理由是「`agent-loop` 的 config 只有 `agents: []`，不读默认模型」——**这个理由是对的，结论却是错的**：
不读它的是 `agent-loop`，**读它的是本插件自己**（`modelSelectionOf` → `ctx.agentDefaultModel.currentSelection()`），
而插件的 `cwd` 是必填、模型**不是**。**我把「谁读它」搞错了，就否掉了正确的方向。**

**② 一条 `name mismatch` 诊断只在 stderr，桌面端永远看不到。**

用户按我的指引加覆盖时，我把包名写成 `@deepseek-ai/agent-default-model`（漏了 `dsh-`）。
DSH 的 loader 其实**说得非常清楚**：

```
dsh: [.../cordis.patch.yml] patch: name mismatch for "agent-default-model"
     (expected "@deepseek-ai/dsh-agent-default-model", got "@deepseek-ai/agent-default-model"), skipping
```

但这行走 **stderr**，而**桌面端不落盘 stderr**（Q46 那条日志功能覆盖的只是**插件自己**的输出）。
**同一类盲区第三次出现**：Q50 的 `skipping profile bundle`、这里的 `name mismatch`，都只写 stderr。

**结论与后续（待做）**：插件应在**启动时校验模型可用性**，不可用就明确报错——
理由与 `cwd` 完全一致（计划 §5.5：`cwd` 必填是「宁可启动失败，也不要静默把会话写进一个改不了的目录」）。
**一个不可用的模型和缺失的 `cwd` 是同一类错误，现在只有前者没有形状。**
未在 `0.1.1` 做，因为它需要先确认「可用模型」从哪个服务读最可靠，属独立改动。

## 3. 架构

```
微信用户 ⇄ 腾讯 iLink ⇄ dsh-channel-wechat（DSH 进程内）
                          │
        ┌─────────────────┴──────────────────┐
        │ wechat/  协议层（移植官方）          │
        │   api  auth  cdn  media  types      │
        ├─────────────────────────────────────┤
        │ channel/ 通道层（全新写）            │
        │   monitor（长轮询，独立循环）        │
        │   queue（每用户串行）                │
        │   outbound（分段/发送/typing）       │
        ├─────────────────────────────────────┤
        │ bridge/  桥接层（全新写）            │
        │   peer-map   userId → sessionId      │
        │   dispatcher 消息 → agent.followup   │
        │   reply      事件 → 微信             │
        │   commands   ctx.commands + 自管     │
        │   cards      审批卡（waterfall）     │
        ├─────────────────────────────────────┤
        │ client/  客户端半边（slot 设置页卡片）│
        └─────────────────────────────────────┘
                    │
          ctx.agents / ctx.commands / ctx.credentials
          ctx.attachments / ctx.on('session/event')
```

**三条分层纪律**（Q26「纯粹」的落地）：
1. `wechat/` **不 import 任何 `@deepseek-ai/*`**（纯协议）
2. `bridge/` 只用**官方文档化的 API**，不用 `ctx.get()` 拿未声明服务
3. 所有 `@deepseek-ai/*` 用 **peer + dev** 声明（含预发布段）

## 4. 包结构

```
dsh-channel-wechat/
├─ package.json          # dsh.bundle + dsh.client + exports
├─ cordis.patch.yml      # 只注册 Host 半边
├─ tsconfig.json
├─ tsdown.config.ts      # 方案 A：复刻 clientBundle（recon/13）
├─ LICENSE               # MIT + Tencent 版权声明
├─ README.md / README.zh.md
├─ THIRD_PARTY_NOTICES.md
├─ src/
│  ├─ index.ts           # 主插件：name/inject/Config/apply
│  ├─ config.ts          # Schemastery Config
│  ├─ startup.ts         # cmdline provider（login/logout/status）
│  ├─ wechat/            # ── 协议层（移植，标注来源）──
│  │  ├─ types.ts        api.ts        auth.ts
│  │  ├─ cdn.ts          media.ts      crypto.ts
│  │  └─ session-guard.ts
│  ├─ channel/           # ── 通道层（全新）──
│  │  ├─ monitor.ts      # 长轮询独立循环
│  │  ├─ queue.ts        # 每用户串行队列
│  │  ├─ outbound.ts     # 分段 + 发送 + typing
│  │  └─ errors.ts
│  ├─ bridge/            # ── 桥接层（全新）──
│  │  ├─ peer-map.ts     dispatcher.ts  reply.ts
│  │  ├─ commands.ts     cards.ts       workspaces.ts
│  │  └─ source.ts       # MessageSourceMap 不需（用 'user'）
│  └─ client/            # ── 客户端半边 ──
│     ├─ index.ts        # slot 注册
│     └─ Panel.tsx
├─ tests/
│  ├─ unit/              # 协议层单测（移植官方）
│  └─ integration/       # 真组合测试（boot cordis.yml）
└─ docs/
   ├─ recon/             # 13 份侦察报告
   └─ plan-v1.md         # 本文件
```

## 5. 关键实现要点（全部有侦察依据）

### 5.1 入站注入
```ts
agent.followup(createUserMessage({
  content: parts,                    // 经 admitPromptContent 转 durable ref
  source: { kind: 'user' },
}))
```
- 图片/文件：`ctx.attachments.admitPromptContent([...])` → **裸 base64 进不了消息**
- `attachments` 未挂载时 `ctx.get('attachments')` 返回 undefined，**需判空**
- 模型不支持图片时先查 `ctx.llm.resolveModelInfo(...).inputModalities.includes('image')`

### 5.2 回复投递
```ts
ctx.on('session/event', (session, event) => { ... })   // 取 assistant/message
```
- **`whenIdle()` 是 whole-agent 静默**，必须先等 inbox 回执界定区间
- **不用** `turnOutline`（120 字符预览）、**不用** `finalAssistantOutput`（越界）、**不用** deprecated 的 `snapshotEvents()`
- 出站**必须自建队列**（微信侧无补投/重放）

### 5.3 生命周期
- `Map<peerId, AgentHandle>`，必要时 dispose
- followup 前校验 `ctx.agents.get(id) === agent`（**已 dispose 的 agent 上 followup 静默丢消息**）
- `resume` 会抛错 → 先 `sessionQuery.observeSession()` 探测存在性

### 5.4 并发（Q36）
```
monitor: while(true) { await getUpdates → 入队 }     ← 独立循环，不阻塞
queue:   每用户串行消费 → agent.followup → whenIdle
/stop:   agent.cancel()
```

### 5.5 工作目录（Q38）
- 默认目录来自 `Config.cwd`
- `/cwd <path>` = **结束当前会话、在该目录新建会话**（cwd 不可变）
- v1 **不挂 `workspaceRegistry`**（它只在 web-app bundle），会话落 GUI「未分组」桶；v2 再接

### 5.6 审批卡（Q24/Q33）
```ts
ctx.on('approval/request', handler, { prepend: true })   // 必须 prepend + 不带 tag
```
- **必须自己造**：卡片 id、竞速、回执、超时、渲染
- 审批卡与提问卡**都在 v1**（见 Q42）：只做审批、靠「防御」挡提问，实测会让整轮永久卡住
- `forkGuiCardSignal` 是未文档化依赖 → **故意不用**；`cards: both` 的 GUI 卡滞留是已知代价
- **`prepend: true` 强制**：否则 GUI 抢走后本通道静默失效（无任何报错）
- **卡片回复必须绕过 peer 队列**：提问的那一轮正持有该队列，否则死锁

### 5.7 客户端面板（Q32/Q39）
- `dsh.client = { platform: 'web', inject: [...] }` + `exports["./client"]`
- **自动同时覆盖 web 与桌面端**（桌面 = Electron 壳 + 完整 Web 应用）
- 用 `ctx.slots.register('settings.section', ...)` 复用 DSH UI
- 构建走**方案 A**（tsdown 复刻），必须含 `chunkFileNames` + CSS loader
- **自建构建期纯度检查**（仓库外没有官方那道门）

### 5.8 协议层移植义务
- 每个移植文件头部：`Adapted from @tencent-weixin/openclaw-weixin (MIT, Copyright (C) 2026 Tencent)`
- 仓库根 `LICENSE` 含 Tencent MIT 全文
- `THIRD_PARTY_NOTICES.md` 记录来源

## 6. 里程碑（垂直切片）

| 阶段 | 交付 | 验收 |
|---|---|---|
| **M0 骨架** ✅ | 包结构 + 插件骨架 + 真组合测试跑通 | ~~日志有插件名~~ → **cordis fiber 达到 ACTIVE**（见下方修订） |
| **M1 登录** ⚠️ | 协议移植改为全新写（见下方修订）+ `startup.ts` + 凭证进 `ctx.credentials` | ~~`dsh <profile> login` 扫码成功~~ → **改为 M6 面板登录**（见下方修订），CLI 仅在不挂 web app 的 profile 可用 |
| **M2 文本端到端** ✅ | `api` 消息方法 + monitor + peer-map + dispatcher + reply + runtime | 微信发「hi」→ DSH 回复到达 |
| **M3 命令** ✅ | `ctx.commands` 透传 + 6 个自管命令 + `/stop` | `/goal off` 有原生回执；`/stop` 能中断正在跑的任务 |
| **M4 媒体** ✅ | S0 加密/CDN ✅ S1 入站图片 ✅ S2 出站文件 ✅（只发 `present` 声明的）S4 引用 ✅（内联可用；`svr_id` 分支**只记录不修**，见 Q45） | ~~发图能理解~~ ✅ 真机已验证；~~产出文件能收到~~ ✅ **真机已验证（2026-10-15）**；引用**真机已验证**（引 Agent ✅ / 引自己 ⚠️） |
| **M5 卡片** ✅ | waterfall 监听 + 卡片渲染/解析 + 超时 + 队列旁路 | 微信能批准/拒绝/回答提问；`cards:wechat` 时 GUI 不重复弹卡 |
| **M6 面板** 🔶 | S1 二维码 ✅ S2 登录会话 ✅ S3 页面与 API ✅ S4 扫码即启动 ✅ S5 接线 ✅；设置页卡片待做 | web 端登录页可用（已实测）；设置页卡片待做 |
| **M7 发布** ✅ | 双语 README ✅ LICENSE ✅ 致谢 ✅ 可发布 ✅（`0.1.0`/去 `private`/`prepack`/`files`/`exports` 修正）**已发布到 npm** ✅ | `dsh plugin add dsh-channel-wechat` 一条命令装好 —— **已从 npm 实测装好并加载**（见 Q49） |

**M2 是第一个真实闭环**，也是「集成契约是否正确」的验证点——协议层移植量最大，但风险最高的是全新写的集成层。

### M3 完成记录（2026-10-09）

拆成 5 次提交：S1 命令路由 → S2 六个自管命令 → S3 旁路队列 → S4 harness 透传
→ S5 运行时接线。

**测试**：225 个，全部经变异验证。

**验收两条均以真组合覆盖**（`channel-real-loop.spec.ts`）：
- `/stop` 打断正在跑的任务：挂起模型（10s）经 `agent.cancel` 提前结束，断言**墙钟时间**
- `/goal` 类原生命令有回执：真 `ctx.commands` 上注册命令，回执经微信发出

**★ 计划阶段就预判的错误，实测中确实发生了**：`/stop` 从同一 peer 发来时会排在
正在跑的任务**后面**，永远无法打断。探针先证实（`turn1-start -> turn1-end ->
STOP-executed`），因此命令改为**旁路队列**——但 `/stop` 本身仍要能追上「会话正在
创建」的窗口，见下。

**四个被真组合测试抓出的缺陷**（单元测试与桩注册表都看不见）：

| 缺陷 | 表现 |
|---|---|
| 会话创建竞态 | `/stop` 赶在 session 创建完成前到达 → 报告「没有正在运行的任务」而任务在跑 |
| 并发创建同一 session | 两条消息同时到达会各自 create 同一 id，registry 拒绝 |
| 原生命令解析时无 agent | 命令在会话存在前路由 → 一律返回「未知命令」 |
| `settled()` 不等命令 | 命令仍在下发回复时评测已返回 → 回复丢失 |

**一处诚实记录的等价变异**：cursor 的原子写（临时文件 + rename）**无测试能观察**
其与直写的差别（除非注入写中崩溃），已在测试中标注。

### M2 完成记录（2026-10-09）

拆成 7 次提交：S1 入站解析 → S2 会话映射 → S3 注入 → S4 出站队列 → S5 长轮询 →
S6 真组合接线 → 收口（API 消息方法 + 运行时 + cursor 持久化）。

**测试**：180 个（139 单元 + 41 集成），全部经变异验证。

**真组合验证**：`channel-real-loop.spec.ts` 挂载**真实 agent loop** + 脚本化模型适配器，
跑通「轮询 → 解析 → 会话 → 真实模型轮次 → committed `assistant/message` → 回复 → 微信发送」。
这是「接线正确」与「接线到 registry 形状的东西」的区别。

**四个被测试抓出的真实缺陷**（都是单元测试看不见的）：

| 缺陷 | 表现 |
|---|---|
| 无人订阅 `session/event` | 组合测试直接调 handler 所以通过，生产路径**回复根本没有出口** |
| 不等待轮次结束 | 回复读自 committed 事件，事件在轮次 settle 前不存在 → 消息「已处理」但无回复 |
| 会话继承环境 provider/model | 通道会跑在用户碰巧配置的模型上，而非通道自己的 |
| `ctx.agents` 未声明却使用 | 未挂载时静默拿到 undefined，轮询启动但无处投递 |

**一处诚实记录的等价变异**：cursor 的临时文件 + rename 是原子写，但**没有测试能观察
到它与直写的差别**（除非注入写中崩溃）。因此测试现在只声称覆盖「清理」，不再暗示
覆盖原子性。

### M1 完成记录（2026-10-09）

**与原计划的两处偏差**：

1. **协议层不是「移植」而是「照协议文档重写」**。官方 `login-qr.ts` 有 497 行且**无测试**，
   与其搬一份无基线的代码，不如按 `protocol_zh_CN.md` 的状态表重写——结果是纯 reducer
   （8 状态可脱离网络验证）+ 编排层。移植的收益在 M4 的 CDN/媒体加密，那里才有值得搬的算法。
2. **拆成 6 个 seam、6 次提交**：S1 HTTP 层 → S2 状态机 → S3 编排 → S4 凭证 → S5 CLI 入口
   → S6 动作执行 → 收口接线。

**测试**：78 个（63 单元 + 15 集成），全部经变异验证。

**三条被测试抓出的真实缺陷**（非测试问题）：

| 缺陷 | 表现 |
|---|---|
| `withRefreshedQr(...).state` | 刷新二维码后 state 变 `undefined`，登录静默卡死 |
| payload 含 `undefined` | provider 拒绝写入（JSON 不可表示），仅带 token 的确认**完全无法持久化** |
| 子路径导出声明了不存在的 dts | `tsc` 对消费者退化为 `any` |

**一条等价变异（已记录，未粉饰）**：去掉 `none` 动作的提前返回不改变行为——动作执行器
内部对 `none` 也早返回。该 guard 保留是为意图表达与 M2 的挂载点，**当前不承重**。

### M0 完成后的验收标准修订（2026-10-09）

原 M0 验收写作「日志有插件名」，**实测该验收不可行**，两处硬阻断：

1. `packages/bundle/web-app/src/index.ts:288` 把 `auditStartupEntries` 的 warn sink 传成 `() => {}`，
   所以 `pending (waiting for service: X)` 之类诊断**不出现在 stderr**；
2. named-logger 在该表面**没有 console exporter**：`info`/`warn`/`error` 三级均不输出。

→ **已挂载与未挂载的插件产生相同的启动输出。** 故验收改为**进程内断言 `fiber.state === ACTIVE(2)`**，
与 DSH 自身 `app-boot` 测试的做法一致。M0 的 3 个 seam 全部通过且经变异验证。

**同时新增 3 条后续里程碑必须遵守的环境事实**：

- `dsh <profile> <app>` 写法非法（`too many arguments`）；正确形式是 `dsh <profile> [app-args]`，
  app 由 profile 的 `dsh.profile.bundles` 决定；
- `DSH_HOME` 可重定向 → 所有集成测试用隔离 home，不碰用户 profile；
- 本机 npm/pnpm 默认 cache 不可写（EPERM）→ 用 `pnpm-workspace.yaml` 的 `storeDir: .pnpm-store`。
  ⚠️ **不是** `.npmrc` 的 `store-dir`——pnpm 11 静默忽略后者（实测：改成绝对路径/任意值，
  `pnpm store path` 均不变），早期记录此处有误，已更正。

### ★ M1 验收标准修订（2026-10-11）

**原验收「`dsh <profile> login` 扫码成功」在挂了 web app 的 profile 上不可能成立。**

机制（`app.asar` 内源码 + 真实 launcher 实测）：`dsh-cmdline` 把**同一份完整参数列表**
交给 profile 里**每个** app，各自解析。`dsh-web-app/lib/startup.js` 的 program **只声明
flag、没有 positional**，commander 因此报 `too many arguments`，`parseCmdline` 捕获后
`exit(1)`——**boot 在到达本插件前结束**。

穷举实测（均失败）：`login`、`-- login`、`--json`（本插件自己的 flag）、`--wechat-login`、
`wechat-login`；**把本插件的 bundle 排到 web-app 之前也无用**（不是顺序问题）。
官方 5 个解析 cmdline 的 app 中**没有一个**开 `allowUnknownOption`，只有 `dsh-headless`
声明 positional——即 DSH **刻意**如此设计。

两个同类插件都不走这条路：`dsh-wechat` **无 CLI**（只做 `webServer` HTTP 页面 + 设置页）；
`dsh-weixin` 的 CLI 是**独立 bin**（`dsh-weixin-login`），README 标注「可选」，面板才是首选。

→ **修订**：登录入口改为 **M6 面板**；CLI 保留但在挂 web app 的 profile 上不可用，
README 需写明原因。`startup.ts` 仍保留 `allowUnknownOption()`/`allowExcessArguments()`：
不修则**桌面端整个 app 起不来**（宿主 `ctx.effect` 落在已失效 context →
`DesktopHostFatalError: cannot create effect on inactive context`）。

### ★ 面板安全边界（实测，2026-10-11）

`ctx.webServer.register()` 注册的路由**不受 token 保护**：

| 路由 | 无 cookie |
|---|---|
| `/`（GUI 自身） | **401** |
| 插件注册的裸路由 | **200，直出内容** |

这正是 recon/07 记录 `dsh-weixin`「没有鉴权」的机制根源——**不是作者疏忽，是该 seam
本身不带鉴权**；`dsh-wechat` 的 `/wechat/qr`、`/wechat/status` 同样裸奔。

**带鉴权的替代 seam**：`ctx.connection.fetch.register({ path: '/api/...', methods: [...],
requestBody: 'buffered', fetch })`——必须挂在 `/api/*` 下。实测无 cookie **401**、
带 cookie **200**（复用 GUI 已有的 token+cookie 墙，无需自写鉴权）。
故本插件全部面板路由走 `/api/channel-wechat/*`。

### M6 完成记录（2026-10-11）

`start` 分 5 次提交：S1 二维码 → S2 登录会话 → S3 页面与 API → S4 扫码即启动 → S5 接线。

**测试**：273 个，全部经变异验证（4 个变异记录为等价变异，见提交信息）。

**在真实隔离 web profile 上实测发现并修复 2 个单测看不见的缺陷**：

| 缺陷 | 表现 |
|---|---|
| **`connection` 在 `apply` 时不存在** | 路由注册到 `undefined`，页面全部 404；而无 cookie 仍正确返回 401，所以**看起来是好的** |
| **URL 只打印相对路径** | 无 scheme/host/port，用户无法粘贴；`--port 0` 时端口只有服务知道 |

第一个缺陷与 `dsh-wechat` 源码注释里记录的是同一个问题。修复用**条件注入**
（`ctx.inject(['connection'], ...)`）而非写进 `inject`——后者会在 headless profile 上
把整个插件**挂起**（静默失效）。

**第二个缺陷的测试教训**：集成测试最初**先提供 `connection` 再挂载插件**，
因此该变异「全部通过」；改成**后提供**（真实 profile 的顺序）后，同一变异
**3 个测试全失败**——测试的时序与真实环境不一致时，它会替缺陷打掩护。

**同时记录的技术债**：`await ctx.inject(...)` 的 `await` **无测试覆盖**
（去掉后测试仍全过），保留是为显式表达顺序，而非有可观测差异。

### M7 完成记录（2026-10-14）

分两批：先记录 Q45 的两处**只记录不修复**项，再做发布准备。

**`npm pack` 直接抓出 3 个缺陷** —— 它们在开发机上**全部不可见**，因为本地
`node_modules` 是 hoisted 的、且 `lib/` 一直在原地：

| # | 缺陷 | 证据 | 修法 |
|---|---|---|---|
| **A** | `THIRD_PARTY_NOTICES.md` **不在 tarball 里** | npm 只自动收录 README/LICENSE | 加进 `files[]` |
| **B** | 两个裸 import **未声明** | `dsh-home-paths`/`schemastery` 既非 dep 也非 peer，却因 hoisted 而能解析 | 按官方约定：`home-paths` → peer+dev，`schemastery` → dependencies |
| **C** | **干净 checkout 发布 = 空包** | 实测：无 `prepack` 时 tarball 只有 **4 文件 / 10.1 kB / 零代码**，而 `npm publish` 会报成功 | 加 `prepack: tsdown` |

**顺带修正的第四个缺陷（同源）**：`exports["./startup"].types` 指向 `./src/startup.ts`，
而 `src/` 不在 `files[]` —— 声明在开发机上能解析、安装后**静默退化为 `any`**。
改为 `dts: true` 产出 `lib/startup.d.ts` 并指向它。

**修法上的一个自我纠正**：最初写的测试断言「`files[]` 里的路径不得被 `.gitignore` 忽略」。
**这个不变量是错的** —— 构建产物本来就该 gitignore；顺着它修等于把生成代码提交进仓库。
真正的不变量是「`exports` 指向的路径必须在 `files[]` 里」，测试已改为这一条。

**测试**：513 个（41 文件）全过，`tsc --noEmit` 干净。4 个新断言逐一变异验证：
删依赖声明、`types` 指回 `src/`、删 `prepack`、把 `prepack` 换成不构建的命令 —— **全部被捕获**。

**端到端验收（不是只看 `npm pack` 输出）**：真实 tarball → `dsh plugin add` 装入
**全新隔离 profile** → `--dump-config` 显示本插件两层 → 真实启动，插件打印出自己的
登录行（且确认那行来自 `profiles/tarcheck/node_modules/` 里解出的包，不是本地 checkout）。

**版本与发布**：`0.0.0`→`0.1.0`，去掉 `private: true`，补 `repository`/`homepage`/`bugs`/`keywords`。
README 按用户裁定做成 **中文 `README.md` + 英文 `README.en.md`**（非 DSH 官方的
`README.md`+`README.zh.md` 约定），并修正了过期的状态行。**未推送 npm** —— 本轮只做
「准备好 + 验证过」。

**（2026-10-15 补记）已发布。** 当日用户登录 npm 并开启 2FA，`0.1.0` 上线官方源，
并已从 npm 实测安装加载。发布过程中撞上的 staged publishing 门与 token 2FA 要求见 Q49。

## 7. 已知风险与技术债

| 风险 | 说明 | 对策 |
|---|---|---|
| **`forkGuiCardSignal` 未文档化** | 依赖 `req` 共享可变 + GUI 用 `req.signal` 当展示寿命 | 标注技术债；加「微信答→GUI 卡消失」回归测试 |
| **`prepend: true` 漏了静默失败** | 不加则永远轮不到，无报错 | 单测断言 handler 被调用 |
| **`kind:'user'` 语义** | 微信消息继承人类授权（用户已接受） | 若接群聊/不可信来源，改 declare-merge 自建 kind |
| **构建纯度门在仓库外不可用** | 漏检 → 浏览器运行时报错 | 自建构建期检查脚本 |
| **`errcode -14` 未实测** | 会话过期行为需真机验证 | M2 后用测试号实测 |
| **群体无依据** | 协议未定义 | 已划掉，不做 |
| **主动推送需历史会话** | `context_token` 只来自入站 | README 写明；v2 实现 |
| **微信侧无补投** | 发送失败即丢 | 自建出站队列 |

## 8. 不做的事（明确边界）

- ❌ 群聊（协议无依据，recon/10）
- ❌ 多账号运行期（v1 单账号，数据结构预留）
- ❌ 消息去重 / 发送节流（Q35 对齐官方）
- ❌ 主动推送（v2，接口预留）
- ❌ 独立 HTTP 面板（用客户端插件替代）
- ❌ 自建权限体系（Q1）
- ❌ `/cwd` 与 `/reconnect`（v1 仅注册并明确回报「尚未实现」，见 Q47）
- ❌ 设置页卡片（v1 无客户端插件，v2 再做，见 Q47）

> **提问卡不在此列**：它在 v1 已实现（见 Q42/Q47）——不认领 `ask_user_question` 会让整轮永久卡住。

## 9. v2 候选

v1 的里程碑（M0–M7）已全部收敛，剩余项都属**新增能力**而非补完，统一列入 v2：

| 项 | 为什么推后 |
|---|---|
| **`/cwd`** | 要按 peer 持久化 cwd，是对现有状态模型的一次扩展（Q47） |
| **设置页卡片** | v1 客户端插件零代码，需从零搭客户端构建管线（Q47） |
| **`svr_id` 引用还原** | 要自建消息缓存，且救不了历史消息（Q45①） |
| **`message_id` 精度** | 只在成为查表 key 后才有真实后果，届时与引用缓存一起修（Q45②） |
| **主动推送** | 接口已预留，需历史 `context_token`（Q10） |
| **`errcode -14` 行为** | 会话过期需真机复现（§7） |
| **`/reconnect`** | 需在当前进程内重建长轮询连接 |

---

## 附：许可与致谢

- 协议规范与部分实现来自腾讯 [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)（MIT）
- 工程实践参考 `wechat-claude-code`（MIT）
- 本插件许可：**MIT**
