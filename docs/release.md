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

## 六、收尾

```bash
# 文档里的状态行、里程碑表、计划书同步更新
git add -A && git commit -m "Release v<版本>"
git push origin main
```

如有 `npm version` 产生的 tag，一并推送：`git push --tags`

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
| git tag | **无** —— `0.1.0` 是手工改版本号发布的，没有走 `npm version`，因此**没有对应 tag**。后续版本若用 `npm version` 会自动打 tag，记得 `git push --tags` |
