import { redirect } from "next/navigation";
import { AdminDashboard } from "@/components/admin/Dashboard";
import { ReviewQueue } from "@/components/admin/ReviewQueue";
import { getSession } from "@/lib/auth";
import { isDatabaseConfigured, listAppsWithOwner, listPendingApps } from "@/lib/db";
import { blockedPermissions } from "@/lib/screening";
import { isStorageConfigured } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const metadata = { title: "管理后台" };

/**
 * Administrator console: the review queue, every app regardless of owner, and
 * the upload form (an administrator's own submissions publish immediately).
 */
export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");

  const databaseReady = isDatabaseConfigured();

  let apps: Awaited<ReturnType<typeof listAppsWithOwner>> = [];
  let pending: Awaited<ReturnType<typeof listPendingApps>> = [];
  let loadError: string | null = null;

  if (databaseReady) {
    try {
      [apps, pending] = await Promise.all([
        listAppsWithOwner({ limit: 200 }),
        listPendingApps(100),
      ]);
    } catch (error) {
      loadError = error instanceof Error ? error.message : "读取应用列表失败。";
    }
  }

  return (
    <div className="space-y-6">
      <ReviewQueue initialPending={pending} />

      <AdminDashboard
        initialApps={apps}
        loadError={loadError}
        databaseReady={databaseReady}
        storageReady={isStorageConfigured()}
        username={session.name}
        mode="admin"
        blockedPermissions={blockedPermissions()}
      />
    </div>
  );
}
