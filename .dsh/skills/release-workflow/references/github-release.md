# GitHub Release 声明规范

GitHub Release 是版本变更摘要和升级提示，不是第二份 README，也不是完整开发日志。

## 标题

使用：

```text
v<version> — <一句话主题>
```

主题不超过 80 个字符，直接说明本版本的主要变化。

## 正文模板

```markdown
## 变更

- <面向用户的新增或修复>
- <重要限制或行为变化；没有则删除本项>

## 兼容性

- DeepSeek Harness：<engines.dsh 下界或本版本实际要求>
- Node.js：<package.json engines.node>

## 验证

- `pnpm test:all`：<结果>
- `pnpm typecheck`：<结果>
- <其他实际执行的验证>

## 安装

```bash
dsh plugin --profile <profile> add dsh-channel-wechat@<version>
```

完整安装、配置和已知问题见 [README](https://github.com/wangx-wx/dsh-channel-wechat/blob/main/README.md)。
```

## 规则

- 只写本版本真实变化，不复制 README 的完整安装、数据位置、架构和历史背景。
- 不声称未执行的测试通过；集成测试失败要说明环境原因。
- 不在 Release 正文中粘贴日志、token、Cookie、个人路径或长篇决策记录。
- 已知限制只写影响升级判断的内容，其余链接到 README 或 docs。
