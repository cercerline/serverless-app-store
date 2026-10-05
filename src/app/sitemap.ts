import type { MetadataRoute } from "next";
import { listApps } from "@/lib/db";
import { siteUrl } from "@/lib/site";

/**
 * sitemap.xml.
 *
 * A database failure must not take the sitemap down: search engines treat a 500
 * here as a signal the whole site is unhealthy. On error the static entries are
 * still served, so the homepage keeps being crawled while the catalogue recovers.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "daily", priority: 1, lastModified: new Date() },
    { url: `${base}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];

  try {
    const apps = await listApps({ limit: 200 });
    return [
      ...staticEntries,
      ...apps.map((app) => ({
        url: `${base}/app/${app.slug}`,
        lastModified: app.updated_at ? new Date(app.updated_at) : new Date(),
        changeFrequency: "weekly" as const,
        priority: 0.8,
      })),
    ];
  } catch {
    return staticEntries;
  }
}
