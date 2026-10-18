# 故障排查

## 安装后插件页没有登录或配置区

**现象**：插件卡片和版本可见，但详情页没有二维码、配置、模型或权限表单。

**处理**：完全退出并重新打开 DSH。宿主 `dsh-client-modules` 会缓存浏览器端模块解析结果；插件从 GUI 安装时，宿主通常早于包落盘启动，重启才能重新构建模块图。

## 微信收不到回复

1. 在插件页确认账号已连接，或运行 `dsh <profile> status`（仅 headless 等无 web app profile 可用）。
2. 查看 `~/.dsh/channel-wechat/log/channel-wechat-YYYY-MM-DD.log`。
3. 确认 `cwd` 是绝对路径，并且新消息对应的是修改配置后新建的会话。
4. 若是交互卡，确认 `cards` 没有被改成与使用场景不符的值；发送 `/status` 可查看通道状态。

## `dsh <profile> login` 报参数错误

这是 web/desktop profile 的已知限制：启动器把同一组参数交给 web app，而 web app 不接受 `login` 位置参数。请使用插件页扫码；终端登录仅支持没有挂载 web app 的 profile。

## 媒体或引用显示降级文本

插件会把媒体失败追加为文本说明，不会吞掉原消息。引用自己的微信消息目前可能只有 `svr_id`，无法还原正文；这属于已记录限制。

## 仍未解决时收集的信息

请提供 DSH 版本、插件版本、profile 类型、相关时间段的插件日志，以及可复现的消息类型。不要粘贴 token、Cookie 或凭证文件内容。
