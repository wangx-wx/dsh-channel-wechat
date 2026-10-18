# 安装方式补充

README 的快速开始覆盖 npm 安装。以下是其他已支持的入口。

## Git 或 tarball

```bash
dsh plugin --profile <你的 profile> add github:wangx-wx/dsh-channel-wechat
dsh plugin --profile <你的 profile> add ./dsh-channel-wechat-0.1.0.tgz
```

Git 依赖首次安装时，pnpm 可能因构建脚本安全策略拒绝执行，并打印一条 `allowBuilds` 配置。把 pnpm 打印的完整键加入 profile 的 `pnpm-workspace.yaml` 后重试：

```yaml
allowBuilds:
  dsh-channel-wechat@<pnpm 打印的完整键>: true
```

不要直接把未构建的本地目录作为 `add` 参数：pnpm 会建立 `link:`，而 `link:` 不执行构建；本仓库的 `lib/` 被 gitignore，结果会成为没有 host 产物的空包。若必须使用本地目录，先运行 `pnpm install && pnpm build`。

`dependencies` 只表示下载什么，profile 的 `dsh.profile.bundles` 才表示加载什么。官方 `dsh plugin add` 会同时更新两处；手工 link 只更新依赖，插件可能安装成功却完全不加载。

## 插件市场

DSH 的自定义插件市场默认关闭。本仓库发布的索引是：

`https://wangx-wx.github.io/dsh-channel-wechat/market/index.json`

在 **Plugins → Experimental plugins → More → Custom plugin market** 中启用，再到 **Discover → Add index source** 粘贴 URL。索引只描述本仓库这个包，版本来自 npm；维护方式见 [docs/market/README.md](./market/README.md)。

插件页安装或升级后仍需完全退出并重开 DSH，以刷新宿主的浏览器模块图。

## 升级已安装的 profile

`add` 不会替你升级已安装的版本。`package.json` 里记录的依赖范围是 `^0.2.3`，
而新版本本就满足它，pnpm 于是判定「无需变更」，**原样重装旧版并报成功**：

```bash
dsh plugin --profile desktop add dsh-channel-wechat
# reused 5, downloaded 0   ← 一个包都没下载
```

正确做法是先移除，再装上带版本号的目标版本：

```bash
dsh plugin --profile <你的 profile> remove dsh-channel-wechat
dsh plugin --profile <你的 profile> add dsh-channel-wechat@<版本>
```

| 要点 | 原因 |
|---|---|
| 必须写 `@<版本>` | 只写包名 → 已被现有范围满足 → 什么都不做，还报成功 |
| 先 `remove` | 清掉旧 `dependencies` 与它带进 profile 的实体依赖 |
| GUI 装不了特定版本 | 安装框只接受包名；要精确版本走命令行 |
| 目标版本可能被拒 | 目标的 `engines.dsh` 不含当前运行时 → 安装被拦并说明原因，这是预期行为 |
| 装完要重启 | 宿主的浏览器模块图有永久缓存，不重启配置区不出现 |

装完自查两项（第二项是历史上出过真实故障的地方）：

```bash
grep '"version"' <profile>/node_modules/dsh-channel-wechat/package.json   # 应是目标版本
ls <profile>/node_modules/@deepseek-ai/                                   # 应为空
```

第二条非空就是缺陷信号：DSH 运行时包被装进了 profile 会分裂运行时身份，症状是每条消息都失败。

跨次版本升级（如 `0.1.3` → `0.2.x`）按 npm 语义属 breaking，升级说明里要同时写清
「先 remove 再装」和「装完重启」两件事。
