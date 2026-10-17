# 升级与发版时踩过的坑

每条都带实测证据。这些坑的共同点是**看起来成功了**——绿灯、`202 Accepted`、
`+ name@version`——所以只有记录才能避免重踩。

## 1. 集成测试绿灯点的可能是旧版本

**现象**：跑 `pnpm test:integration`，99 passed，以为验证了新 checkout。

**实际**：`tests/support/harness.ts:40` 的逻辑是

```ts
const launcher = join(DSH_CHECKOUT, 'apps', 'cli', 'lib', 'bin.js')
if (existsSync(launcher)) return [process.execPath, launcher]
return ['/Applications/DeepSeek Harness.app/.../dsh']   // 静默回退
```

`lib/` 在 DSH 仓库里是 gitignore 的，所以**没构建过的 checkout 会静默回退到
打包 app**。而 `DSH_CHECKOUT` 同时还决定 `client-half-runs` 从哪读
`ui-theme` 源码，两件事被一个变量绑在一起。

**实测对照**（同一套测试）：

| `DSH_CHECKOUT` | 实际 launcher | 结果 |
|---|---|---|
| DSH 仓库（未构建） | 打包 app `0.2.0-rc.2` | 99 passed / 0 skipped |
| `DeepSeek Harness.app` | 打包 app `0.2.0-rc.2` | 84 passed / **15 skipped** |
| npm 装的 `0.2.1-rc.1` + shim | 真 `0.2.1-rc.1` | 99 passed / 0 skipped |

前两行 launcher 相同、跳过数不同 → **跳过数跟 DSH 版本无关**，只跟「源码树在哪」有关。

**教训**：`scripts/probe-dsh.sh` 会校验 `--version` 并在不符时退出 1。
不要靠「看起来跑通了」判断。

## 2. 15 个跳过不是不兼容

跳过的全是 `client-half-runs`：它要 checkout 的 `packages/client/ui-theme/src/styles`
（读 `--dsw-*` token）和 pnpm store 里的 react。打包 app 不带源码。
**属环境限制**。给 `probe-dsh.sh` 传 `--sources <任意 checkout>` 就能补上——
token 是从源码读的，与运行时版本无关。

## 3. `@latest` 不会绕过 `minimumReleaseAge`

**用户直觉**：写 `@latest` 就能装到刚发的版本。
**实测**：不能。`minimumReleaseAge`（pnpm 供应链策略，默认 1440 分钟）
在版本解析**之后**检查，`@latest` 只影响解析。

| 命令 | 结果 |
|---|---|
| `add dsh-channel-wechat` | `^0.1.1`（旧版本） |
| `add dsh-channel-wechat@latest` | `^0.1.1`（同样旧） |
| `add dsh-channel-wechat@latest --config.minimumReleaseAge=0` | `^0.1.3` |

真正的开关是 `--config.minimumReleaseAge=0`，不是 `@latest`。

## 4. 装完必须完全重启

**现象**：插件装了、版本对，但插件页没有配置区。

**根因**：DSH 的 `@deepseek-ai/dsh-client-modules` 在 `resolveMeta` 里有**永久负缓存**
（`pkgMeta` 缓存 `null`）。Host 启动时若包不在 `node_modules`，它永远不进 boot graph，
`/plugins/??dsh-channel-wechat/client.js` 永远 404，`apply()` 从不执行——
**所以连错误都不显示**。重启自愈。装的是 0.1.1 还是 0.1.3 都无所谓，因为
陈旧性在首次解析时就固定了。

**这也解释了「为什么没有配置区」类问题先怀疑重启。**

## 5. 桌面端更新失败：长轮询没被中止

**报错**：`Host did not complete graceful task teardown (exit 0, signal null,
shutdown acknowledged true, graceful deadline exceeded true)`

**根因**：在飞的 `fetch` 没有被 abort，配合一个 ref'd 的 `setTimeout`，事件循环不退出。
原来的实现只是「race 一个超时」——那只释放了**等待它的循环**，没有中止**请求本身**。

**实测**：改前 `loop ended at 114ms` 然后 `STILL ALIVE after ~10s`；
改后 `exited code=0 after 119ms`。

**教训**：`AbortSignal` 必须传进 fetch，不能只在外面 race。为这类问题写测试时，
假 fetch 要**真的响应 abort**，否则测试会超时（踩过）。

## 6. `0.0.0-stage` 与 409 都不是失败

新包名首次发布时会先出现公开占位版本 `0.0.0-stage`，约 2 分钟；
已存在的包升级时症状不同——`202 Accepted` + `+ name@version`，然后
`GET /<pkg>/<version>` 仍 404，重试会得到
`409 Cannot publish over previously staged version`。

**409 是「已上传成功」的证据**，说明注册表收下了、只是还没公开。
看到 409 去静候，**绝对不要换版本号重发**。传播耗时：新包约 2 分钟，已有包约 9 分钟。

最可靠的探针是带 token 查单版本（200 = 已上传、可能未公开；404 = 确实没有），
比 `npm view` 可靠——后者会命中本地缓存。

## 7. `engines.dsh` 只能放宽，不能收紧

**曾经的反向直觉**：「加了 `engines.dsh` 会限制高版本安装」。

**实测**：

| 写法 | `0.2.0-rc.2` | `0.3.0` | `1.0.0` |
|---|---|---|---|
| peer `^0.2.0-rc.1`（无 engines） | OK | **NO** | **NO** |
| `engines.dsh: >=0.2.0-rc.1` | OK | OK | OK |

`engines.dsh` 一旦存在就**忽略 peer**，所以它只能是放宽。
要收紧才需要加上界——而本插件刻意不加（见 SKILL.md 的方向感一段）。

## 8. `^0.2.1-rc.1` 会弄丢当前 `latest`

**曾经的念头**：「已验证 `0.2.1-rc.1`，把 peer 提到 `^0.2.1-rc.1`」。

**实测会被丢掉的版本**：

| range | `0.2.0-rc.1` | `0.2.0-rc.2` |
|---|---|---|
| `^0.2.0-rc.1` | OK | OK |
| `^0.2.1-rc.1` | **NO** | **NO** |

而 `0.2.0-rc.2` 正是 npm 上的 `latest` **和打包桌面端**。
且因为 `engines.dsh` 已存在、peer 根本不参与判定，改 peer 对安装准入**零收益**——
只有风险。结论：不动 peer。

## 9. 干净 checkout 上 `pnpm typecheck` 会失败

直到 `pnpm build` 跑过一次。原因：集成测试 import `dsh-channel-wechat/startup`，
该子路径经 `exports` 解析到 `lib/startup.d.ts`，而 `lib/` 是 gitignore 的。
升级流程里若要 typecheck，先 build。
