---
name: dsh-plugin-upgrade
description: 把本微信通道插件适配到新的 DeepSeek Harness 版本：证明集成测试真的跑在新版本上、逐项核查服务名/会话事件/slot/导入符号、判断 DSH 对插件模型的改动要不要改代码、决定要不要重发。用 /dsh-plugin-upgrade 手动触发。
disable-model-invocation: true
---

# 适配 DSH 新版本

这个插件的代码里几乎没有「版本判断」：它依赖的是**名字和签名**——
`ctx.get('credentials')`、`session/event`、`plugins.bundle.config`、
`import { parseCmdline }`。DSH 升版时，真正的工作量不在改代码，而在
**判断哪些名字还成立**，以及**确认你的测试真的测了新版本**。

后面这件事是这个 skill 存在的主要原因。已经发生过一次：集成测试报
「99 passed」，实际跑的是打包的旧版 app——因为 `tests/support/harness.ts`
在 checkout 没有 `lib/` 时会**静默**回退到 `DeepSeek Harness.app`，而
`lib/` 在 DSH 仓库里是 gitignore 的。所以：

> **不要相信绿灯，先证明绿灯是哪个版本点的。**
> `scripts/probe-dsh.sh` 会把它印出来，`--version` 对不上就退出码 1。

## 判断顺序

按「被击穿后是否会报错」排序，先查静的，再查响的。

| 层 | 失效症状 | 怎么查 |
|---|---|---|
| **服务名** `ctx.get(...)` | **静默**：返回 `undefined`，功能消失，启动照旧 | `scripts/check-contract.sh` |
| **会话事件名** `session/event` 的 type | **静默**：订阅不到，跑完一轮但什么都不回 | 同上 |
| **客户端 slot** `plugins.bundle.config` | **静默**：页面不渲染配置区，无报错 | 同上 |
| 清单字段 `engines.dsh` / `peerDependencies` | 响亮：安装被拦并给出原因 | `tests/unit/manifest.spec.ts` |
| 函数签名 | 响亮：typecheck + 集成测试立刻红 | `pnpm typecheck` |
| 打包/加载形式 | 中等：页面白屏或 bundle 不加载 | `tests/integration/client-half-*` |

**真正会伤到用户的是前三层**，因为它们是静默的。第四、五层有编译器守着，
第六层有集成测试守着。所以顺序是：先跑 `check-contract.sh`（覆盖前三层），
再跑集成测试（覆盖后三层）。

## 流程

### 1. 拿到新版本的 launcher，并证明它是新的

不要构建官方 DSH 仓库——本项目的约束是**不改官方仓库**。用 npm 装：

下面的命令都假设 cwd 是本仓库根目录。脚本内部用 `BASH_SOURCE` 定位仓库，
所以换个 cwd 也能跑，但相对路径的调用方式会失效——先 `cd` 到仓库根。

```bash
./.dsh/skills/dsh-plugin-upgrade/scripts/probe-dsh.sh <版本> \
  --sources /path/to/deepseek-harness
```

它会打印一个 checkout 形状的目录（末行），并已校验 `--version` 等于你要求的版本。
`--sources` 只用于 `client-half-runs` 那一个 suite（它要 checkout 的
`ui-theme` 源码和 react）；不给就跳过那一项——那是环境限制，不是版本不兼容，
别把它当成失败。

```bash
SHIM=$(./.dsh/skills/dsh-plugin-upgrade/scripts/probe-dsh.sh 0.2.1-rc.1 \
  --sources /path/to/deepseek-harness | tail -1)
DSH_CHECKOUT="$SHIM" pnpm test:integration
```

**要记下 `--sources` 给的是哪个 checkout 的版本**。它决定 `client-half-runs`
跑不跑，而「跳过几项」正是 `RUNTIME_EVIDENCE` 里要记的字段。

`pnpm test:integration` 会先自动 `pnpm build`（`tests/support/global-setup.ts`），
所以不必手动 build；但 `pnpm typecheck` 不会，干净 checkout 上要先 build 一次。

### 2. 逐项核查名字

```bash
./.dsh/skills/dsh-plugin-upgrade/scripts/check-contract.sh /path/to/deepseek-harness
```

名字是**从本仓库自动提取**的（`ctx.get`、`ctx.inject`、`inject` 数组、
事件字符串、slot 字符串、`import { ... } from '@deepseek-ai/*'`），
不是手写清单——手写清单在你下一次加 `ctx.get` 时就过期了，而且以同样的
静默方式过期。

MISS 不代表一定坏了：服务可能改了名、事件可能被新事件取代、slot 可能退役。
**每一条 MISS 都要去 DSH 源码里读到答案**，不要猜。

`cordis` 和 `schemastery` 在 `vendor/` 而不是 `packages/`，脚本已覆盖两处。
第一版只搜 `packages/` 时把 `Volatile` 报成 MISS，那是脚本的错，不是 DSH 的。

**一次全 MISS 先怀疑脚本，不要怀疑 DSH。** 已经踩过一次：两个源码根用
空格拼成一个字符串传给 `grep`，路径里一旦有空格就被拆成两个不存在的路径，
31 项全部报 MISS——看起来像 DSH 彻底变了，实际是脚本的分词错误。现在两个根
作为独立引号参数传入。判据是：**如果连 `credentials`、`parseCmdline` 这种
长期稳定的项也 MISS，那一定是脚本或路径的问题。**

顺带一条：`grep -r` **不跟随符号链接**。如果 checkout 路径本身是软链（或者
`packages/` 是软链），所有项都会 MISS。用真实目录，别用软链。

怀疑脚本时，先跑自检——它会用一个已知健康的树、一个已知残缺的树、一个含空格
的路径来验证脚本能不能分辨：

```bash
./.dsh/skills/dsh-plugin-upgrade/scripts/selftest.sh /path/to/deepseek-harness
```

自检本身也被变异验证过：把引号展开改回旧写法，自检会 FAIL 并退出 1。

### 3. 只读地看新版改了什么

升级指南是 DSH 自己写的破坏性变更清单，比 diff 可读得多：

```bash
cd /path/to/deepseek-harness
git diff --name-only <旧tag> <新tag> -- docs/upgrade-guide | grep 'guide\.md$'
```

数量可能很大（`0.2.0-rc.2 → 0.2.1-rc.1` 有 40 条，横跨 1477 个提交），
所以按契约面筛，别通读。实测这 40 条里只有 5 条沾到本插件的面：

```bash
git diff --name-only <旧tag> <新tag> -- docs/upgrade-guide | grep 'guide\.md$' |
while read f; do
  hit=$(grep -ohE "engines\.dsh|peerDependencies|session/event|approval/request|user-questions/request|configForms|slots|deliverables/presented|assistant/message|ctx\.get|credentials|createUserMessage|resolveDshHome|parseCmdline" "$f" | sort -u | paste -sd, -)
  [ -n "$hit" ] && echo "$f -> $hit"
done
```

`docs/upgrade-guide/<版本>/<slug>/guide.zh.md` 是中文版，直接读它。

统计层面的直觉（同一次跨版本实测）：`packages/core/session` +199/−296、
`packages/core/agent` +3/−33，而 `dsh-llm`、`dsh-cmdline`、`dsh-credentials`、
`dsh-home-paths`、`dsh-attachment` 的 `src/` **零改动**。**大版本号不等于大
工作量**——我们导入的十几个符号里，大多数所在的包根本没动。

### 4. 当 DSH 改了插件模型本身

这是最需要当心的一类：改的不是某个 API，而是「插件怎么被安装、被判定兼容、
被加载」。已经发生过一次：

- `0.2.1-alpha.3` 的 `plugin-engines-dsh`：`engines.dsh` 一旦声明就**单独决定**兼容性，
  忽略 `@deepseek-ai/dsh-*` peer；`IncompatiblePlugin.peers` 改名 `requirements`。
  我们据此把清单从 peer 判定切到 `engines.dsh` 下界（见 `docs/release.md`）。

这类变更的判据是**「谁裁定」和「在哪裁定」**，不是某个函数签名。遇到时按这个顺序查：

1. `docs/upgrade-guide/` 有没有讲插件安装/兼容/加载的条目
2. `packages/boot/app-boot/src/plugin-compatibility.ts` —— 兼容性判定逻辑本体
3. `packages/boot/plugin-manager/README.zh.md` —— 安装路径、registry、`minimumReleaseAge`
4. `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` —— 浏览器半边能注册的 slot 全集（生成物，权威）
5. `packages/core/session/src/known-event-types.ts` —— 会话事件全集的生成物（权威）

后两个文件是**自动生成的权威清单**，比翻文档可靠：slot 那一份连「这个 seat
必须由谁挂载才存在」都写在里面。

另外，运行时可以直接问宿主：`cordis_inspect_list` 列出可查询的 Inspect Provider，
`cordis_inspect_query` 能读实际的 service 方法、事件模式、plugin Config schema、
主题 token 和**活的 slot 树**。比起读源码，这是问「此刻真的有什么」的途径。

### 5. 判定要不要改代码

| 观察到 | 动作 |
|---|---|
| 某个服务名/事件名/slot 名改了 | **必改**，并补一个真实 `apply` 启动的集成测试 |
| 导入符号消失或签名变了 | **必改**，typecheck 会先报 |
| 插件安装/兼容判定规则变了 | 改清单，按新规则重算下界 |
| 我们导入的包 `src/` 零改动 + 集成测试全绿 | **不改**，只把新版本记进 `RUNTIME_VERSIONS` |

最后一行是最常见的结论，也是最容易做错的判断：**发版阈值是「实测」，
不是「DSH 发了新版」**。`engines.dsh` 是下界（`>=0.2.0-rc.1`），有意不写上界——
DSH 发 `0.2.2`、`0.3.0`、`1.0.0` 都仍然装得上，用户不会因为我们没重发就被挡住。
只有上面三条命中时才重发。

> 上界的方向感：加了天花板意味着 DSH 每发一版、我们没重发之前用户就**装不上**。
> 对一个通道插件，「立刻不能用」比「在未实测版本上跑」更糟——后者只在碰到
> 具体契约时才出问题，前者是所有人同时失效。

### 6. 记录证据

新版本进了 `RUNTIME_VERSIONS` 就必须同时进 `RUNTIME_EVIDENCE`
（`tests/unit/manifest.spec.ts`），写清**用了哪个 launcher、跳过几项、为什么跳过**。
有一条测试强制两者一一对应，加了名字没加证据会直接失败。

这一步不是官僚流程。清单里的版本名长得一模一样，跑过的和没跑过的
**在文件里无法区分**，只有证据能区分。这一次就是靠它发现了
「99 passed 其实测的是 0.2.0-rc.2」。

真实记录长这样（注意 launcher 一栏写的是**什么形状的目录**，不是版本号）：

| 版本 | launcher | 跳过 | 说明 |
|---|---|---|---|
| `0.2.0-rc.2` | 打包的 `DeepSeek Harness.app` | 15 | 跳过 `client-half-runs`，要 checkout 的 `ui-theme` 源码 |
| `0.2.1-rc.1` | npm 装的 `@deepseek-ai/dsh@0.2.1-rc.1`，套 checkout 形状 shim | 0 | 本套件能产出的最完整一次运行 |

## 常见误判

- **「集成测试全绿所以兼容」**——先确认绿灯点的版本。踩过。
- **「跳过 15 项是版本不兼容」**——先看跳过的 suite 要什么。`client-half-runs`
  要 checkout 的 `ui-theme` 源码；打包版 app 不带源码，那是环境限制。
- **「大版本要大改」**——看包级 churn。多数时候我们碰的包一行没动。
- **「DSH 发了新版所以该发版」**——发版阈值是实测结果，不是对方的版本事件。
- **「改 peer 范围能让新版装得上」**——有 `engines.dsh` 时 peer 完全不参与判定。
  改 peer 对安装准入零影响，却可能弄丢当前 `latest`。

## references

- `references/contracts.md` —— 本项目依赖的每一个契约名，出处，以及改坏后的症状。
- `references/failure-modes.md` —— 历史上踩过的坑（含 `minimumReleaseAge`、负缓存、teardown），带实测证据。

## 收尾

改动后照 `docs/release.md` 的收尾清单走。若判定不需要改代码，
**也要把新版本加进 `RUNTIME_VERSIONS`**——那是下一次升级时「上一版是好的」
的唯一依据。
