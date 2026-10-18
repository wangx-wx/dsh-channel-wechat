# README 边界与内容归档规范

## README 保留

README 面向第一次访问 GitHub 首页的用户，只回答：

- 项目做什么、适合什么场景。
- 环境要求和兼容性摘要。
- 安装、初始化和首次验证。
- 常用配置、数据位置和最小排障路径。
- 获取帮助、贡献入口、许可证和文档索引。

中英文 README 的功能、命令、版本要求、限制和路径必须一致；英文可以自然改写，但不得增加中文没有的承诺。

## 归档到 docs/ 或 spec/

- 完整配置表 → `docs/configuration.md`
- 兼容性证据和未验证范围 → `docs/compatibility.md`
- 构建、测试、真实 launcher 说明 → `docs/development.md`
- 用户故障排查 → `docs/troubleshooting.md`
- 架构、不变量、协议和决策 → `docs/architecture.md`、`docs/invariants.md`、`docs/protocol/`、`docs/plan-v1.md`
- 需求规格 → `spec/YYYYMMDD-<slug>.md`
- 版本历史与实测证据 → `docs/dev-log/`

不要为了 README 变短而删除仍有效的限制、风险、事实依据或安装陷阱；应移动并在 README 留下入口。

## 发布前检查

- README 中的命令、路径、配置名来自源码、测试、`package.json` 或官方文档。
- 所有仓库内链接使用相对路径；不要使用只在本机成立的绝对路径。
- 不放 token、Cookie、凭证、个人路径或未验证的版本承诺。
- README 只保留当前状态；历史争议和被推翻判断放入开发日志或决策文档。
