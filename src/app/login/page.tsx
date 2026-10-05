import { redirect } from "next/navigation";
import { AuthForm } from "@/components/admin/AuthForm";
import { getSession, isAdminConfigured, isUserAuthAvailable } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "登录" };

export default async function LoginPage() {
  if (!isUserAuthAvailable()) {
    return (
      <div className="mx-auto max-w-lg py-16">
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
          <h1 className="text-lg font-semibold text-amber-200">服务端尚未配置会话密钥</h1>
          <p className="mt-2 text-sm leading-relaxed text-amber-100/80">
            请在部署环境中设置
            <code className="mx-1 rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs">ADMIN_PASSWORD</code>
            或
            <code className="mx-1 rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs">ADMIN_PASSWORD_HASH</code>
            ，然后重新部署。它同时用于管理员登录和用户会话签名。
          </p>
        </div>
      </div>
    );
  }

  const session = await getSession();
  if (session) redirect(session.role === "admin" ? "/admin" : "/dashboard");

  return (
    <div className="flex justify-center py-16">
      <AuthForm
        mode="login"
        notice={
          isAdminConfigured()
            ? null
            : "管理员账号尚未配置，当前只能使用注册用户登录。"
        }
      />
    </div>
  );
}
