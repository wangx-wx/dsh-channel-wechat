# 插件市场索引

本目录发布一份[DSH 插件市场索引](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)，
让用户能在 DSH 插件页的**发现**标签页里搜到并安装本插件，而不必知道 npm 包名。

- **索引 URL**：`https://wangx-wx.github.io/dsh-channel-wechat/market/index.json`
- **托管**：GitHub Pages，源目录选仓库的 `/docs`，于是 `docs/market/index.json` 就是上面的地址。
- **内容**：只有 `dsh-channel-wechat` 一个插件，版本列表来自 npm 注册表。

## 为什么要自己发一份

DSH **没有官方市场**，`plugin-market` 服务默认不配置任何索引源（`indexes: []`），
所以「发现」页默认是空的，索引源属于用户数据。任何人发一份静态 JSON 就是一个市场。

## 怎么重新生成

索引不能手写：版本列表、发布时间、`engines.dsh` 都必须来自注册表里的真实 manifest，
`format` 的校验规则也不允许推测。用 DSH 仓库自带的参考生成器：

```sh
# 1. 一份来源列表，每行一个 npm 包名或 https Git 仓库 URL
printf 'dsh-channel-wechat\n' > /tmp/plugins.txt

# 2. 在 DSH 源码 checkout 里跑生成器（生成器不在本仓库的依赖里）
cd /path/to/deepseek-harness
./node_modules/.bin/tsx apps/plugin-market-generator/src/bin.ts \
  --input /tmp/plugins.txt \
  --output /path/to/dsh-channel-wechat/docs/market/index.json \
  --title "dsh-channel-wechat" \
  --description "DeepSeek Harness bundles published from this repository"
```

生成器只下载和读取文件，不安装、不执行任何包的代码。它会读注册表、按 SemVer 排序版本、
把 `engines.dsh` 原样搬进索引，最后用 `dsh-plugin-market-index` 校验输出。

`--cache` 默认写输入文件旁边的 `.plugin-market-cache`；本仓库不需要这个目录，
可以像上面那样省略（缓存会落到 `/tmp/plugins.txt` 旁边），确认后删掉即可。

**什么时候重新生成**：每次发版之后。索引里的版本列表和展示字段都取自 npm 上的包，
不重新生成就永远是旧版本。

## 索引里会显示什么

| 字段 | 来源 |
|---|---|
| `title` / `description` | 包在 npm 上**已发布版本**的 `locale/en.json`（没有则退回 `package.json` 的 `name` / `description`） |
| `icon` | `package.json` 的 `icon` 字段，或导出的 `./icon`；≤256 KiB 的 SVG/PNG/JPEG/WebP |
| `metadata.keywords` | 包 manifest 的 `keywords`，**已发布**的那份 |
| `versions[].engines.dsh` | 包 manifest 的 `engines.dsh`，原样复制 |
| `repository` / `homepage` | 包 manifest 的对应字段 |

所以**改 `package.json` 里这些字段要发版才会生效**。用 dry-run 观察时可以直接看
`npm view dsh-channel-wechat@<版本> keywords icon` 是否已经是新值。

## 校验

生成器写出前已经校验过一遍。想单独验一遍：

```sh
cd /path/to/deepseek-harness
./node_modules/.bin/tsx -e "
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { readFileSync } from 'node:fs'
const url = 'https://wangx-wx.github.io/dsh-channel-wechat/market/index.json'
const index = parseMarketIndex(JSON.parse(readFileSync('docs/market/index.json', 'utf8')), url)
console.log(index.plugins.map(p => p.name + ' ' + p.versions.length + ' versions'))
"
```

## 已知限制

- **索引没有签名**：标题、作者、`repository` 都是索引发布者的声明。DSH 只校验格式，
  真正装什么由被安装包的 manifest 决定。所以这份索引只应指向本仓库自己发布的包。
- **GitHub Pages 有延迟**：推上去之后要等 Pages 构建完成，`curl` 到 200 再让用户添加。
- **不加 `official` 之类的标签**：DSH 不验证标签语义，标了只会误导。
