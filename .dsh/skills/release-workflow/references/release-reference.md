# 发布参考与历史陷阱

本文件只保留主流程需要的事实；完整历史证据仍在仓库的 `docs/release.md`。

## 版本

版本格式为 `<DSH 主>.<DSH 次>.<本插件补丁>`，不追 DSH 的 patch 或 rc 编号：

- 本插件自身修复或功能 → patch +1。
- DSH 主次代次变化 → 跟随主次，补丁归零。
- 兼容性下界以 `package.json.engines.dsh` 为准，不凭版本号猜测。

## npm

发布必须使用官方 registry：

```bash
npm config set registry https://registry.npmjs.org
npm whoami
npm publish --dry-run
npm publish
```

账号需要 2FA，或使用允许绕过 2FA 的 granular token。发布返回 `202`、出现 staged 占位或返回 `409 Cannot publish over previously staged version` 时，都先视为已上传、等待传播；不要重复发布或换版本号重发。

确认：

```bash
npm view dsh-channel-wechat version dist-tags
```

## 包内容

`prepack` 会执行构建。发布前确认 `lib/index.js`、`lib/index.d.ts`、`lib/client.js`、两个 README、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`cordis.patch.yml` 和 `package.json` 都在 tarball 中。

## tag 与远端

`npm version` 会创建版本提交和 `v<version>` tag；发布后分别推送提交和 tag。GitHub Release 只在 npm 版本已公开、tag 已存在后创建。

## 安装验证

在临时 `DSH_HOME` 中安装精确版本，确认依赖、`dsh.profile.bundles`、`lib/` 和实际启动加载都成功。安装成功但 bundle 缺失，或本地 `link:` 没有 `lib/`，都不能算发布成功。
