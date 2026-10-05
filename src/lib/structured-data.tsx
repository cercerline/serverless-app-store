import { SITE_DESCRIPTION, SITE_NAME, absoluteUrl, siteUrl } from "./site.ts";
import type { AppRecord } from "./db.ts";

/**
 * JSON-LD structured data.
 *
 * Search engines use this to render rich results — a software listing with a
 * rating-free "Free" offer, or a sitelinks search box. It is inert to visitors:
 * the scripts are `type="application/ld+json"`, which browsers do not execute.
 */

/** Escapes `<` so a name containing markup cannot break out of the script tag. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Site-level graph, rendered on the homepage. */
export function websiteJsonLd(): string {
  return safeJson({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${siteUrl()}/#website`,
        url: siteUrl(),
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        inLanguage: "zh-CN",
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${siteUrl()}/?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        },
      },
      {
        "@type": "Organization",
        "@id": `${siteUrl()}/#organization`,
        name: SITE_NAME,
        url: siteUrl(),
        logo: absoluteUrl("/icon.svg"),
      },
    ],
  });
}

/** Software listing for one app. */
export function appJsonLd(app: AppRecord): string {
  const url = absoluteUrl(`/app/${app.slug}`);

  return safeJson({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: app.name,
    url,
    description: app.summary?.trim() || app.description?.trim() || `${app.name} — 免费下载`,
    applicationCategory: app.category?.trim() || "UtilitiesApplication",
    operatingSystem: app.kind === "html" ? "Web" : "Android",
    inLanguage: "zh-CN",
    ...(app.version_name ? { softwareVersion: app.version_name } : {}),
    ...(app.apk_size ? { fileSize: `${app.apk_size}` } : {}),
    ...(app.updated_at ? { datePublished: app.updated_at, dateModified: app.updated_at } : {}),
    // Every listing on this site is free; stating it explicitly is what lets a
    // result qualify for the software rich snippet.
    offers: { "@type": "Offer", price: "0", priceCurrency: "CNY" },
    ...(app.package_name ? { identifier: app.package_name } : {}),
    ...(app.screenshots?.length
      ? { screenshot: app.screenshots.filter(Boolean).map((shot) => absoluteUrl(shot)) }
      : {}),
    publisher: { "@type": "Organization", name: SITE_NAME, url: siteUrl() },
  });
}

/** Wraps JSON-LD in the script tag crawlers expect. */
export function JsonLd({ json }: { json: string }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
