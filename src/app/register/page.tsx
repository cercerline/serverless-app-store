import { redirect } from "next/navigation";
import { AuthForm } from "@/components/admin/AuthForm";
import { LIMITS, getSession, isUserAuthAvailable } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "注册账号" };

export default async function RegisterPage() {
  if (!isUserAuthAvailable()) {
    return (
      <div className="mx-auto max-w-lg py-16">
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-200">
          服务端尚未配置会话密钥，暂时无法注册。
        </div>
      </div>
    );
  }

  if (!LIMITS.openRegistration) {
    return (
      <div className="mx-auto max-w-lg py-16">
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
          <h1 className="text-lg font-semibold text-amber-200">本站当前未开放注册</h1>
          <p className="mt-2 text-sm text-amber-100/80">
            如需上传应用，请联系管理员为你开通账号。
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
        mode="register"
        notice={`每个账号最多提交 ${LIMITS.appsPerUser} 个应用，单个文件不超过 ${Math.round(
          LIMITS.maxUploadBytes / 1024 / 1024,
        )}MB。`}
      />
    </div>
  );
}
