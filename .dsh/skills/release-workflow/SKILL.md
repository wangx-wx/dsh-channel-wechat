---
name: release-workflow
description: 发布 dsh-channel-wechat 新版本时，按仓库事实更新 GitHub Pages、文档、npm 包和 GitHub Release，并完成发布后验证。
metadata:
  short-description: dsh-channel-wechat 发布流程
---

# 发布流程

用于用户明确要求发布、打版本、更新 npm 或创建 GitHub Release 时。只执行已授权的发布动作；普通文档编辑或代码开发不自动触发本 skill。

## 发布前读取

1. 读取仓库根目录的 `CLAUDE.md`、`README.md`、`README.en.md`、`package.json` 和本 skill 的 references。
2. 读取 [release-reference.md](references/release-reference.md) 了解 npm 与 GitHub Pages 的已验证陷阱。
3. 读取 [readme-boundaries.md](references/readme-boundaries.md) 和 [github-release.md](references/github-release.md)，分别约束 README 和 Release 声明。
4. 检查工作区和当前分支。保留用户已有修改；发布前必须明确哪些修改属于本版本。

## 主流程

按顺序执行，每步完成后再进入下一步：

1. **确定版本**：根据 `package.json` 当前版本和 DSH 兼容代次选择 patch/minor/major；先不要发布。
2. **整理内容**：完成代码、测试和面向用户的文档；README 只保留用户入口信息，详细内容归档到 `docs/` 或 `spec/`。
3. **更新 GitHub Pages 首页**：按 [github-pages.md](references/github-pages.md) 更新 `docs/index.html` 的当前版本、Release 链接和短摘要；市场索引留到 npm 发布后处理。
4. **验证**：运行 `pnpm build`、`pnpm typecheck`、`pnpm test:all`；适用时运行真实 launcher 的集成测试。失败必须记录原因，不得删测试或降低标准。
5. **提交发布前变更**：检查 `git diff`、`git diff --check` 和发布包内容；提交本次代码、文档和 Pages 变更。
6. **递增版本**：使用 `npm version patch|minor|major -m "Release %s"`，生成版本提交和 `v<version>` tag。版本规则见 [release-reference.md](references/release-reference.md)。
7. **发布 npm**：切到官方 registry，确认 `npm whoami`，执行 `npm publish --dry-run`，确认无误后执行 `npm publish`。收到 202 或 staged 状态后只观测，不重复发布。
8. **确认 npm**：用 `npm view <package> version dist-tags` 确认 `latest` 指向新版本；传播期间不得换版本号重发。
9. **更新市场索引**：确认 npm 新版本可读后，按 [github-pages.md](references/github-pages.md) 重新生成或校验 `docs/market/index.json`，只提交由已发布 manifest 产生的内容。
10. **推送 Git 状态**：推送发布提交、Pages 更新提交和 tag。除非用户另有要求，不自动合并到其他分支。
11. **创建 GitHub Release**：按 [github-release.md](references/github-release.md) 使用短声明，只写本版本变化、兼容性、验证状态和升级提示，不复制 README。
12. **验证 Pages 与安装**：确认 Pages URL 返回新内容，必要时在隔离 `DSH_HOME` 中安装新版本并确认 bundle 能加载。
13. **汇报**：列出版本、提交、tag、npm、GitHub Release、Pages、验证命令和失败/未验证项。

## 停止条件

- 工作区有无法归属本版本的用户修改：先停在归属确认，不覆盖或清理。
- npm 认证、2FA、registry 或 GitHub 权限不足：停止对应外部动作，保留已完成的本地准备。
- 发布已返回成功但 registry 尚未公开：等待观测，不重复 `npm publish`。
- 需要修改业务行为才能通过验证：记录问题并停止该发布路径，不以文档或测试规避。

## 参考文件

- [github-pages.md](references/github-pages.md)：Pages 文件、市场索引和检查方式。
- [readme-boundaries.md](references/readme-boundaries.md)：README 内容边界与归档规则。
- [github-release.md](references/github-release.md)：GitHub Release 标题、正文和长度规范。
- [release-reference.md](references/release-reference.md)：npm、版本、tag 和历史陷阱。
