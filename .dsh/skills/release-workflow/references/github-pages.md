# GitHub Pages 更新

本仓库的 Pages 源目录是 `/docs`，发布地址是：

- 站点：`https://wangx-wx.github.io/dsh-channel-wechat/`
- 插件市场索引：`https://wangx-wx.github.io/dsh-channel-wechat/market/index.json`

## 更新范围与时机

- **发布前**更新 `docs/index.html`：当前版本、Release URL 和一条简短变更摘要。
- **npm 发布后**处理 `docs/market/index.json`：只有确认新版本已能从 npm registry 读取后，才重新生成或校验索引。
- 两者都属于 Pages 发布内容；首页不复制历史 Release，历史版本由 GitHub Releases 展示。

## 更新步骤

1. 查看 `docs/index.html` 当前版本卡片、Release 链接、README 链接和文档索引。
2. 发布前更新首页的当前版本号、Release URL 和短摘要。
3. npm 新版本公开后，若版本列表或包元数据有变化，按 [docs/market/README.md](../../../docs/market/README.md) 重新生成或校验 `docs/market/index.json`；不要手写与 npm 不一致的版本、引擎或描述。
4. 检查站点内相对链接、Release 链接、市场索引 JSON 和页面资源路径。
5. 提交并推送 Pages 变更后等待构建，再用 `curl` 检查站点和索引返回 200，并确认页面显示新版本。

## 边界

Pages 是发布展示层，不复制 README 全文，也不承载完整发布说明。页面只展示项目简介、当前版本、短变更摘要、安装入口和文档入口；详细说明放在 README、docs 和 GitHub Release。

## 什么时候更新、什么时候不更新

| 变化 | 是否更新 Pages | 更新位置 |
|---|---|---|
| 发布新版本 | 必须 | 当前版本卡、Release 链接、短摘要；npm 公开后再更新市场索引 |
| 安装命令、环境要求或支持范围改变 | 必须 | 安装区或项目简介 |
| README 中新增或改名的用户文档入口 | 需要 | 文档与入口区，只加链接和一句用途说明 |
| 产品定位、主要能力或明确不支持的范围改变 | 需要 | 能力摘要或范围说明 |
| npm 包名、插件市场元数据或图标改变 | 需要 | 市场索引；数据以已发布 npm manifest 为准 |
| 内部实现、架构、测试、决策或开发日志变化 | 不需要 | 留在 `docs/`、`spec/` 或开发日志 |
| 仅修正文档措辞、拼写或 README 详细段落 | 不需要 | 只改对应文档 |
| 未发布的代码、预览功能或临时分支内容 | 不允许 | Pages 只展示已发布、可验证的内容 |
| 单次故障、个人环境、构建日志或发布过程细节 | 不允许 | 留在 Issue、开发日志或 Release 验证记录 |

判断规则：如果用户访问首页后需要据此安装、判断兼容性或选择版本，就更新 Pages；如果信息只帮助开发者理解实现或追溯过程，就放到仓库文档，不扩展首页。
