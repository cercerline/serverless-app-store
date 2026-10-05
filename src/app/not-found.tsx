import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-20 text-center">
      <p className="text-6xl font-semibold text-brand-500/40">404</p>
      <h1 className="mt-4 text-xl font-semibold text-white">找不到这个页面或应用</h1>
      <p className="mt-2 text-sm text-slate-400">
        应用可能已被下架、设为未发布，或者链接有误。
      </p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-brand-400"
      >
        返回应用库
      </Link>
    </div>
  );
}
