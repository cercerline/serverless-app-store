import type { AppStatus } from "@/lib/db";

const LABELS: Record<AppStatus, { text: string; className: string; hint: string }> = {
  published: {
    text: "已发布",
    className: "bg-brand-500/15 text-brand-300 border-brand-500/30",
    hint: "已在应用库中公开展示",
  },
  pending: {
    text: "待审核",
    className: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    hint: "管理员审核通过后才会公开",
  },
  rejected: {
    text: "已驳回",
    className: "bg-red-500/15 text-red-300 border-red-500/30",
    hint: "未通过审核，可按驳回理由修改后重新提交",
  },
  draft: {
    text: "草稿",
    className: "bg-white/10 text-slate-300 border-white/20",
    hint: "仅自己可见，尚未提交审核",
  },
};

/** Small pill showing an app's review state. */
export function StatusBadge({ status, showHint = false }: { status: AppStatus; showHint?: boolean }) {
  const meta = LABELS[status] ?? LABELS.pending;
  return (
    <span
      title={meta.hint}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-none ${meta.className}`}
    >
      {meta.text}
      {showHint ? <span className="ml-1 opacity-70">· {meta.hint}</span> : null}
    </span>
  );
}
