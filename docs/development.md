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

集成测试需要一个 DeepSeek Harness launcher。按以下顺序查找：

1. `DSH_CHECKOUT` 指定的目录，且其中有构建产物 `apps/cli/lib/bin.js`
2. 本仓库同级的 `deepseek-harness` 目录（`../deepseek-harness`），同样要求已构建
3. **打包版应用自带的 shim**：macOS 上是 `/Applications/DeepSeek Harness.app/.../bin/dsh`，
   Windows 上是 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`

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

**没有源码 checkout 时可以用打包版应用**，它足以跑大部分集成套件。安装位置不在默认路径时用
`DSH_PACKAGED_SHIM` 指过去：

```powershell
$env:DSH_PACKAGED_SHIM = 'D:\soft\dsh\resources\runtime\cli\bin\dsh.cmd'
pnpm test:integration
```

打包版的 Windows shim 是 `.cmd`，`spawn` 不查 `PATHEXT`，所以测试通过 `cmd /c` 调用它；
这一点由 `tests/unit/harness-launcher.spec.ts` 钉住。

测试把 `DSH_HOME` 指向临时目录，不会修改开发者正在使用的 profile。

**Windows 非管理员下链接仓库用 junction 回退**：`linkRepoAsBundle` 先试目录符号链接，
`EPERM`（普通用户没有创建符号链接的权限，除非开了开发者模式）时改试 junction。两者都是目录重定向，
junction 不需要特权。

`client-half-runs.spec.ts` 要从 checkout 里读 React 和主题样式表，而打包端不带源码，所以它**要求一个
真实的源码 checkout**：只找到打包版时该套件直接报错并提示设置 `DSH_CHECKOUT`，不会因为路径拼不出来
就整组跳过——跳过的用例在报告里看起来和通过一样。

## 持续集成

`.github/workflows/ci.yml` 在 ubuntu 与 windows 两个 runner 上跑 `pnpm build`、`pnpm typecheck` 和 `pnpm test`。两个平台都要跑，是因为测试里有一部分断言只有特定平台能证伪：POSIX 权限位（`0o600`）在 Windows 上会被跳过，而路径分隔符与 CRLF 行为只在 Windows 上才暴露。

**测试里不要硬编码某一平台的路径。** `path.isAbsolute` 是平台绑定的：`D:\work\next` 在 Windows 上是绝对路径，在 Linux 上不是。用这种字面量断言「切换成功后报告规范化路径」，会在 Windows 上通过、在 ubuntu 上失败——因为路径在校验阶段就被拒了，根本走不到被测的分支。需要绝对路径时按平台拼：

```ts
const root = process.platform === 'win32' ? 'D:\\' : '/'
const absolute = root + ['work', 'next'].join(process.platform === 'win32' ? '\\' : '/')
```

反过来，**纯字符串处理**（`deliverables.ts` 的路径拼接、`peer-map`/`peer-session-store` 的 cwd 存取）用的是自己实现的「POSIX 或 Windows 都算绝对」判断，不经过 `node:path`，所以可以在任一台机器上断言另一种拼写——`deliverables.spec.ts` 正是这样测 Windows 路径的。

Windows job 还会显式把 `core.autocrlf` 设为 `true` 并重新检出 `*.svg`，用 `git ls-files --eol` 确认工作区仍是 LF。这就是 0.2.4 之前 `icon.svg` 断言在 Windows 上失败的那条路径；不显式复现，回归只会在开发者机器上出现。

集成测试不在 CI 里跑：它需要一个已构建的 DeepSeek Harness checkout，CI 没有。

## 构建结构

`tsdown` 从 `src/index.ts` 生成 host half；`scripts/copy-client.mjs` 把手写的 `src/client/client.js` 复制到 `lib/`。`@deepseek-ai/*` 保持为宿主提供的运行时依赖，不能打包进插件。

发布流程见 [release.md](./release.md) 与 [.dsh/skills/release-workflow/SKILL.md](../.dsh/skills/release-workflow/SKILL.md)；npm registry 切换和发布细节在它的 `references/release-reference.md`。
