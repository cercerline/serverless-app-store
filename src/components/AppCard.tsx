import Link from "next/link";
import type { AppRecord } from "@/lib/db";
import { formatBytes, initialsFor, mediaUrl } from "@/lib/format";

/** Grid card for the catalogue. */
export function AppCard({ app }: { app: AppRecord }) {
  const version = app.version_name ? `v${app.version_name}` : null;

  return (
    <Link
      href={`/app/${app.slug}`}
      className="animate-rise group flex gap-3 rounded-2xl border border-white/10 bg-ink-900/60 p-4 transition hover:-translate-y-0.5 hover:border-brand-500/40 hover:bg-ink-850/80"
    >
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-ink-800">
        {app.icon_key ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl(app.slug, "icon")}
            alt={`${app.name} 图标`}
            className="h-full w-full object-cover"
            loading="lazy"
            width={64}
            height={64}
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-lg font-semibold text-brand-400">
            {initialsFor(app.name)}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="truncate font-semibold text-white group-hover:text-brand-400">{app.name}</h3>
        <p className="mt-0.5 line-clamp-2 text-sm text-slate-400">
          {app.summary || app.description || "暂无简介"}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {version && <span className="text-slate-400">{version}</span>}
          {app.apk_size ? <span>{formatBytes(app.apk_size)}</span> : null}
          {app.category ? (
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-slate-300">{app.category}</span>
          ) : null}
          {app.download_count > 0 ? <span>{app.download_count} 次下载</span> : null}
        </div>
      </div>
    </Link>
  );
}
