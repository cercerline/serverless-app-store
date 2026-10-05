import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Legacy entry point, kept so existing bookmarks and the deploy documentation
 * keep working. Sign-in is now unified at /login for both administrators and
 * registered users.
 */
export default function LegacyAdminLoginPage() {
  redirect("/login");
}
