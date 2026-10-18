# GitHub Pages 更新

本仓库的 Pages 源目录是 `/docs`，发布地址是：

- 站点：`https://wangx-wx.github.io/dsh-channel-wechat/`
- 插件市场索引：`https://wangx-wx.github.io/dsh-channel-wechat/market/index.json`

## 更新步骤

1. 查看 `docs/index.html` 当前版本卡片、Release 链接、README 链接和文档索引。
2. 在版本发布内容中更新当前版本号、Release URL 和一条简短变更摘要；历史版本统一由 GitHub Releases 展示，不在首页复制。
3. 如果 npm 元数据或描述改变，按 [docs/market/README.md](../../../docs/market/README.md) 重新生成或校验 `docs/market/index.json`；不要手写与 npm 不一致的版本、引擎或描述。
4. 检查站点内相对链接、Release 链接、市场索引 JSON 和页面资源路径。
5. 提交并推送后等待 Pages 构建，再用 `curl` 检查站点和索引返回 200，并确认页面显示新版本。

## 边界

Pages 是发布展示层，不复制 README 全文，也不承载完整发布说明。页面只展示项目简介、当前版本、短变更摘要、安装入口和文档入口；详细说明放在 README、docs 和 GitHub Release。
