# 开发与验证

## 环境

```bash
pnpm install
```

需要 Node.js `^22.19.0 || >=24.0.0`。仓库使用 pnpm 11，版本写在 `package.json` 的 `packageManager` 字段。

## 常用命令

```bash
pnpm build             # 构建 lib/，并复制浏览器端 client.js
pnpm typecheck         # TypeScript 检查
pnpm test              # unit 项目
pnpm test:integration  # integration 项目，真实 launcher + 隔离 DSH_HOME
pnpm test:all          # 两个项目
```

干净 checkout 首次执行 `pnpm typecheck` 可能因 `exports` 指向尚未生成的 `lib/*.d.ts` 失败；先运行 `pnpm build`。

集成测试默认使用 `tests/support/harness.ts` 指定的本地 DeepSeek Harness checkout；可用环境变量覆盖：

```bash
DSH_CHECKOUT=/path/to/deepseek-harness pnpm test:integration
```

测试把 `DSH_HOME` 指向临时目录，不会修改开发者正在使用的 profile。若本地 checkout 不存在，测试会尝试使用 `DeepSeek Harness.app` 中的 dsh shim。

## 构建结构

`tsdown` 从 `src/index.ts` 生成 host half；`scripts/copy-client.mjs` 把手写的 `src/client/client.js` 复制到 `lib/`。`@deepseek-ai/*` 保持为宿主提供的运行时依赖，不能打包进插件。

发布流程和 npm registry 切换步骤见 [release.md](./release.md)。
