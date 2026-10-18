# 贡献指南

## 开始前

请先在 [GitHub Issues](https://github.com/wangx-wx/dsh-channel-wechat/issues) 搜索已有问题。新问题请提供 DSH 版本、插件版本、profile 类型、复现步骤和脱敏日志；不要提交 token、Cookie 或凭证文件。

## 本地开发

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:integration
```

集成测试使用临时 `DSH_HOME`。如果本地 DeepSeek Harness checkout 不在默认位置，设置 `DSH_CHECKOUT=/path/to/deepseek-harness`。

## 提交变更

- 业务行为变更应同时补充或更新测试。
- 文档链接、命令和配置说明必须以源码、测试或配置为依据。
- Pull Request 请说明变更内容、验证命令和已知限制。
- 不要在同一变更中修改无关的业务代码、依赖或锁文件。
