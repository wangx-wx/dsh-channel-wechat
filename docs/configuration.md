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

示例：

```yaml
- id: channel-wechat
  config:
    cwd: /Users/me/work
    cards: wechat
    provider: ''
    model: ''
    permission: workspace-write
```

`cwd` 使用绝对路径。未设置时 schema 会拒绝启动，不会替用户猜一个目录。`cards`、模型和权限字段由 schema 提供默认值，因此旧 profile 仍可加载。

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
