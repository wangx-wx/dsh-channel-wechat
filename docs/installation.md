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
