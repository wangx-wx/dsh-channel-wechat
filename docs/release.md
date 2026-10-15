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

**版本号规则**：npm **不允许重复发布同一版本号**。改动无论大小，
发布前都要 `npm version patch|minor|major` 递增并提交。

```bash
# 例如升到 0.1.1（会改 package.json 并打 git tag）
npm version patch -m "Release %s"
```

**先干跑一遍，看清会发出去什么**（`prepack` 会自动构建，所以 `lib/` 必然在内）：

```bash
npm publish --dry-run
```

检查清单：

| 项 | 期望 |
|---|---|
| `lib/` 四个文件 | 必须在（`prepack: tsdown` 保证） |
| `LICENSE` | 在 |
| `THIRD_PARTY_NOTICES.md` | 在（MIT 署名义务） |
| `cordis.patch.yml` | 在（bundle 层入口） |
| 文件数 | 约 10 个 |
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
+ dsh-channel-wechat ^0.1.0
Packages: +5
reused 5, downloaded 0        ← 一个包都没下载
```

**正确做法：先移除，再装上带版本号的目标**：

```bash
# 必须先完全退出桌面端（profile 被 Electron 独占）
dsh plugin --profile desktop remove dsh-channel-wechat
dsh plugin --profile desktop add dsh-channel-wechat@0.1.1
```

| 要点 | 原因 |
|---|---|
| **写 `@<版本>`** | 只写包名 → 已被现有范围满足 → **什么都不做**（还报成功） |
| **先 `remove`** | 清掉旧 `dependencies` 与它带进 profile 的实体依赖；否则可能与新版本共存 |
| **GUI 装不了特定版本** | 安装框只接受包名，写不了 `@0.1.1`；要精确版本走命令行 |

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
| 包内有真代码 | `node_modules/dsh-channel-wechat/lib/` 有 4 个文件 |
| 配置树认到它 | `DSH_HOME=/tmp/npmverify dsh --profile v --dump-config \| grep channel-wechat` |
| **真的能加载** | 启动后日志打印 `[channel-wechat] 微信登录：…` |

最后一条最关键——**只是装好不等于能加载**（见下方「两个历史陷阱」）。

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
