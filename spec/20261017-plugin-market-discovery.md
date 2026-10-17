# 需求规格：插件生态可见性（topic / 发现元数据 / 市场索引）

日期：2026-10-17
分支：`dev_ecosystem_261017`
状态：**开发中**

## 1. 背景

用户问「项目需要打什么标签可以和 dsh 关联起来，dsh 官方有介绍插件生态吗，如何建设呢」，
裁定「切一个分支做这个事情，先做 0-2 步」。

侦察结论（依据都来自 DSH 仓库，不是推测）：

| 问题 | 结论 | 证据 |
|---|---|---|
| 官方认的标签 | 只有一个：GitHub topic **`dsh-plugin`** | `README.zh.md:50`、`CONTRIBUTING.zh.md:15`，全仓库 `github.com/topics/` 链接只有这一处 |
| 官方市场 | **没有**，`pluginMarket` 默认 `indexes: []` | `docs/user/guide/plugin-market.zh.md`、`.agents/notes/implemented/feature/2026-10-02-plugin-market-discover.zh.md:9` |
| 市场机制 | 任何人发一份静态 JSON 索引即可 | 同上；`apps/plugin-market-generator` 是参考生成器 |
| 市场读什么字段 | `icon`、`locale/en.json`、`keywords`、`engines.dsh` | `packages/boot/app-boot/src/package-meta.ts:179`、索引格式 Agent Note |

本仓库此前只有 `dsh` / `deepseek-harness` 等关键词，没有 `dsh-plugin`；没有 `icon`；没有 `locale/`；
没有任何市场索引。

## 2. 范围（用户裁定的 0–2 步）

| 步骤 | 内容 | 本次是否做 |
|---|---|---|
| 第 0 步 | GitHub 仓库打 `dsh-plugin` topic；包 `keywords` 补 `dsh-plugin` | topic **用户自己做**，keywords 本次改 |
| 第 1 步 | 加 `icon.svg` + `locale/{en,zh}.json`，并接进 `exports` / `files` | 做 |
| 第 2 步 | 自己发一份市场索引，托管在 GitHub Pages | 做（Pages 开关由用户开） |
| 第 3 步 | 写文章 / Discussions 发帖 | **不做**，超出本次范围 |

## 3. 用户裁定（本规格的约束条件）

| 问题 | 裁定 |
|---|---|
| 索引托管 | **GitHub Pages，从仓库 `/docs` 目录发布** |
| 是否升版本 | **不升**（保持 `0.2.2`），改完推开发分支，之后自己处理 |
| 是否发布 | **本次不发布**，只提交源码 |
| topic | 用户自己打，不在本次改动内 |

## 4. 关键取舍

### 4.1 索引里的展示字段是「已发布版本」的快照

索引的 `title` / `description` / `icon` / `keywords` 由生成器从 **npm 注册表上已发布的包**读取，
不是从工作区读。因此本次改的 `icon`、`locale/`、新 keywords **在发版前不会出现在索引里**，
卡片仍显示包名 `dsh-channel-wechat`。这不是缺陷，是生成器的既有语义（索引是发布态的快照）。

处理：README 里写明这一点，避免下次有人以为索引没生效。

### 4.2 索引用手写还是用生成器

**用生成器**。手写要自己填每个版本的发布时间与 `engines.dsh`，而这些值必须与注册表一致；
`0.1.x` 那几个版本的 `engines.dsh` 是 `^0.2.0-rc.1`，和今天的 `>=0.2.0-rc.1` 不同，
手写必然写错。

代价：生成器不在本仓库依赖里，重生成要先有 DSH checkout。这个代价写进 `docs/market/README.md`。

### 4.3 不加 `official` 之类标签

DSH 不验证标签语义（索引格式 Agent Note 的「风险」一节明说 `official` 标签不是 DSH 验证）。
自标 `official` 只会误导用户，不采纳。

## 5. 验证方式

| 断言 | 方式 |
|---|---|
| 包内元数据能被 DSH 真的读出来 | 用 DSH 的 `readPluginMeta()` 对打包后的包跑一次，确认 title/description/icon 全部非空 |
| `icon`、`locale`、索引确实进了 tarball | `pnpm pack` 后 `tar -tzf` |
| 索引能被官方的 `parseMarketIndex()` 接受 | 用 `@deepseek-ai/dsh-plugin-market-index` 校验 |
| 索引与 manifest 不漂移 | `tests/unit/manifest.spec.ts` 新增 4 条断言（变异验证过） |
| 现有行为未破坏 | `pnpm test`（536 项）与 `pnpm typecheck` |

## 6. 不做的事

- 不写 `prepare` 脚本（本包不发 Git 安装给普通用户，`prepack` 已覆盖发布）。
- 不把生成器加进本仓库依赖（会引入 `@deepseek-ai/*` 的构建期依赖，违反分层纪律）。
- 不改 `engines.dsh`（本次不涉及兼容性变更）。
- 不动 `main` 分支上的工作。
