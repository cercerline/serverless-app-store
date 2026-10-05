/**
 * Canonical site facts, in one place.
 *
 * Titles, descriptions and keyword lists appear in several routes (layout, app
 * detail, structured data, sitemap). Keeping them here means a positioning change
 * is one edit rather than a hunt through the tree.
 */

export const SITE_NAME = process.env.NEXT_PUBLIC_SITE_NAME?.trim() || "小凯奇 AI 应用商店";

/** The positioning line. Used in the title tag and social cards. */
export const SITE_TAGLINE = "分享和下载 AI 做的 app";

/** ≤ 155 characters, so search engines show it whole. */
export const SITE_DESCRIPTION =
  "小凯奇 AI 应用商店：上传、分享、下载用 AI 做的 Android APK 和网页应用。无需开发者账号，注册即可发布你的 AI 作品，全部免费下载。";

/**
 * Keyword list.
 *
 * Google ignores the keywords meta tag, but Baidu, Sogou and 360 still read it,
 * and those engines matter more than Google for a Chinese-language site.
 */
export const SITE_KEYWORDS = [
  "AI 应用商店",
  "AI 做的 app",
  "APK 下载",
  "安卓应用下载",
  "AI 生成应用",
  "个人开发者应用分发",
  "应用分发平台",
  "HTML 应用托管",
  "免费 APK 分发",
  "独立开发者",
  "AI 编程",
  "vibe coding",
  "小凯奇",
];

/**
 * Absolute base URL.
 *
 * Read from configuration so previews and local development do not advertise
 * themselves as the production site. Falls back to the apex domain, never to
 * `www`, which has no DNS record.
 */
export function siteUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "");
  return (configured || "https://xiaokaiqi.website").replace(/\/+$/, "");
}

/** Absolute URL for a path, for canonical tags and structured data. */
export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
