import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { SITE_DESCRIPTION, SITE_KEYWORDS, SITE_NAME, SITE_TAGLINE, siteUrl } from "@/lib/site";
import "./globals.css";

const siteName = SITE_NAME;

export const metadata: Metadata = {
  // Makes every relative URL below resolve to an absolute one, which is what
  // crawlers and social cards require.
  metadataBase: new URL(siteUrl()),
  title: {
    default: `${siteName} — ${SITE_TAGLINE}`,
    template: `%s · ${siteName}`,
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: siteName,
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  openGraph: {
    type: "website",
    siteName,
    locale: "zh_CN",
    url: siteUrl(),
    title: `${siteName} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: `${siteName} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: "#070b14",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the session here makes the nav reflect who is signed in. It also
  // makes every route dynamic, which is already true for the catalogue and the
  // consoles; only the 404 page loses static rendering.
  const session = await getSession();

  return (
    <html lang="zh-CN">
      <body className="antialiased">
        <div className="flex min-h-dvh flex-col">
          <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-950/80 backdrop-blur">
            <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3">
              <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-500/15 text-brand-400">
                  <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.5 3.6L12 11.5 5.5 7.9 12 4.3ZM5 9.7l6 3.3v6.3l-6-3.3V9.7Zm8 9.6V13l6-3.3v6.3l-6 3.3Z"
                    />
                  </svg>
                </span>
                <span>{siteName}</span>
              </Link>
              <nav className="ml-auto flex items-center gap-1 text-sm">
                <Link
                  href="/"
                  className="rounded-lg px-3 py-1.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
                >
                  应用库
                </Link>
                {session ? (
                  <>
                    <Link
                      href={session.role === "admin" ? "/admin" : "/dashboard"}
                      className="rounded-lg border border-white/10 px-3 py-1.5 text-slate-300 transition hover:border-brand-500/40 hover:text-white"
                    >
                      {session.role === "admin" ? "管理后台" : "我的应用"}
                    </Link>
                    <Link
                      href="/submit"
                      className="rounded-lg bg-brand-500 px-3 py-1.5 font-semibold text-ink-950 transition hover:bg-brand-400"
                    >
                      上传应用
                    </Link>
                  </>
                ) : (
                  <>
                    <Link
                      href="/login"
                      className="rounded-lg px-3 py-1.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
                    >
                      登录
                    </Link>
                    <Link
                      href="/register"
                      className="rounded-lg bg-brand-500 px-3 py-1.5 font-semibold text-ink-950 transition hover:bg-brand-400"
                    >
                      上传我的应用
                    </Link>
                  </>
                )}
              </nav>
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>

          <footer className="border-t border-white/10 py-6">
            <div className="mx-auto w-full max-w-6xl space-y-2 px-4 text-xs text-slate-500">
              <p className="leading-relaxed">
                <span className="text-slate-400">免责声明：</span>
                本站为应用存储与分发平台，所有应用由用户自行上传，本站不开发、不修改、不担保其内容与安全性。
                上传者须保证拥有合法权利且内容不含恶意代码，因上传内容引发的责任由上传者承担。
                如发现侵权或恶意应用，请通过管理员邮箱告知，本站将立即下架。
              </p>
              <p>
                <Link href="/terms" className="text-brand-400/80 hover:text-brand-300 hover:underline">
                  阅读完整免责声明与使用条款
                </Link>
                <span className="mx-2">·</span>
                <span>安装任何应用前，请自行判断来源是否可信。</span>
              </p>
              <p>Serverless 架构 · Vercel + Cloudflare R2</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
