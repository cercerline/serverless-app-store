"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/** Debounced search box that keeps the query in the URL so results are shareable. */
export function SearchBox({ initialQuery = "" }: { initialQuery?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    // Avoid a redundant navigation on mount.
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      const trimmed = value.trim();
      if (trimmed) params.set("q", trimmed);
      else params.delete("q");
      const query = params.toString();
      router.replace(query ? `/?${query}` : "/", { scroll: false });
    }, 300);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, router, searchParams]);

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
      }}
      className="relative"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="pointer-events-none absolute left-3.5 top-1/2 h-4.5 w-4.5 -translate-y-1/2 text-slate-500"
      >
        <path
          fill="currentColor"
          d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
        />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="搜索应用名称、包名或关键词…"
        aria-label="搜索应用"
        className="w-full rounded-xl border border-white/10 bg-ink-900/70 py-2.5 pl-10 pr-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20"
      />
    </form>
  );
}
