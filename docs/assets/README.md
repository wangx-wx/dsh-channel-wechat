# `docs/assets/`

落地页 [`../index.html`](../index.html) 和文章页用的静态资源。**这是 GitHub Pages 会公开发布出去的目录**，
所以只放确认可以公开的东西。

## 现有文件

| 文件 | 用途 |
|---|---|
| `site.css` | 落地页和文章页共用的样式 |
| `site.js` | 命令块的「复制」按钮 |
| `wechat-chat.jpg` | 微信对话：问工作目录、列目录（1200×6772） |
| `approval-card.jpg` | 微信里的审批卡（1200×2169） |
| `plugin-page.png` | DSH 插件页（2560×1351） |

`readme/` 子目录是**给仓库 README 用的压缩副本**（`wechat-chat.jpg` 620×837、`approval-card.jpg` 620×1100、
`plugin-page.jpg` 1500×792），三张合计约 200 KB。上面的原图合计约 2.2 MB，直接嵌进 README 会让每次访问
仓库首页都拉一遍原图，所以 README 只引用 `readme/` 里的副本，落地页继续用原图。
原图更新后需要重新生成副本，生成方式见本节末尾。

页面图标不在本目录：它引用 [`../favicon.svg`](../favicon.svg)，是仓库根目录 `icon.svg` 的复制品。
Pages 只发布 `/docs`，根目录那份站点取不到，所以复制了一份。**换图标时两处都要改**，
否则站点和仓库头像会不一致。

## 截图

三张图都是原图，**没有压缩**：用户明确要求保留原始截图质量。代价是 `wechat-chat.jpg` 有 1.5 MB，
页面首次加载会把它整个下载下来。如果要减重，先改这一节的约定再动文件。README 用的是 `readme/` 下的
压缩副本，所以减重只影响落地页，不影响仓库首页。

### 重新生成 README 副本

```bash
python scripts/make-readme-images.py
```

脚本只读 `docs/assets/` 里的原图、写 `docs/assets/readme/`，裁剪框写死在脚本里。原图换了构图要同时改裁剪框。
它需要 Pillow（`pip install pillow`），**不是** `pnpm install` 的一部分——本仓库的运行时不依赖它，只在改截图时手动跑一次。

展示方式见 [`site.css`](./site.css) 的 `/* screenshots */` 段，版式借自 dsh-plugins 落地页的 `.lp-shot`：
三点窗口栏 + 等宽标题 + 1px 外框。手机长图在卡片里固定高度、从顶部裁切，底部压一层渐隐，
完整内容点开 `<a target="_blank">` 看原图。**不要给长图设 `height: auto`**——
1200×6772 按栏宽铺满会把整页拉长约八千像素。

### 新增或替换截图时

- 手机长图加 `class="tall"`（卡内固定高度），桌面横图不加；套 `<a class="crop">` 才会有渐隐。
- 打码：微信昵称、头像、`~/.dsh` 路径里的用户名。
- 引用本目录的文件一律用相对路径（`assets/x.png`）；写成 `/assets/x.png` 会指到
  `wangx-wx.github.io` 根上并 404。

### 一个已知的重复边框

`plugin-page.png` 自带 macOS 红绿灯标题栏，外面又套了一层 `.shot-bar` 三点栏，视觉上像双框。
HTML 里因此**没有**给这张图加 `.shot-bar`（其余两张有）。这是取舍后的现状，不是遗漏：
去掉自带标题栏需要裁图，而截图按要求不加工。若以后换成不带标题栏的版本，补回 `.shot-bar` 保持一致。
