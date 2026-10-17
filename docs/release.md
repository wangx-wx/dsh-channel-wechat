# 发布流程

本文件记录把本包发布到 npm 的**实际操作步骤**，供后续版本发布直接照做。
内容来自 2026-10-15 发布 `0.1.0` 的实测过程，不是凭文档推测。

---

## 一、前置：源与登录

日常开发用的是**镜像源**（只读、快）；**发布必须用官方源**。

```bash
# 1. 看当前源
npm config get registry

# 2. 切到官方源（发布用）
npm config set registry https://registry.npmjs.org

# 3. 确认已登录（未登录则 npm adduser）
npm whoami
```

**关键前提：账号必须已启用 2FA。** 没有 2FA 会被直接拒绝：

```
403 Two-factor authentication or granular access token with bypass 2fa enabled is required
```

两种满足方式，**满足其一**即可：

| 方式 | 说明 |
|---|---|
| 账号开启 **2FA** | 发布时提示输入一次性验证码（推荐） |
| granular token 勾选 **"Bypass 2FA"** | 适合 CI；注意 npm 正在收紧该选项，且新版 npm 会告警 |

> ⚠️ **不能靠 `npm token list` 判断 token 是否有效**——它对新式 granular token
> 返回**空数组**，看起来像「没有 token」。以 `npm whoami` 为准。

---

## 二、发布前检查

```bash
# 1. 工作区干净、与远端同步
git status --short
git log --oneline -1
git rev-list --count origin/main..HEAD     # 应为 0

# 2. 测试与类型检查
pnpm test:all
pnpm typecheck

# 3. 确认版本号（每次发布必须递增）
node -p "require('./package.json').version"
```

## 版本号规则：主次跟随 DSH，补丁号全归我们

**`<DSH 主>.<DSH 次>.<我们的补丁号>`，不带 `rc`/`alpha` 等预发布标记。**

| 场景 | 版本号动作 |
|---|---|
| 修 bug / 加功能，DSH 主次版本不变 | **补丁号 +1**：`0.2.1` → `0.2.2` |
| DSH 发了新的次版本（0.2.x → 0.3.0） | 主次跟随、补丁归零：→ `0.3.0` |
| DSH 发了新的主版本 | 同上：→ `1.0.0` |

关键一条：**`0.2.x` 里的 `x` 完全归我们，不追 DSH 的补丁号。**
DSH 发 `0.2.2` 时我们**不跟着改号**，仍是 `0.2.x`；只有我们自己有改动才 +1。

- 同一个 DSH 次版本下会有 `0.2.1`、`0.2.2`、`0.2.3`… 各自对应本插件的第 1、2、3 次改动。
- 看到 `0.2.y` 就知道「配 DSH 0.2 那一代」；看到 `0.3.z` 就知道「配 DSH 0.3 那一代」。
- **不追 DSH 的预发布号**。DSH 的 `0.2.1-rc.1`、`0.2.1-alpha.5` 对我们都属于「0.2 那一代」。
  理由：DSH 大约 1–5 天一个预发布版，跟着编号会产出大量**内容为空**的版本。

> **为什么不用四段号**（`0.2.1.1`）：那不是合法 semver，`npm publish` 直接拒绝。
> 实测：`0.2.1.1` 非法；`0.2.1-1` 合法但属**预发布**（npm 不会更新 `latest` tag，用户装不到）；
> `0.2.1+1` 合法但 build metadata **不参与排序**，等于没加。三个数位装不下四组信息，只能取其一。

### 兼容下界由 `engines.dsh` 声明，不靠版本号猜

`package.json` 里：

```json
"engines": { "dsh": ">=0.2.0-rc.1" }
```

DSH 一旦看到 `engines.dsh`，就**只用它判定兼容性**，`@deepseek-ai/dsh-*` 的 peer 范围**不再参与**
（`packages/boot/app-boot/src/plugin-compatibility.ts:77-80`）。不满足时安装与激活会被拦下并给出原因。

**刻意不写上界。** 加了天花板（例如 `<0.3.0-0`）意味着 DSH 每发一个新次版本、本插件没重发之前，
用户就**装不上**。对一个通道插件来说，这比「在未实测版本上运行」更糟——不能用是立刻的，
而契约风险只在某些调用上。所以这里只声明**下界**，上界交给「真跑过才敢说支持」的文档。

写法上有一个坑，是实测出来的，**不要"简化"成 `^0.2.0`**：

| 写法 | 问题 |
|---|---|
| `^0.2.0` | **不包含 `0.2.0-rc.2`**。caret 挂在 release 上会排除同号预发布版，而 `0.2.0-rc.2` 正是打包的桌面端版本。 |

该下界经 `evaluatePluginCompatibility()` 实测：

```
0.1.7-rc.2     REFUSED         ← 早于下界，它没有本插件调用的那些 API
0.2.0-rc.1     COMPATIBLE
0.2.0-rc.2     COMPATIBLE      ← 打包桌面端，集成测试 84 项通过
0.2.1-rc.1     COMPATIBLE      ← 本地 checkout，集成测试 99 项通过
0.3.0-rc.1     COMPATIBLE      ← 未实测，放行
1.0.0          COMPATIBLE      ← 未实测，放行
```

**"能装"与"已验证"是两件事。** `tests/unit/manifest.spec.ts` 的 `RUNTIME_VERSIONS` 才是已验证清单：
目前 `0.2.0-rc.2` 与 `0.2.1-rc.1`。新增前先拿真实 launcher 跑一遍：

```bash
DSH_CHECKOUT=<该版本的 checkout 或 app> pnpm test:integration
```

**加版本时必须同时记下证据**（`RUNTIME_EVIDENCE`）：用了哪个 launcher、跳过几项、为什么跳过。
`manifest.spec.ts` 有一条测试强制两者一一对应——往清单里加一个没有证据的版本会**直接失败**。
理由很直接：清单里的名字长得都一样，跑过的和没跑过的一模一样，只有证据能区分。

现有记录：

| 版本 | launcher | 跳过 | 说明 |
|---|---|---|---|
| `0.2.0-rc.2` | 打包的 `DeepSeek Harness.app` | 15 | 跳过的是 `client-half-runs`，它要 checkout 的 `ui-theme` 源码；打包版不带源码，属环境限制而非版本不兼容 |
| `0.2.1-rc.1` | checkout `dsh-v0.2.1-rc.1` | 0 | 本套件能产出的最完整一次运行（99 项全过），`0.2.x` 这条线即以此为准 |

### 递增用 `npm version`

npm **不允许重复发布同一版本号**，改动无论大小都要递增并提交：

```bash
npm version patch -m "Release %s"    # 补丁号 +1（最常用）
npm version minor -m "Release %s"    # 跟随 DSH 新的次版本
```

**先干跑一遍，看清会发出去什么**（`prepack` 会自动构建，所以 `lib/` 必然在内）：

```bash
npm publish --dry-run
```

检查清单：

| 项 | 期望 |
|---|---|
| `lib/` 三个文件 | 必须在：`index.js`、`index.d.ts`、`client.js`（`prepack: tsdown` + `copy-client` 保证） |
| `LICENSE` | 在 |
| `THIRD_PARTY_NOTICES.md` | 在（MIT 署名义务） |
| `cordis.patch.yml` | 在（bundle 层入口） |
| 文件数 | **9 个**（`lib/` 3 + 两个 README + `LICENSE` + `THIRD_PARTY_NOTICES.md` + `cordis.patch.yml` + `package.json`） |
| `private: true` | **必须没有** |

---

## 三、发布

```bash
npm publish
```

成功输出形如 `+ dsh-channel-wechat@<版本>`。

### ⚠️ 首次发布新包名时：`0.0.0-stage` 是**正常的中间态**

`npm publish` 之后，注册表上会先出现一个**公开占位版本 `0.0.0-stage`**，
其描述字面写着：

```
Temporary package placeholder for staged publishing
```

**此时你的版本号还看不见。这不是发错了，也不是失败。** 真内容在审核通过后才出现。

> **诚实说明**：官方文档把 staged publishing 描述为**主动选择**的命令
> `npm stage publish`，且要求 **npm CLI 11.15.0+**。但 2026-10-15 本次发布
> 用的是 **11.13.0 + 普通 `npm publish`**，**同样出现了占位版与「Validating」状态**。
> 因此「npm 服务端现在对新包默认走这条流程」是**观察到的现象**，
> 触发条件尚未查清。**结论不变：看到 `0.0.0-stage` 就静候，不要重复发布。**

**2026-10-15 实测时间线**（`0.1.0`，新包名）：

| 时刻 | 事件 |
|---|---|
| 14:16:41 | `PUT` → **202 Accepted** |
| 14:16:48 | `0.0.0-stage` 占位出现，`latest = 0.0.0-stage` |
| 14:18:58 | **`0.1.0` 出现，`latest` 切到 `0.1.0`** |

**约 2 分钟。静候即可，不要重复发布。**

> 本机 npm 为 **11.13.0，没有 `stage` 子命令**（`npm stage publish/list/approve`
> 需要 **11.15.0+**），无法主动查暂存状态。**`npm view` 是可靠的观测点。**

### 2026-10-17 补充：**已存在的包**升级时，症状不同

发布 `0.1.3`（包已存在）时，**没有** `0.0.0-stage` 占位，而是出现了一组更容易误判的症状。
实测时间线：

| 时刻 | 事件 |
|---|---|
| 15:13:44 | `PUT` → **202 Accepted**，npm 打印 `+ dsh-channel-wechat@0.1.3` |
| 15:16 | 公开 `GET /dsh-channel-wechat` → `latest` 仍是 `0.1.2`，`0.1.3` **404** |
| 15:16 | 重试 `npm publish` → **`409 Cannot publish over previously staged version "0.1.3"`** |
| 15:22:14 | `npm stage list`（npx npm@latest）→ `No staged packages found` |
| ≈15:23 | `latest` 变为 `0.1.3`，`0.1.3` 的 **200** |

**三个反直觉之处，下次直接照此判断：**

1. **`202` + `+ name@version` 不等于已经可见。** 与 `0.1.0` 那次一样，202 是「已收下、审核/传播中」。
2. **`409 Cannot publish over previously staged version` 是「已上传成功」的证据，不是失败。**
   它说明注册表已经收下了这个版本，只是还没公开。**看到 409 就去静候，绝对不要换版本号重发。**
3. **认证 `GET /<pkg>/<version>` 会先于公开可见返回 `200`。** 这是判断「传上去了没有」最可靠的探针：
   ```bash
   # 带上 token 查单版本：200 = 已上传（可能尚未公开），404 = 确实没有
   curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
     https://registry.npmjs.org/dsh-channel-wechat/<版本>
   ```
   比 `npm view` 可靠：`npm view` 会命中本地缓存，看起来像「没发出去」。

**传播耗时**：包已存在时本次约 **9 分钟**（新包名那次约 2 分钟）。耐心即可。

> ⚠️ 排查期间我**重复执行了一次 `npm publish`**（换来那个 409）。事后看这个 409 反而成了判据，
> 但流程上它是错的——**`202` 之后只应观测，不应重发**。记此以自警。

### 怎么确认已经上线

```bash
# 应打印你的版本号与 dist-tags
npm view dsh-channel-wechat version dist-tags

# 直接查注册表（最可靠）
curl -s https://registry.npmjs.org/dsh-channel-wechat | \
  python3 -c "import sys,json;j=json.load(sys.stdin);print(list(j['versions']));print(j['dist-tags'])"
```

期望看到 `dist-tags` 的 `latest` 指向**你的新版本**（而非 `0.0.0-stage`）。

---

## 四、发布后：切回开发源

```bash
npm config set registry https://registry.npmmirror.com
```

镜像站是**只读**的（官方原话：「你可以用此代替官方版本（只读）」），
日常安装从它取更快，但**它不接受发布**。

---

## 四之二、升级已安装的 profile：**必须带版本号**

发布新版本后升级用户，`add` **不会**替你升级。`^0.1.0` 的语义是「≥0.1.0 且 <0.2.0」，
**新版本本就满足它**，于是 pnpm 判定「无需变更」→ **原样重装旧版，并报成功**：

```
$ dsh plugin --profile desktop add dsh-channel-wechat
dependencies:
+ dsh-channel-wechat ^0.1.8
Packages: +5
reused 5, downloaded 0        ← 一个包都没下载
```

**正确做法：先移除，再装上带版本号的目标**：

```bash
# 必须先完全退出桌面端（profile 被 Electron 独占）
dsh plugin --profile desktop remove dsh-channel-wechat
dsh plugin --profile desktop add dsh-channel-wechat@0.2.1
```

| 要点 | 原因 |
|---|---|
| **写 `@<版本>`** | 只写包名 → 已被现有范围满足 → **什么都不做**（还报成功） |
| **先 `remove`** | 清掉旧 `dependencies` 与它带进 profile 的实体依赖；否则可能与新版本共存 |
| **GUI 装不了特定版本** | 安装框只接受包名，写不了 `@0.2.1`；要精确版本走命令行 |
| **窗口外的版本会被拒** | 目标版本的 `engines.dsh` 不含当前运行时 → 安装被拦并给出原因，这是预期行为，不是 bug |

**跨次版本升级（如 `0.1.3` → `0.2.1`）要额外提醒用户**：`0.1.x` 与 `0.2.x` 的
profile 依赖写法相同，但按 npm 语义 0.x 的主次跳变属 breaking。同时旧版本**不带
`engines.dsh`**（走 peer 回退），新版本**带**，所以兼容性判定口径会变——升级说明里
要写清「先 remove 再装」和「装完重启」两件事。

**装完自查两项**（第二项是历史上出过真实故障的地方）：

```bash
grep '"version"' <profile>/node_modules/dsh-channel-wechat/package.json   # 应是目标版本
ls <profile>/node_modules/@deepseek-ai/                                   # 应为空
```

> 第二条的存在理由见 `plan-v1 §Q50`：第三方插件**不得把 DSH 核心包装进 profile**，
> 那会分裂运行时身份。**这个目录非空就是缺陷信号。**

---

## 五、验证「能装」（不是只看发布回执）

**发布回执不算验证。** 必须真的装一次：

```bash
# 在临时目录建一个全新隔离 profile，不碰你自己的环境
rm -rf /tmp/npmverify && mkdir -p /tmp/npmverify
cd /tmp/npmverify
DSH_HOME=/tmp/npmverify dsh plugin --profile v add dsh-channel-wechat
```

逐项确认：

| 检查 | 命令 / 期望 |
|---|---|
| 装进了依赖 | `dependencies` 出现 `"dsh-channel-wechat": "^<版本>"` |
| **自动注册 bundle** | `dsh.profile.bundles` 里出现包名 |
| 包内有真代码 | `node_modules/dsh-channel-wechat/lib/` 有 3 个文件：`index.js`、`index.d.ts`、`client.js` |
| 配置树认到它 | `DSH_HOME=/tmp/npmverify dsh --profile v --dump-config \| grep channel-wechat` |
| **真的能加载** | 启动后日志打印 `[channel-wechat] 微信登录：…` |

最后一条最关键——**只是装好不等于能加载**（见下方「两个历史陷阱」）。

> `lib/` 的文件数在 0.1.2 变了：0.1.0 / 0.1.1 是 **4 个**（多一对 `startup.js` + `startup.d.ts`），
> 0.1.2 把 startup 那行合并进主入口后是 **3 个**。数出 3 个不是装坏了；
> 真正的判别据是**能加载**（上表最后一条），不是文件个数。

清理：`rm -rf /tmp/npmverify`

---

## 六、收尾：tag 与 GitHub Release

### 6.1 打 tag

**推荐：用 `npm version` 打包 tag 一起做。** 实测它会**自动改 `package.json` + 提交 + 打 `v<版本>` tag**：

```bash
npm version patch -m "Release %s"   # minor / major 同理
```

> ⚠️ **工作区必须先干净**，否则它直接拒绝（实测报 `Git working directory not clean.`）。
> 所以顺序是：**先提交所有改动 → 再 `npm version`**。

如已有 `package.json` 的版本号（本次 `0.1.0` 就是手工改的），也可**手工补 tag**：

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0      # tag 要单独推送，git push 不带 --tags 不会推它
```

推送后确认远端已有：

```bash
git ls-remote --tags origin | grep v0.1.0
# 会看到两行：tag 对象本身 + 它指向的提交（<tag>^{}）
```

### 6.2 建 GitHub Release

本机**没有 `gh` CLI**（`command -v gh` 为空），两条路：

**方式 A：网页**（最简单）

打开 `https://github.com/<owner>/<repo>/releases/new`，选择刚推的 tag，填标题与说明。

**方式 B：API**（无 `gh` 时可用）

凭据可从 macOS 钥匙串直接取，**不必手工粘贴 token**：

```bash
tok=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep '^password=' | cut -d= -f2)
```

然后 `POST https://api.github.com/repos/<owner>/<repo>/releases`，
body 含 `tag_name` / `name` / `body` / `draft: false` / `prerelease: false`，
请求头带 `Authorization: Bearer $tok`。

> ⚠️ **`releases/latest` 未认证会被限流**（`API rate limit exceeded for <ip>`），
> **不代表 release 不存在**。验证时带上 `Authorization` 头，或改用
> `releases/tags/<tag>`。

**Release 说明值得写这些**（不只是「发布了」）：安装命令、功能列表、
**数据落在哪里**（会话 / 插件状态 / 日志三处路径）、已知问题、不做的事、许可致谢。
目标：打开页面的人**不用翻仓库就能用起来**。

---

## 七、本次发布的一个遗留瑕疵（如实记录）

`0.1.0` **先发布、后修文档**，因此 **npm 页面上的 README 是旧版**——
里面还写着「尚未发布到 npm，用 `github:` 安装」，与它自己已经上线这件事矛盾
（registry 的 `readme` 字段为证）。

**教训**：**发布前先把文档定稿并提交**。`prepack` 打包的是**工作区当时的内容**，
不是「最后一次提交」，所以文档没写完就发，npm 页面会一直挂着旧说明
（同一版本号不可重发，只能等下一版修正）。

> 当时确认过：**`src/`、`package.json` 等代码文件自发布点起零变化**，只有文档变了，
> 所以 tag 指向更新后的 HEAD 仍是准确的。


---

## 附：两个历史陷阱（已踩过，勿重蹈）

### 1. `dependencies` 有、`bundles` 没有 → 装了却永不加载

| 字段 | 含义 |
|---|---|
| `dependencies` | **下载**什么 |
| `dsh.profile.bundles` | **加载**什么 |

两者独立。只在 `dependencies` 里 → 包**装好但永不加载**：
`--dump-config` 一行都没有，**且不报错**。

`dsh plugin add` 两处都写；**手工 `link:` 只写前者**——这正是桌面端 profile
曾「装了却从不生效」的原因。

### 2. 本地目录安装 ≠ 构建

`dsh plugin add <本地目录>` 会建立 `link:`，而 **`link:` 不执行构建**。
`lib/` 是 gitignore 的，于是装出来的包**没有 `lib/`**，启动时报
`failed to import` 并**静默不加载**。

从 npm 或 tarball 安装没有这个问题（`prepack` 会自动构建）。
真要装本地目录，先在该目录 `pnpm install && pnpm build`。

---

## 附：本次发布（0.1.0）用过的事实

| 项 | 值 |
|---|---|
| 包名 | `dsh-channel-wechat`（未被占用） |
| npm 用户 | `wang.x` |
| npm CLI | 11.13.0（**无 `stage` 子命令**） |
| 发布耗时 | `PUT` → 202，约 2 分钟后 `0.1.0` 可见 |
| 包体积 | 72.1 kB（解包 231.9 kB，10 个文件） |
| git tag | `v0.1.0`（**后来补打**的 annotated tag，指向 `04c5bb2`）。发布当时没有 tag：版本号是手工改的，没走 `npm version` |
| GitHub Release | [v0.1.0](https://github.com/wangx-wx/dsh-channel-wechat/releases/tag/v0.1.0)，经 API 创建（本机无 `gh`） |
| 遗留瑕疵 | npm 页面的 README 是旧版（先发布后修文档），见 §七 |
