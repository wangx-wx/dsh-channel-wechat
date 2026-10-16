# 需求规格：GUI 内登录 + 配置可视化管理 + 去掉重复条目

日期：2026-10-16
分支：`dev_wechat_gui_20261016`
状态：**已完成**，随 **v0.1.2** 发布

## 1. 背景（用户提出的三个问题）

安装完插件后的真实使用体验有三个摩擦点：

1. **登录入口要靠翻日志**。插件在日志里打印一行
   `微信登录：在已打开 Harness 界面的浏览器中打开 http://127.0.0.1:<端口>/api/channel-wechat/login 扫码连接`，
   用户必须先找到这个地址、再打开、再扫码。桌面端尤其难受——那行字在终端和
   `~/.dsh/channel-wechat/log/` 里，不在眼前。
2. **配置只能手改 YAML**。`cwd` 与 `cards` 要编辑 profile 的 `cordis.patch.yml` 才生效；
   用户希望在插件里就能配。
3. **插件安装后展示两个条目**。`cordis.patch.yml` 里是两行：
   `channel-wechat-startup`（`dsh-channel-wechat/startup`）与 `channel-wechat`。

## 2. 侦察结论（决定方案的既有事实）

### 2.1 两行是 `dsh <profile> login` 的产物，而那条路在 web/desktop 上走不通

`startup.ts` 是独立的 cmdline provider 行：它 inject `cmdlineArgs`、解析 app 参数、
`provide('wechatStartup')`，主行再 `!!js` 读它。之所以必须单独一行，是因为
「只有声明 `inject` 的那一行才拿到启动器给命令行」。

但这条路在**挂了 web app 的 profile**（`web` / `desktop`）上不成立：

```
$ DSH_HOME=<isolated> node apps/cli/lib/bin.js clitest login
error: too many arguments. Expected 0 arguments but got 1: login.   [exit=1]
```

**本规格开发期实测复现**（隔离 home + 真实 launcher）：`dsh-web-app` 的 program
只声明 flag、没有 positional，commander 在到达本插件之前就 `exit(1)`。
这与 `plan-v1 §M1 验收标准修订` 的结论一致，本条为再次确认。

⇒ 那两行里，`startup` 行在用户实际使用的两个 profile 上**从不生效**。

### 2.2 DSH 客户端半边（浏览器插件）是可行的，且不必上 bundler

- 宿主 `@deepseek-ai/dsh-client-modules` 扫 `ctx.loader.entries()`，读每行解析到的
  `package.json`，`dsh.client.platform === 'web'` 的包把 `exports["./client"]` 挂到 `/plugins`。
- **客户端半边不需要在 `cordis.patch.yml` 加任何行**——它挂在同名的宿主行上。
- 产物格式唯一的硬要求：`window.__ModuleLoader__.load({ id: <包名>, factory(require){...} })`。
  官方模板 `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`
  就是 22 行手写文件。
- `require` 只能命中 9 项平台表 + `dsh.client.external`；本需求只用 `react`。
- **静默失败点**：`platform` 拼错或漏 `dsh.client` → 完全不进图、不报错。

### 2.3 配置想在 GUI 里编辑，字段必须是 `volatile`

- `@deepseek-ai/dsh-settings` 的表单只投影 volatile 字段：
  `volatileForm()`（`packages/settings/settings/src/schema.ts:37`），value 也被同一 schema 裁剪
  （`projectForm`，同文件 `:59`）。**非 volatile 字段是"缺席"，不是只读**。
- 一个连一个 volatile 字段都没有的 entry，`describe()` 里**根本不出现**。
- 写入最终走 `ctx.configEditor.edit()`，落盘目标就是
  `$DSH_HOME/profiles/<name>/cordis.patch.yml`（保留注释与 `!!js`、有文件锁、失败回滚）。
- 写入会把该字段的 `!!js process.cwd()` 固化成字面量路径（这是可接受的代价，重置可恢复）。

## 3. 需求

### R1 插件自己的详情页里有登录入口

进入侧边栏 **Plugins → dsh-channel-wechat** 的详情页，页面上直接有：

- 当前连接状态（未登录 / 已登录，显示 accountId）
- **登录**按钮 → 页内显示二维码 → 手机扫码 → 需要验证码时页内输入 → 成功后显示已连接
- **退出登录**按钮

全程不离开 GUI，不需要翻日志、不需要跳转到别的地址。

### R2 本插件的配置在 GUI 里可编辑

同一个详情页上有 `cwd` 与 `cards` 的表单，保存写入 profile 的 `cordis.patch.yml`。

- `cwd` 的不可变性要在页面上说清楚：修改只影响**之后新建**的会话。
- 模型配置（provider / model / baseURL / API key）**不在本需求范围**：官方
  Settings → Models 页今天已经能编辑它们（对应字段官方已全部 `.volatile()`）。

### R3 `startup` 行合并进主行

`dsh-channel-wechat/startup` 不再是一个独立的包行：

- cmdline 解析搬进 `src/index.ts`（`inject` 加 `cmdlineArgs`，该服务启动器总是提供，
  不会让整行 parking）。
- 删除 `src/startup.ts`、`exports["./startup"]`、`cordis.patch.yml` 的 startup 行。
- **保留 CLI 能力**：没有 web app 的 profile（headless / sdk）上 `dsh <profile> login`
  仍可用——那是 CLI 唯一真正能用的场合。
- GUI 上只剩一张卡片。

## 4. 验收

| # | 验收 | 怎么验 |
|---|---|---|
| A1 | 真实 web profile 启动后，包名出现在 `__DSH_BOOT__`，且 graph 给的 URL 能取回含 `__ModuleLoader__.load` 的 JS | `tests/integration/client-half.spec.ts`（真实 launcher + 隔离 home + token 换 cookie） |
| A2 | 插件页能**执行**：注册在 `plugins.bundle.config`、key = 包名、`hooks` 隔间正确、字段 spec 正确 | `tests/integration/client-half-runs.spec.ts`（真 React；三条变异各自被捕获） |
| A3 | `cwd`/`cards` 标了 `.volatile()`，`cwd` required 无默认 | `tests/unit/config-schema.spec.ts`（删 volatile → 失败） |
| A4 | 状态接口报告**已存储**的登录；退出登录真的删除凭证并停轮询 | `tests/unit/login-routes.spec.ts` + `tests/integration/panel.spec.ts`（真实 apply 接线） |
| A5 | `cordis.patch.yml` 只剩一行；`--dump-config` 只有一条我们的条目 | `tests/integration/patch-layer.spec.ts` |
| A6 | 有 `cmdlineArgs` 时 `login`/`status` 仍被认领，`--help` 不启动服务 | `tests/unit/cmdline.spec.ts` |
| A7 | `@deepseek-ai/*` 仍不进 `dependencies` | `tests/unit/manifest.spec.ts` |

## 5. 明确不做

- 不改模型配置的归属（官方 Models 页已经是正确位置）。
- 不引入 bundler / tsdown 的客户端构建链：客户端半边手写，`lib/client.js` 由构建直接拷贝。
- 不改 `/cwd` 命令（仍为未实现，明确回复）。
- 不做远程（非 loopback）浏览器下的写入——DSH 在那种模式下所有表单写入静默 no-op，
  这是 DSH 层面的既有行为，不在本插件内解决。
