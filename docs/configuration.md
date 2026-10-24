# 配置参考

插件配置写在 profile 的 `cordis.patch.yml` 中，也可以在 GUI 的 **Plugins → dsh-channel-wechat** 页面编辑。GUI 只显示 schema 标记为 `volatile` 的字段。

## 配置项

| 配置项 | 类型 | 默认值 | 作用与生效方式 |
|---|---|---|---|
| `cwd` | 绝对路径字符串 | 无 | 新建微信会话记录的默认工作目录；必填，且会话创建后不可修改。修改只影响之后的新会话。用户可以用 `/cwd` 按 peer 覆盖它。 |
| `cards` | `wechat` 或 `both` | `wechat` | 交互卡发送到微信，或同时保留 GUI 卡片。 |
| `provider` | 字符串 | 空字符串 | 为空时沿用 profile 默认 provider；非空时只作用于本插件的微信会话，不影响 GUI。修改对已有会话的**下一条消息**生效。 |
| `model` | 字符串 | 空字符串 | 为空时沿用 profile 默认模型；非空时只作用于本插件的微信会话，不影响 GUI。修改对已有会话的**下一条消息**生效。 |
| `permission` | `read-only`、`workspace-write` 或 `danger-full-access` | `workspace-write` | 新建微信会话使用的 DSH 权限 preset。不会修改 GUI 会话。 |
| `maxMessageChars` | 数字 | `2000` | 单条微信消息的字符上限。超长回复按段落/行/句子切开分多条发送；跨切分的代码围栏会自动补闭合与重开。 |
| `minSendIntervalMs` | 数字 | `2000` | 同一 peer 两次发送的最小间隔（毫秒）。服务端对突发发送返回 `ret: -2`，调速是**主动**避免它。`0` 表示不调速。 |
| `maxThrottleAttempts` | 数字 | `5` | 一条回复被限流（`-2`）时的重试上限，按 2s→4s→8s→16s 退避。**不占用**普通失败重试次数。 |
| `allow` | 字符串（一行一个 id） | 空字符串 | 允许使用这个机器人的微信账号。**留空表示只放行扫码登录的那个账号**，其他人发来的消息一律忽略（不回执，只在插件日志里记录 peer id）。填入后以名单为准，登录者不再自动放行。 |

示例：

```yaml
- id: channel-wechat
  config:
    cwd: /Users/me/work
    cards: wechat
    provider: ''
    model: ''
    permission: workspace-write
    maxMessageChars: 2000
    minSendIntervalMs: 2000
    maxThrottleAttempts: 5
    allow: ''
```

`cwd` 使用绝对路径。未设置时 schema 会拒绝启动，不会替用户猜一个目录。`cards`、模型、权限和出站字段由 schema 提供默认值，因此旧 profile 仍可加载。

**`allow` 决定谁能用这个机器人。** 留空时只放行**扫码登录的那个账号**（登录时服务器下发的 `ilink_user_id`，
私聊里就是它的 `from_user_id`），其他任何人发来的消息都被忽略——不建会话、不执行命令、不回任何内容，只在
插件日志里留一行带对方 id 的记录，把那个 id 填进 `allow` 即可授权。填入非空名单后**以名单为准**，登录者
不会自动包含在内。

这不是「聊天对象」层面的限制：同一条入站路径还能执行 `/model`（改写本插件的 provider/model）、`/cwd`
（把会话迁到任意目录）和宿主命令，所以未加限制时任何能给机器人发消息的人都能改你的配置。详见
[不变量](./invariants.md#身份门控必须在命令路由之前)。

`cwd` 是**默认值**，不是强制值：微信里用 `/cwd <绝对路径>` 可以按 peer 覆盖它。切换会结束当前会话、
在新目录开始新对话，并记在 `~/.dsh/channel-wechat/peer-sessions.json` 里跨重启保留。详见
[微信内命令](./commands.md#cwd切换工作目录)。

## 登录凭证与状态

- GUI 登录和退出登录写入 DSH 的 `ctx.credentials`。
- 命令行 `dsh <profile> login|logout|status` 只适用于没有挂载 web app 的 profile。
- 凭证文件由 DSH 管理，默认位置为 `~/.dsh/.credentials.yaml`，不是插件私有格式。

## 权限边界

插件使用 DSH 自身的 permission preset，不建立第二套权限系统。微信消息按单用户通道处理。

审批卡的第 3 个选项「本会话全部权限」会把当前会话切到 `danger-full-access`，效果等同于在会话里发送 `/permission danger-full-access`：该会话之后不再弹出审批卡（该预设捆绑 `approval: never`），`/new` 之后按配置的 `permission` 重新创建会话。这个选择只作用于当前会话。

详情见 [命令参考](./commands.md#审批卡)。
