# 发布参考

发布操作流程已收敛到工作区 skill：

- [skills/release-workflow/SKILL.md](../.dsh/skills/release-workflow/SKILL.md)

使用该 skill 执行版本发布时，它会依次处理：

1. 文档与代码定稿。
2. README 边界检查和内容归档。
3. GitHub Pages（`docs/`）版本内容与市场索引。
4. 构建、类型检查、单元测试和适用的集成测试。
5. 版本号、npm dry-run、npm publish 和发布传播确认。
6. tag、GitHub Release 和隔离 profile 安装验证。

## 本文件保留的事实

- 发布必须使用 `https://registry.npmjs.org`；日常开发可切回镜像源。
- 账号需要 2FA，或使用允许绕过 2FA 的 granular token；`npm whoami` 是登录判断依据。
- 版本格式是 `<DSH 主>.<DSH 次>.<本插件补丁>`，兼容下界以 `package.json.engines.dsh` 为准。
- `npm version` 会修改版本、创建提交并创建 `v<version>` tag；发布后仍需分别推送提交和 tag。
- `npm publish --dry-run` 必须确认 `lib/index.js`、`lib/index.d.ts`、`lib/client.js`、README、许可证、第三方声明和 bundle 配置都进入 tarball。
- npm 返回 `202`、出现 staged 占位或返回 `409 Cannot publish over previously staged version` 时，不重复发布，先用 `npm view` 观测传播。
- GitHub Release 只在 npm 版本已公开、tag 已存在后创建。
- npm 发布成功不等于插件可加载；必须在隔离 `DSH_HOME` 中确认依赖、`dsh.profile.bundles`、`lib/` 和真实启动加载。

## 历史证据与陷阱

以下内容是历史实测记录，不作为新的主流程重复执行：

- npm staged publishing 的占位版本、传播延迟和重复发布误判：见 Git 历史或本 skill 的 `references/release-reference.md`。
- `dependencies` 存在但 `dsh.profile.bundles` 缺失会导致“安装成功但不加载”。
- 本地 `link:` 不执行构建，未先 `pnpm build` 会得到没有 `lib/` 的包。
- 首次发布时 npm 页面可能保留旧 README，因此必须在发布前完成文档定稿。

本仓库不在本文件中记录个人账号、token、临时路径或一次发布的具体时间线。
