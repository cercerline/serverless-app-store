"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppWithOwner } from "@/lib/db";
import { formatBytes } from "@/lib/format";
import { postJsonWithRetry } from "@/lib/net";

/**
 * Review queue for administrators.
 *
 * Approving publishes an app to the public catalogue; rejecting requires a note,
 * which the submitter sees in their own dashboard. The API enforces the admin
 * role, so this component is presentation only.
 */
export function ReviewQueue({ initialPending }: { initialPending: AppWithOwner[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(initialPending);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function decide(app: AppWithOwner, decision: "published" | "rejected") {
    const note = (notes[app.id] ?? "").trim();
    if (decision === "rejected" && !note) {
      setError(`驳回「${app.name}」时需要填写理由，提交者会看到它。`);
      return;
    }

    setBusyId(app.id);
    setError(null);
    try {
      await postJsonWithRetry(
        "/api/apps/review",
        { id: app.id, decision, note: note || undefined },
        { label: "审核" },
      );
      setPending((previous) => previous.filter((item) => item.id !== app.id));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "审核失败。");
    } finally {
      setBusyId(null);
    }
  }

  if (pending.length === 0) {
    return (
      <section className="rounded-2xl border border-white/10 bg-ink-900/50 p-5">
        <h2 className="text-lg font-semibold">待审核</h2>
        <p className="mt-2 text-sm text-slate-400">
          当前没有待审核的应用。用户提交后会出现在这里。
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div>
        <h2 className="text-lg font-semibold text-amber-100">
          待审核 <span className="ml-1 text-amber-300/80">{pending.length}</span>
        </h2>
        <p className="mt-1 text-sm text-amber-100/70">
          通过后应用会立即出现在
          <a href="/" target="_blank" rel="noreferrer" className="mx-1 text-brand-300 hover:underline">
            应用库
          </a>
          ；驳回时请写明理由，提交者能看到。
        </p>
      </div>

      {error ? (
        <p className="break-anywhere rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      <ul className="space-y-3">
        {pending.map((app) => (
          <li key={app.id} className="rounded-xl border border-white/10 bg-ink-950/50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-white">{app.name}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  提交者：{app.owner_name || app.owner_email || "（未知）"}
                  {app.version_name ? ` · v${app.version_name}` : ""}
                  {app.apk_size ? ` · ${formatBytes(app.apk_size)}` : ""}
                </p>
                {app.package_name ? (
                  <p className="break-anywhere mt-0.5 font-mono text-[11px] text-slate-500">
                    {app.package_name}
                  </p>
                ) : null}
                {app.summary ? (
                  <p className="mt-2 text-sm text-slate-300">{app.summary}</p>
                ) : null}

                {/* Automated pre-screening: the reviewer sees what the rules
                    noticed, and is told plainly that it is not a verdict. */}
                {app.screening_decision ? (
                  <div
                    className={`mt-3 rounded-lg border p-2.5 text-xs leading-relaxed ${
                      app.screening_decision === "pass"
                        ? "border-brand-500/25 bg-brand-500/5 text-brand-100/80"
                        : "border-amber-500/30 bg-amber-500/5 text-amber-100/85"
                    }`}
                  >
                    <p className="font-medium">
                      自动初筛：
                      {app.screening_decision === "pass"
                        ? "未发现明显问题"
                        : `发现 ${(app.screening_reasons ?? []).length} 项需确认`}
                      {app.screening_score ? `（风险分 ${app.screening_score}）` : null}
                    </p>
                    {(app.screening_reasons ?? []).length > 0 ? (
                      <ul className="mt-1 space-y-0.5">
                        {(app.screening_reasons ?? []).slice(0, 6).map((reason, index) => (
                          <li key={index}>· {reason}</li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="mt-1.5 opacity-70">
                      自动检查只能发现已知特征，<strong>不等于安全检测通过</strong>。请结合应用用途自行判断。
                    </p>
                  </div>
                ) : null}

                {(app.observed_permissions ?? []).length > 0 ? (
                  <p className="mt-2 break-anywhere text-[11px] text-slate-500">
                    文件实际声明权限（{app.observed_permissions!.length} 项）：
                    {app.observed_permissions!.slice(0, 10).join(", ")}
                    {app.observed_permissions!.length > 10 ? " …" : ""}
                  </p>
                ) : null}
              </div>

              <div className="flex shrink-0 gap-2">
                <a
                  href={`/app/${app.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 transition hover:border-brand-500/40 hover:text-white"
                >
                  预览
                </a>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={notes[app.id] ?? ""}
                onChange={(event) =>
                  setNotes((previous) => ({ ...previous, [app.id]: event.target.value }))
                }
                placeholder="驳回理由（驳回时必填，例如：图标缺失、描述含违规内容）"
                maxLength={500}
                className="w-full flex-1 rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2 text-sm text-white placeholder:text-slate-600 outline-none focus:border-brand-500/50"
              />
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busyId === app.id}
                  onClick={() => void decide(app, "published")}
                  className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-brand-400 disabled:opacity-50"
                >
                  通过并发布
                </button>
                <button
                  type="button"
                  disabled={busyId === app.id}
                  onClick={() => void decide(app, "rejected")}
                  className="rounded-xl border border-red-500/40 px-4 py-2 text-sm text-red-200 transition hover:bg-red-500/10 disabled:opacity-50"
                >
                  驳回
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
