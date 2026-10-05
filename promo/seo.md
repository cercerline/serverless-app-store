# SEO 必做清单

**站点**：https://xiaokaiqi.website
**状态**：技术项已全部部署完成（下方标 ✅ 的都是我做好的，不需要你动手）

> ⚠️ **所有外链统一用 `https://xiaokaiqi.website`**，不要用 `www.` —— `www` 子域名没有 DNS 记录，打不开。

---

## 一、首页

### 已部署的内容 ✅

| 项目 | 当前值 |
|---|---|
| **title** | `小凯奇 AI 应用商店 — 分享和下载 AI 做的 app` |
| **description** | `小凯奇 AI 应用商店：上传、分享、下载用 AI 做的 Android APK 和网页应用。无需开发者账号，注册即可发布你的 AI 作品，全部免费下载。` |
| **H1** | `AI 应用库` |
| **keywords** | `AI 应用商店, AI 做的 app, APK 下载, 安卓应用下载, AI 生成应用, 个人开发者应用分发, 应用分发平台, HTML 应用托管, 免费 APK 分发, 独立开发者, AI 编程, vibe coding, 小凯奇` |
| **canonical** | `https://xiaokaiqi.website` |
| **og:title / og:description / og:image / og:type** | ✅ 已配 |
| **twitter:card** | `summary_large_image` |
| **JSON-LD** | `WebSite` + `Organization` + `SearchAction` |

**首页社交分享卡片**（V2EX、即刻、微信、X 分享链接时显示的图）：
`https://xiaokaiqi.website/opengraph-image` — 1200×630，自动生成

### 你要做的

| # | 动作 | 地址 |
|---|---|---|
| 1 | 注册 Google Search Console，验证站点 | https://search.google.com/search-console |
| 2 | 提交 sitemap | 验证后在 Sitemaps 里填 `sitemap.xml` |
| 3 | 注册 Bing 站长工具，同样提交 sitemap | https://www.bing.com/webmasters |
| 4 | 注册百度搜索资源平台（中文流量最重要） | https://ziyuan.baidu.com/site |
| 5 | 注册 360 站长平台 | https://zhanzhang.so.com |
| 6 | 注册搜狗站长平台 | https://zhanzhang.sogou.com |

**验证方式选哪个**：选「HTML 标签」最简单——把给的那行 `<meta name="google-site-verification" ...>` 发给我，我加到代码里重新部署。

---

## 二、sitemap ✅ 已部署

**地址**：`https://xiaokaiqi.website/sitemap.xml`

当前状态：自动生成，返回 200，包含首页 + 条款页 + 全部已发布应用。

**特性**：
- 新应用发布后**自动进入 sitemap**，不需要手动提交
- 待审核 / 已驳回的应用**不会**进入（避免搜索引擎收录未审核内容）
- 数据库故障时仍返回首页条目，不会整个 500

**验证方式**：浏览器打开 `https://xiaokaiqi.website/sitemap.xml`，应该看到 `<url>` 列表。

---

## 三、robots.txt ✅ 已部署

**地址**：`https://xiaokaiqi.website/robots.txt`

**当前内容**：
```
User-Agent: *
Allow: /
Disallow: /admin
Disallow: /admin/
Disallow: /dashboard
Disallow: /api/
Disallow: /download/
Disallow: /login
Disallow: /register
Disallow: /submit
Disallow: /view/

User-Agent: AhrefsBot
Disallow: /

User-Agent: SemrushBot
Disallow: /

User-Agent: MJ12bot
Disallow: /

User-Agent: DotBot
Disallow: /

Sitemap: https://xiaokaiqi.website/sitemap.xml
```

**为什么屏蔽 /download/**：下载地址是带签名的临时链接，被搜索引擎抓取会白白消耗流量。

---

## 四、应用详情页 SEO 模板

### 已部署的自动模板 ✅

每上传一个应用，以下内容**自动生成**，不需要手填：

| 字段 | 生成规则 | 示例 |
|---|---|---|
| **title** | `{应用名} v{版本} 下载 · 小凯奇 AI 应用商店` | `考研默写 v0.1.0 下载 · 小凯奇 AI 应用商店` |
| **description** | `{简介}（版本 X · Y MB · 分类）Android 应用，免费下载 APK。` | 见下 |
| **keywords** | `{应用名}, {包名}, {分类}, APK 下载, AI 应用` | — |
| **canonical** | `/app/{slug}` | `https://xiaokaiqi.website/app/kaoyan-moxie` |
| **og:image** | 自动生成该应用专属分享卡（1200×630） | `/app/{slug}/opengraph-image` |
| **JSON-LD** | `SoftwareApplication` + 价格 0 元 + 版本 + 文件大小 + 运行平台 | — |

**description 完整示例**：
```
英语句子扩写app（版本 0.1.0 · 18 MB · 工具）Android 应用，免费下载 APK。
```

### 上传时你要填好的字段（决定 SEO 效果）

| 字段 | 必填 | 怎么写 | 反例 |
|---|---|---|---|
| **应用名称** | ✅ | 短、好记、能搜到 | ❌ `aaa测试版最终版2` |
| **一句话简介** | ✅ | **谁在什么场景用** | ❌ `很好用的app` ✅ `考研党每天早上背 20 个单词` |
| **分类** | ✅ | 从下拉选，别乱填 | ❌ 全部选「其他」 |
| **详细介绍** | 建议填 | 3–5 句，写清功能和适用人群 | 留空 |
| **版本号** | ✅ | 自动从 APK 读出 | — |

**简介写法公式**：
```
给【谁】用的【什么工具】，能【解决什么问题】。
```

举例：
- ✅ `给考研党用的倒计时，打开就知道还剩几天`
- ✅ `老师上课随机点名，导入名单就能用`
- ✅ `三秒记一笔的记账工具，数据存在自己手机里`

### 一个真实的应用页 SEO 现状

`https://xiaokaiqi.website/app/app-922efdf9`

```
title       考研默写 v0.1.0 下载
description 英语句子扩写app（版本 0.1.0 · 18 MB · 工具）Android 应用，免费下载 APK。
canonical   https://xiaokaiqi.website/app/app-922efdf9
og:image    https://xiaokaiqi.website/app/app-922efdf9/opengraph-image
JSON-LD     SoftwareApplication
```

> ⚠️ **URL 是 `app-922efdf9` 这种随机串，对 SEO 不利。**
> 上传时**手动在「slug」字段填英文名**（如 `kaoyan-moxie`），URL 就会变成
> `https://xiaokaiqi.website/app/kaoyan-moxie`，既好看又利于搜索。
> 现有两个应用的 URL 已经固定，除非删掉重传。

---

## 五、提交给 AI 搜索引擎（新兴渠道，5 分钟）

AI 助手越来越多被用来找工具，让它们能读到你的站：

| 平台 | 提交地址 | 说明 |
|---|---|---|
| ChatGPT / OpenAI | 无法主动提交 | 依赖 `robots.txt`，已允许 GPTBot |
| Perplexity | https://www.perplexity.ai | 无提交入口，靠被引用 |
| 百度 AI 搜索 | 随百度站长平台 | 已覆盖 |

**结论：不需要额外操作。** `robots.txt` 里没有屏蔽任何 AI 爬虫，它们可以正常抓取。

---

## 六、上线后的 SEO 检查清单

部署完成后，逐项打勾：

- [ ] `https://xiaokaiqi.website/robots.txt` 返回 200，内容正确
- [ ] `https://xiaokaiqi.website/sitemap.xml` 返回 200，能看到应用 URL
- [ ] `https://xiaokaiqi.website/opengraph-image` 返回 200，是一张图
- [ ] 首页查看源代码，能看到 `og:title`、`og:image`、`canonical`
- [ ] 应用详情页查看源代码，能看到 `SoftwareApplication` 的 JSON-LD
- [ ] 微信里发一次链接，确认预览卡片正常显示
- [ ] 手机浏览器打开，确认布局正常
- [ ] Google Search Console 已提交 sitemap
- [ ] 百度站长平台已提交 sitemap

### 在线验证工具

| 工具 | 地址 | 查什么 |
|---|---|---|
| Google 富媒体测试 | https://search.google.com/test/rich-results | JSON-LD 是否正确 |
| Facebook 分享调试 | https://developers.facebook.com/tools/debug/ | 分享卡片 |
| Twitter 卡片验证 | https://cards-dev.twitter.com/validator | X 上的卡片 |
| 微信卡片调试 | 直接在微信里发给自己 | 中文场景最重要 |
| PageSpeed | https://pagespeed.web.dev/ | 加载速度 |

---

## 七、内容 SEO（长期，30 天后开始）

应用详情页能拿到的自然搜索很有限。真正的自然流量来自**内容页**：

| 内容类型 | 例子 | 目标关键词 |
|---|---|---|
| 合集页 | 「10 个免费的考研小工具」 | 考研 app 免费 |
| 教程页 | 「怎么把 AI 做的 app 发给朋友」 | ai 做的 app 怎么分享 |
| 对比页 | 「不上架应用商店的 5 种分发方式」 | apk 分发 |

**做法**：在 `promo/` 之外新建内容目录，每篇 800–1500 字，底部放站内应用链接。

**优先级**：先做 3 篇合集页，比做 30 篇教程有效。

---

## 八、当前 SEO 状态总览

| 项目 | 状态 |
|---|---|
| 首页 title | ✅ 已优化 |
| 首页 description | ✅ 已优化（≤155 字符） |
| 首页 keywords | ✅ 已填（百度/搜狗/360 有效） |
| canonical | ✅ 已配 |
| og:title / description / image / type | ✅ 已配 |
| twitter:card | ✅ 已配 |
| JSON-LD（WebSite / Organization / SearchAction） | ✅ 已配 |
| JSON-LD（SoftwareApplication） | ✅ 已配 |
| 社交分享卡片（站点级） | ✅ 自动生成 1200×630 |
| 社交分享卡片（应用级） | ✅ 自动生成 1200×630 |
| sitemap.xml | ✅ 自动生成 |
| robots.txt | ✅ 已配 |
| 应用页 title 模板 | ✅ 自动生成 |
| 应用页 description 模板 | ✅ 自动生成 |
| www 子域名 | ❌ **无 DNS 记录，需要去阿里云加 CNAME** |
| 搜索引擎提交 | ❌ **需要你手动操作（见第一节表格）** |
| 内容页 | ❌ 未做，建议 30 天后开始 |
