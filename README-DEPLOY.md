# 部署手册（零代码，约 15 分钟）

按顺序做完下面四步，你会得到一个可访问的线上地址和一套管理后台。
**全程不需要写任何代码**，只需要复制粘贴几个值、点几下按钮。

---

## 你需要准备什么

| 项目 | 说明 | 费用 |
| --- | --- | --- |
| Cloudflare 账号 | 用于存放 APK 文件（R2 对象存储） | 免费额度：10GB 存储，下载流量**完全免费** |
| Vercel 账号 | 用于运行网站（Serverless） | 免费额度足够个人/小团队使用 |
| Neon 账号 | PostgreSQL 数据库（存应用信息） | 免费额度 0.5GB |
| 一个 APK 文件 | 用来测试上传 | — |

> 三个账号都可以用邮箱或 GitHub 直接注册，不需要信用卡。

---

## 第 1 步：创建数据库（Neon）

1. 打开 <https://neon.com>，注册并登录。
2. 点击 **Create project**，名字随意（例如 `apk-store`），区域选离你用户最近的（例如 `Asia Pacific`）。
3. 创建完成后，页面会显示 **Connection string**。点击复制按钮，你会得到类似这样的一串：

   ```
   postgresql://<你的用户名>:<你的密码>@ep-你的主机名-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```

   （尖括号里是你要填的真实值；`ep-xxx-pooler` 那一段由 Neon 生成，不是你自己起的名字）

4. **重要**：确认这串地址里包含 `-pooler` 字样。如果没有，请点 **Connect** 按钮，在弹窗里选择 **Pooled connection** 再复制。

5. 把这串地址暂时存到记事本，后面要用。我们称它为 **数据库连接串**。

> 表结构不需要你手动创建：网站第一次被访问时会自动建表。

---

## 第 2 步：创建对象存储（Cloudflare R2）

1. 打开 <https://dash.cloudflare.com>，注册并登录。
2. 左侧菜单找到 **R2**，点击进入。首次使用需要点 **Enable R2**（免费开通，**不需要绑卡**）。
3. 点击 **Create bucket**：
   - **Bucket name**：填一个全局唯一的名字，例如 `my-apk-bucket`
   - 其他保持默认，点击 **Create bucket**
4. 回到 R2 首页，记下右侧的 **Account ID**（一串 32 位字符）。我们称它为 **R2_ACCOUNT_ID**。
5. 创建访问密钥：在 R2 页面点击 **Manage API Tokens**（或右上角 **API** → **Manage API tokens**），然后：
   - 点击 **Create API token**
   - **Token name**：随便填，例如 `apk-store-token`
   - **Permissions**：选择 **Object Read & Write**
   - **Specify bucket**：**务必**选中你刚创建的那个存储桶（例如 `my-apk-bucket`）
   - 点击 **Create API token**
6. 页面会显示两组值，**只显示这一次，请立刻复制**：
   - **Access Key ID** → 记为 **R2_ACCESS_KEY_ID**
   - **Secret Access Key** → 记为 **R2_SECRET_ACCESS_KEY**

现在你手上有 4 个值：

```
R2_ACCOUNT_ID         = （32 位账户 ID）
R2_ACCESS_KEY_ID      = （刚复制的 Access Key ID）
R2_SECRET_ACCESS_KEY  = （刚复制的 Secret Access Key）
R2_BUCKET             = my-apk-bucket（你创建的存储桶名）
```

> 可选但推荐：给存储桶绑定自定义域名后，图标和截图会由 R2 直接提供，速度更快、消耗更少。
> 在存储桶的 **Settings → Public access → Custom Domains** 里绑定一个你自己的域名即可。
> 没有域名也不影响使用，保持留空即可。

---

## 第 2 步补充（**必做**）：给存储桶加 CORS 规则

**这一步不能跳过。** 跳过的话网站能打开、能登录，但**上传 APK 时会失败**，浏览器只报一句含糊的
`Failed to fetch`，极难排查。

原因：APK 由浏览器**直传**到 R2（这样才能绕开 Vercel 4.5MB 的请求体限制）。浏览器在跨域上传前
会先发一个「预检请求」，而 R2 存储桶默认没有任何 CORS 规则，请求就被拒了。

1. 进入你的存储桶 → 顶部标签切到 **Settings**（背景设定）
2. 找到 **CORS Policy**（CORS 策略）→ 点 **Add CORS policy**（添加 CORS 策略）
3. 粘贴以下内容并保存：

   ```json
   [
     {
       "AllowedOrigins": ["*"],
       "AllowedMethods": ["PUT", "GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

> `AllowedOrigins` 用 `*` 而不是写死域名：预签名上传地址**本身就是一次性凭证**（默认 1 小时过期，
> 只发给已登录的管理员），真正的安全边界是那个签名。写死域名会导致将来绑定自定义域名时
> 上传突然失效，且极难排查。

**验证是否生效**（会模拟浏览器发一次预检请求）：

```bash
node scripts/r2-cors.mts
```

看到 `access-control-allow-origin: *` 即配置成功。

> 注意：`node scripts/r2-cors.mts apply` 需要「Admin Read & Write」权限的 R2 密钥才能通过 API
> 写入；只有「Object Read & Write」权限时请按上面的网页步骤操作。

---

## 第 3 步：部署到 Vercel

### 3.1 打开终端

在项目文件夹 `app-store` 里打开终端（Windows：在文件夹地址栏输入 `powershell` 回车）。

### 3.2 安装依赖

```bash
npm install
```

### 3.3 检查配置（可选但强烈建议）

先把上一步的 4 个值填进 `.env.local`，然后运行自检：

```bash
npm run doctor
```

它会真实连接你的数据库和 R2 做一次读写测试，并指出任何遗漏。全部显示 `✓` 就可以继续。

### 3.4 部署

```bash
npm run deploy -- --prod
```

这个命令会：

1. 自动运行一次配置自检；
2. 如果没有安装 Vercel 工具，会自动帮你装好；
3. **打开浏览器**让你登录 Vercel（用邮箱/GitHub 注册即可，免费）；
4. 在终端里问你几个问题，一路按 **回车** 用默认值即可；
5. 部署完成后，终端会打印一个网址，形如：

   ```
   https://apk-dist-xxxx.vercel.app
   ```

**这就是你的线上地址。** 先复制保存。

> 此时打开网址会看到一个黄色提示，说还没配置数据库 —— 这是正常的，
> 因为环境变量还没填。继续下一步。

### 3.5 填入环境变量

1. 打开 <https://vercel.com/dashboard>，点击你刚部署的项目。
2. 顶部菜单进入 **Settings** → 左侧 **Environment Variables**。
3. 逐个添加下面这些变量（**Name** 和 **Value** 分别填入，Environment 保持默认全选）：

| Name | Value |
| --- | --- |
| `DATABASE_URL` | 第 1 步的**数据库连接串** |
| `R2_ACCOUNT_ID` | 第 2 步的账户 ID |
| `R2_ACCESS_KEY_ID` | 第 2 步的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | 第 2 步的 Secret Access Key |
| `R2_BUCKET` | 你的存储桶名 |
| `ADMIN_USERNAME` | `admin`（或你想要的用户名） |
| `ADMIN_PASSWORD` | **你自己设定的管理员密码**（请记牢） |

4. 全部添加完后，进入 **Deployments** 标签页，点击最新一条右侧的 **⋯** → **Redeploy** → 确认。

> 每次修改环境变量都必须重新部署一次才会生效。

---

## 第 4 步：开始使用

### 管理员登录

- 入口：`https://你的域名/admin`
- 用户名：你填的 `ADMIN_USERNAME`（默认 `admin`）
- 密码：你填的 `ADMIN_PASSWORD`

### 上传第一个应用

1. 登录后台后，先选择**应用类型**：
   - **Android 应用 (APK)** —— 用于 `.apk` 文件
   - **Web 应用 (HTML/ZIP)** —— 用于单个 `.html` 文件或 `.zip` 前端包
2. 点击 **选择 APK 文件**（或 **选择 HTML / ZIP 文件**），选中你的文件。
3. 如果是 APK，系统会**自动解析**出应用名称、包名、版本号、所需权限，并**自动提取应用图标**。
   上传进度条走完后，表单已经填好了。Web 应用则只需手动填写名称。
4. 检查一下信息，可以修改、补充「一句话简介」和「详细介绍」。
5. 需要的话点击 **上传截图** 添加应用截图（可多选）。
6. 点击 **保存并发布**。
7. 回到首页 `https://你的域名/`，就能看到这个应用了：
   - APK 应用点进去可以**下载**
   - Web 应用点进去可以**在新标签页直接运行**

### 常用操作

| 我想… | 怎么做 |
| --- | --- |
| 修改应用信息 | 后台右侧列表点该应用的 **编辑**，改完点 **保存修改** |
| 更新版本 | 点 **编辑**，再点 **重新选择文件** 上传新文件，然后保存 |
| 临时下架应用 | 编辑时取消勾选「在应用库中公开展示」，保存 |
| 删除应用 | 后台列表点 **删除**（会同时删除文件与图片，不可恢复） |
| 换管理员密码 | 在 Vercel 修改 `ADMIN_PASSWORD`，然后 Redeploy |

---

## 常见问题

**Q：打开网站显示「还差一步：连接数据库」**
`DATABASE_URL` 没填或填错了。确认它包含 `-pooler` 和 `?sslmode=require`，改完记得 **Redeploy**。

**Q：后台上传 APK 时提示「未配置对象存储」**
R2 的 4 个变量没填全。注意 `R2_BUCKET` 填的是**存储桶名字**，不是账户 ID。

**Q：上传大文件（100MB+）失败**
Vercel 免费版单个请求体上限 4.5MB，但本项目采用**浏览器直传 R2** 的方式，APK 不经过 Vercel，所以不受此限制。如果失败，通常是 R2 密钥权限不足 —— 请确认创建 Token 时选了 **Object Read & Write** 并**指定了正确的存储桶**。

**Q：图标或截图不显示**
如果是刚上传的，刷新一下页面。若持续不显示，检查 R2 Token 是否有读取权限。

**Q：下载 APK 时浏览器提示「危险文件」**
这是浏览器对 APK 的通用安全策略，与本站无关。用户需在「下载内容」里选择「保留」。

**Q：下载量大，会产生费用吗？**
R2 的**下载流量完全免费**，这是本项目选择 R2 而不是 Vercel Blob 的原因。Vercel 免费版的函数调用额度对一般访问量足够；若下载量极大，可考虑给 R2 绑定自定义域名，让文件由 R2 直接提供、彻底不经过 Vercel。

**Q：想绑定自己的域名**
Vercel 项目 → **Settings → Domains** → 添加你的域名并按提示配置 DNS。

**Q：想改站点名称**
在 Vercel 添加环境变量 `NEXT_PUBLIC_SITE_NAME`，值为你想要的名称，然后 Redeploy。

---

## 安全建议

1. **务必设置一个强密码**（12 位以上，含大小写与数字）。公开的 `/admin` 入口会被自动扫描。
2. 密码建议用哈希存放，更安全：
   ```bash
   npm run admin:hash "你的密码"
   ```
   把输出的整行作为 `ADMIN_PASSWORD_HASH` 填进 Vercel，并删除 `ADMIN_PASSWORD`。
3. `.env.local` 已被 `.gitignore` 排除，**不要**把密钥提交到 Git 或发给他人。
4. 只上传你有权分发的 APK。公开分发他人应用可能涉及侵权。

---

## 附：本地预览（可选）

想先在电脑上看看效果，不部署：

```bash
npm install
npm run dev
```

然后浏览器打开 <http://localhost:3000>。
未配置任何环境变量时，网站仍可运行，但数据存在内存里，重启即清空 —— 仅用于看界面。
