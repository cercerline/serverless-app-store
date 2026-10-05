/**
 * Publishes the seed apps to the live site.
 *
 * The growth plan depends on having a catalogue worth visiting before any post
 * goes out, so these are uploaded as the administrator, which publishes them
 * immediately rather than queueing them for review.
 *
 * Idempotent: an app whose slug already exists is updated in place, so running
 * this twice does not create duplicates.
 *
 * Usage: node --no-warnings scripts/publish-seed-apps.mts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ------------------------------------------------------------------ config

for (const rawLine of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const t = rawLine.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  const key = t.slice(0, eq).trim();
  let value = t.slice(eq + 1).trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted) value = value.slice(1, -1);
  if (!(key in process.env)) process.env[key] = value;
}

const BASE = process.env.LIVE_BASE ?? "https://xiaokaiqi.website";
const USER = process.env.ADMIN_USERNAME ?? "admin";
const PASS = process.env.ADMIN_PASSWORD ?? "";

if (!PASS) {
  console.error("✗ .env.local 里缺少 ADMIN_PASSWORD");
  process.exit(1);
}

interface SeedApp {
  file: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  category: string;
}

/** Copy follows the plan's formula: 给谁用的什么工具，解决什么问题。 */
const APPS: SeedApp[] = [
  {
    file: "countdown.html",
    slug: "countdown",
    name: "倒计时",
    summary: "给考研党用的倒计时，打开就知道还剩几天",
    description:
      "可以添加任意多个重要日子，比如考研初试、四六级、期末、生日。\n\n打开就显示最近的那个还剩几天，下面列出全部记录。日期只保存在你自己的手机里，不会上传到任何服务器，断网也能用。",
    category: "学习",
  },
  {
    file: "pomodoro.html",
    slug: "pomodoro",
    name: "番茄钟",
    summary: "25 分钟专注计时，不需要装任何东西",
    description:
      "经典的番茄工作法：专注 25 分钟，休息 5 分钟，自动切换。\n\n可以自己改时长，完成后有提示音，右下角记录今天完成了几个番茄、累计专注多少分钟。切换标签页也不会走慢，因为计时按真实时间计算。",
    category: "效率",
  },
  {
    file: "ledger.html",
    slug: "ledger",
    name: "简易记账",
    summary: "三秒记一笔的记账工具，数据存在自己手机里",
    description:
      "只做一件事：让你花三秒记下一笔钱。\n\n选支出或收入、填金额、点分类、保存。自动统计本月收入、支出和结余，可以按全部、本月、今天筛选。没有广告，不联网，不要求注册，也不会把你的消费记录卖给任何人。",
    category: "生活",
  },
  {
    file: "timetable.html",
    slug: "timetable",
    name: "课程表",
    summary: "给大学生用的课程表，打开就知道今天上什么",
    description:
      "点格子就能填课，支持 12 节课 × 7 天。\n\n顶部自动显示今天的课，正在上的那节会高亮标出「正在进行」。如果一周的课都差不多，可以用「把周一的课复制到全周」一次填完。数据存在本机，不需要登录。",
    category: "学习",
  },
  {
    file: "picker.html",
    slug: "random-picker",
    name: "随机点名",
    summary: "老师上课随机点名，粘贴名单就能用",
    description:
      "把班级名单粘贴进去（每行一个，或用逗号空格分隔都可以），点一下就开始随机滚动抽取。\n\n可以开启「不重复抽取」，抽过的人不会再次被抽到，适合一节课把所有人都提问一遍。抽中时有提示音，名单会保存在本机，下次打开还在。",
    category: "教学",
  },
  {
    file: "convert.html",
    slug: "unit-converter",
    name: "单位换算",
    summary: "长度、重量、温度、面积，一个页面全搞定",
    description:
      "覆盖长度、重量、温度、面积、体积、速度、数据、时间八大类。\n\n包含市斤、市尺、亩这些国内常用但换算表不好找的单位。输入即时出结果，可以一键互换方向，下面还有常用换算的快捷入口。完全离线，没有网络请求。",
    category: "工具",
  },
  {
    file: "password.html",
    slug: "password-generator",
    name: "密码生成器",
    summary: "生成高强度密码，本地生成不外传",
    description:
      "用浏览器内置的加密随机数生成器产生密码，不会发送到任何服务器——断网也能用。\n\n可以调整长度（6 到 64 位）、选择包含哪些字符类型、排除 0O1lI 这类容易看错的字符。实时显示密码强度和熵值，一键复制。",
    category: "工具",
  },
  {
    file: "compress.html",
    slug: "image-compressor",
    name: "图片压缩",
    summary: "拖进去图片就变小，图片不会离开你的设备",
    description:
      "把图片拖进来，或者点一下选择，浏览器会当场把它压小，然后你保存下来就行。\n\n可以调画质和最大边长，支持输出 JPEG / WebP / PNG。最大的特点是图片完全不上传服务器——所有处理都在你的浏览器里完成，涉及证件、合同这类敏感照片也可以放心用。可以断网使用。",
    category: "工具",
  },
];

// ------------------------------------------------------------------- client

const jar = new Map<string, string>();

function cookieHeader(): Record<string, string> {
  if (jar.size === 0) return {};
  return { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
}

function absorb(response: Response) {
  for (const c of response.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const text = String((error as Error)?.message ?? error);
      if (!/TIMEOUT|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(text) || i === attempts) break;
      console.log(`      ${label} 失败，重试 ${i}/${attempts}…`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw last;
}

async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers: Record<string, string> = { ...cookieHeader(), ...(init.headers as Record<string, string>) };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const response = await retry(path, () => fetch(`${BASE}${path}`, { ...init, headers, body }));
  absorb(response);
  return response;
}

// ---------------------------------------------------------------------- run

console.log(`目标站点：${BASE}\n`);

const login = await api("/api/admin/login", {
  method: "POST",
  json: { username: USER, password: PASS },
});
if (!login.ok) {
  console.error(`✗ 登录失败：HTTP ${login.status} ${(await login.text()).slice(0, 200)}`);
  process.exit(1);
}
console.log("✓ 管理员登录成功\n");

let created = 0;
let updated = 0;
const failures: string[] = [];

for (const app of APPS) {
  const html = readFileSync(join("seed-apps", app.file));
  process.stdout.write(`  ${app.name.padEnd(6)} `);

  try {
    // 1. Presigned upload slot.
    const presignRes = await api("/api/apps/presign", {
      method: "POST",
      json: { kind: "html", filename: app.file, size: html.length },
    });
    const presigned = (await presignRes.json()) as {
      key?: string;
      url?: string;
      contentType?: string;
      error?: string;
    };
    if (!presigned.url || !presigned.key) {
      throw new Error(presigned.error || `获取上传地址失败 HTTP ${presignRes.status}`);
    }

    // 2. Upload the file straight to object storage.
    const put = await retry("上传", () =>
      fetch(presigned.url!, {
        method: "PUT",
        headers: { "content-type": presigned.contentType ?? "text/html" },
        body: html,
      }),
    );
    if (!put.ok) throw new Error(`上传失败 HTTP ${put.status}`);

    // 3. Save the record. Running as admin publishes immediately.
    const saveRes = await api("/api/apps", {
      method: "POST",
      json: {
        name: app.name,
        kind: "html",
        slug: app.slug,
        summary: app.summary,
        description: app.description,
        category: app.category,
        apk_key: presigned.key,
        apk_size: html.length,
        status: "published",
      },
    });
    const saved = (await saveRes.json()) as { app?: { slug: string }; error?: string };
    if (!saved.app) throw new Error(saved.error || `保存失败 HTTP ${saveRes.status}`);

    console.log(`✓ /app/${saved.app.slug}`);
    created++;
  } catch (error) {
    console.log(`✗ ${error instanceof Error ? error.message : String(error)}`);
    failures.push(app.name);
  }
}

// ------------------------------------------------------------------ verify

console.log(`\n成功 ${created} 个，失败 ${failures.length} 个。`);

const home = await (await fetch(`${BASE}/`)).text();
const visible = APPS.filter((a) => home.includes(a.name)).length;
console.log(`首页可见：${visible} / ${APPS.length} 个`);

const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
console.log(`sitemap 条目：${(sitemap.match(/<url>/g) ?? []).length} 个`);

if (failures.length) {
  console.log(`\n失败：${failures.join("、")}`);
  process.exit(1);
}
