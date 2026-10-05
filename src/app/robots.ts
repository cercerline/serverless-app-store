import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

/**
 * robots.txt.
 *
 * Private areas are disallowed rather than merely unlinked: a crawler that
 * indexes /admin or a presigned /download URL would either expose the console in
 * search results or burn storage bandwidth on bot traffic.
 */
export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin",
          "/admin/",
          "/dashboard",
          "/api/",
          "/download/",
          "/login",
          "/register",
          "/submit",
          "/view/",
        ],
      },
      // Aggressive SEO crawlers add no distribution value here and consume
      // function invocations on every app page.
      { userAgent: ["AhrefsBot", "SemrushBot", "MJ12bot", "DotBot"], disallow: "/" },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
