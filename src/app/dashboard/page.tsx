import { redirect } from "next/navigation";
import { AdminDashboard } from "@/components/admin/Dashboard";
import { LIMITS, getSession, userIdFromSession } from "@/lib/auth";
import { isDatabaseConfigured, listApps } from "@/lib/db";
import { blockedPermissions } from "@/lib/screening";
import { isStorageConfigured } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const metadata = { title: "我的应用" };

/**
 * The submitter's console.
 *
 * It lists only this account's own submissions — at every review state, so a
 * pending or rejected app stays visible to the person who uploaded it while
 * remaining invisible to the public catalogue.
 */
export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const ownerId = userIdFromSession(session);
  // The environment administrator has no row of its own; it uses /admin.
  if (ownerId === null) redirect("/admin");

  const databaseReady = isDatabaseConfigured();

  let apps: Awaited<ReturnType<typeof listApps>> = [];
  let loadError: string | null = null;
  if (databaseReady) {
    try {
      apps = await listApps({ ownerId, includeUnpublished: true, limit: 200 });
    } catch (error) {
      loadError = error instanceof Error ? error.message : "读取应用列表失败。";
    }
  }

  return (
    <AdminDashboard
      initialApps={apps}
      loadError={loadError}
      databaseReady={databaseReady}
      storageReady={isStorageConfigured()}
      username={session.name}
      mode="user"
      quota={LIMITS.appsPerUser}
      blockedPermissions={blockedPermissions()}
    />
  );
}
