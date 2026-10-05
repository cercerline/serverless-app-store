import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "上传应用" };

/** Convenience entry point: sends the visitor to whichever console they own. */
export default async function SubmitPage() {
  const session = await getSession();
  if (!session) redirect("/register");
  redirect(session.role === "admin" ? "/admin" : "/dashboard");
}
