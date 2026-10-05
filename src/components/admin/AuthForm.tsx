"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { postJsonWithRetry } from "@/lib/net";

type Mode = "login" | "register";

/** Shared sign-in / sign-up form. */
export function AuthForm({ mode, notice }: { mode: Mode; notice?: string | null }) {
  const router = useRouter();
  const isRegister = mode === "register";

  const [identifier, setIdentifier] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (isRegister) {
      if (password.length < 8) {
        setError("密码至少 8 位。");
        return;
      }
      if (password !== confirm) {
        setError("两次输入的密码不一致。");
        return;
      }
    }

    setBusy(true);
    try {
      const endpoint = isRegister ? "/api/auth/register" : "/api/admin/login";
      const body = isRegister
        ? { email: identifier, password, displayName }
        : { username: identifier, password };

      const data = await postJsonWithRetry<{ redirect?: string }>(endpoint, body, {
        label: isRegister ? "注册" : "登录",
      });

      router.replace(data.redirect || (isRegister ? "/dashboard" : "/admin"));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="animate-rise w-full max-w-sm space-y-4 rounded-2xl border border-white/10 bg-ink-900/70 p-6"
    >
      <div>
        <h1 className="text-xl font-semibold text-white">{isRegister ? "注册账号" : "登录"}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {isRegister
            ? "注册后即可提交你的应用，管理员审核通过后会在应用库中公开。"
            : "使用邮箱登录，或用管理员账号进入后台。"}
        </p>
      </div>

      {notice ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          {notice}
        </p>
      ) : null}

      <label className="block">
        <span className="mb-1.5 block text-sm text-slate-300">
          {isRegister ? "邮箱" : "邮箱或管理员账号"}
        </span>
        <input
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          type={isRegister ? "email" : "text"}
          autoComplete={isRegister ? "email" : "username"}
          required
          placeholder={isRegister ? "you@example.com" : "you@example.com 或 admin"}
          className={inputClass}
        />
      </label>

      {isRegister ? (
        <label className="block">
          <span className="mb-1.5 block text-sm text-slate-300">显示名称（可选）</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="nickname"
            maxLength={40}
            placeholder="其他用户看到的名字"
            className={inputClass}
          />
        </label>
      ) : null}

      <label className="block">
        <span className="mb-1.5 block text-sm text-slate-300">密码</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={isRegister ? "new-password" : "current-password"}
          required
          minLength={isRegister ? 8 : undefined}
          className={inputClass}
        />
        {isRegister ? <span className="mt-1 block text-xs text-slate-500">至少 8 位字符。</span> : null}
      </label>

      {isRegister ? (
        <label className="block">
          <span className="mb-1.5 block text-sm text-slate-300">再输一次密码</span>
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            required
            className={inputClass}
          />
        </label>
      ) : null}

      {error ? (
        <p className="break-anywhere rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "处理中…" : isRegister ? "注册并进入" : "登录"}
      </button>

      <p className="text-center text-sm text-slate-400">
        {isRegister ? (
          <>
            已经有账号？{" "}
            <Link href="/login" className="text-brand-400 hover:underline">
              直接登录
            </Link>
          </>
        ) : (
          <>
            还没有账号？{" "}
            <Link href="/register" className="text-brand-400 hover:underline">
              注册一个
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

const inputClass =
  "w-full rounded-xl border border-white/10 bg-ink-950/60 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/20";
