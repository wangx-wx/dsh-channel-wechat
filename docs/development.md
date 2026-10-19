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

集成测试需要一个**已构建**的 DeepSeek Harness checkout。按以下顺序查找，第一个能找到 `apps/cli/lib/bin.js` 的胜出：

1. `DSH_CHECKOUT` 指定的目录
2. 本仓库同级的 `deepseek-harness` 目录（`../deepseek-harness`）
3. macOS 上打包的 `DeepSeek Harness.app`（仅 `darwin`）

```bash
# 用同级的 deepseek-harness checkout，无需任何环境变量
pnpm test:integration

# 或显式指定
DSH_CHECKOUT=/path/to/deepseek-harness pnpm test:integration
```

`DSH_CHECKOUT` 指向的目录若存在但没有构建产物，测试会在导入时直接报错并指出缺失的 `apps/cli/lib/bin.js`，而不是继续跑到无关的失败。

Windows 上同级 checkout 需先构建：

```powershell
cd ..\deepseek-harness
pnpm install
pnpm build
```

测试把 `DSH_HOME` 指向临时目录，不会修改开发者正在使用的 profile。只有 macOS 才会回退到 `DeepSeek Harness.app` 中的 dsh shim；其他平台找不到 checkout 时直接报错。

## 持续集成

`.github/workflows/ci.yml` 在 ubuntu 与 windows 两个 runner 上跑 `pnpm build`、`pnpm typecheck` 和 `pnpm test`。两个平台都要跑，是因为测试里有一部分断言只有特定平台能证伪：POSIX 权限位（`0o600`）在 Windows 上会被跳过，而路径分隔符与 CRLF 行为只在 Windows 上才暴露。

Windows job 还会显式把 `core.autocrlf` 设为 `true` 并重新检出 `*.svg`，用 `git ls-files --eol` 确认工作区仍是 LF。这就是 0.2.4 之前 `icon.svg` 断言在 Windows 上失败的那条路径；不显式复现，回归只会在开发者机器上出现。

集成测试不在 CI 里跑：它需要一个已构建的 DeepSeek Harness checkout，CI 没有。

## 构建结构

`tsdown` 从 `src/index.ts` 生成 host half；`scripts/copy-client.mjs` 把手写的 `src/client/client.js` 复制到 `lib/`。`@deepseek-ai/*` 保持为宿主提供的运行时依赖，不能打包进插件。

发布流程见 [release.md](./release.md) 与 [.dsh/skills/release-workflow/SKILL.md](../.dsh/skills/release-workflow/SKILL.md)；npm registry 切换和发布细节在它的 `references/release-reference.md`。
