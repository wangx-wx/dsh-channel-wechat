# `docs/assets/`

落地页 [`../index.html`](../index.html) 用的静态资源。**这是 GitHub Pages 会公开发布出去的目录**，
所以只放确认可以公开的东西。

## 现有文件

| 文件 | 用途 |
|---|---|
| `site.css` | 落地页样式（后续的文章页也共用这一份） |
| `wechat-chat.png` | 微信对话截图 —— **待补** |
| `plugin-page.png` | 插件页与二维码截图 —— **待补** |
| `approval-card.png` | 微信里的审批卡截图 —— **待补** |

## 截图规格

- 格式 PNG 或 WebP，宽度 720–1080 px，单张 ≤ 400 KiB
- 手机截屏给原图即可，缩放与压缩在这里做
- 打码：微信昵称、头像、`~/.dsh` 路径里的用户名

图片**放到对应文件名就自动显示**，不需要改 HTML：页面里的 `<img>` 带
`onerror="this.remove()"`，图缺失时它会把自己从 DOM 删掉，占位提示（`data-label`）随之透出。

## 为什么不放图标

页首图标直接引用仓库根目录的 `icon.svg`：

```
https://cdn.jsdelivr.net/gh/wangx-wx/dsh-channel-wechat@main/icon.svg
```

因为 Pages 只发布 `/docs`，根目录那份站点取不到。用 CDN 指向同一份文件，避免在这里复制
一份导致两处图标不一致。**换图标只改根目录的 `icon.svg`，本目录不需要跟着改。**
