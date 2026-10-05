import { Suspense } from "react";
import Link from "next/link";
import { AppCard } from "@/components/AppCard";
import { SearchBox } from "@/components/SearchBox";
import { isDatabaseConfigured, listApps } from "@/lib/db";
import { JsonLd, websiteJsonLd } from "@/lib/structured-data";

export const dynamic = "force-dynamic";

interface HomeProps {
  searchParams: Promise<{ q?: string }>;
}

/** Setup instructions shown before the database is configured. */
function SetupNotice() {
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
      <h2 className="text-lg font-semibold text-amber-200">还差一步：连接数据库</h2>
      <p className="mt-2 text-sm leading-relaxed text-amber-100/80">
        站点已经跑起来了，但还没有数据库连接串，所以应用列表是空的。在 Vercel 项目的
        <span className="mx-1 rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs">Settings → Environment Variables</span>
        中新增一项：
      </p>
      <ul className="mt-3 space-y-2 text-sm text-amber-100/80">
        <li>
          <code className="rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs">DATABASE_URL</code>
          <span className="mx-2">·</span>
          值为 Neon / Vercel Postgres 的连接串（形如
          <code className="mx-1 rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs">postgresql://…</code>）
        </li>
      </ul>
      <p className="mt-3 text-sm text-amber-100/80">
        保存后重新部署一次即可，数据表会在首次访问时自动创建。
      </p>
    </div>
  );
}

function EmptyState({ searching, query }: { searching: boolean; query?: string }) {
  if (searching) {
    return (
      <div className="rounded-2xl border border-white/10 bg-ink-900/50 p-10 text-center">
        <p className="text-slate-300">
          没有找到与 <span className="font-semibold text-white">“{query}”</span> 匹配的应用
        </p>
        <Link href="/" className="mt-3 inline-block text-sm text-brand-400 hover:underline">
          清除搜索条件
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-ink-900/50 p-10 text-center">
      <p className="text-slate-300">应用库还是空的</p>
      <p className="mt-2 text-sm text-slate-500">
        进入
        <Link href="/admin" className="mx-1 text-brand-400 hover:underline">
          管理后台
        </Link>
        上传第一个 APK。
      </p>
    </div>
  );
}

export default async function HomePage({ searchParams }: HomeProps) {
  const params = await searchParams;
  const query = params.q?.trim() || "";

  if (!isDatabaseConfigured()) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">应用库</h1>
        <SetupNotice />
      </div>
    );
  }

  let apps: Awaited<ReturnType<typeof listApps>> = [];
  let loadError: string | null = null;

  try {
    apps = await listApps({ query, limit: 120 });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "读取应用列表失败。";
  }

  return (
    <div className="space-y-6">
      <JsonLd json={websiteJsonLd()} />
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {query ? "搜索结果" : "AI 应用库"}
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              {query
                ? `“${query}” 共 ${apps.length} 个结果`
                : `共 ${apps.length} 个已发布应用，全部由用户用 AI 制作并免费分享`}
            </p>
          </div>
          <div className="w-full sm:w-80">
            <Suspense fallback={<div className="h-11 rounded-xl border border-white/10 bg-ink-900/70" />}>
              <SearchBox initialQuery={query} />
            </Suspense>
          </div>
        </div>
      </section>

      {loadError ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-200">
          <p className="font-semibold">读取数据库失败</p>
          <p className="mt-1 break-anywhere opacity-80">{loadError}</p>
          <p className="mt-2 opacity-80">
            请确认 <code className="rounded bg-black/30 px-1 font-mono">DATABASE_URL</code> 是否正确、
            数据库是否可访问。
          </p>
        </div>
      ) : apps.length === 0 ? (
        <EmptyState searching={Boolean(query)} query={query} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {apps.map((app) => (
            <AppCard key={app.id} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}
