import { ImageResponse } from "next/og";
import { getAppBySlug } from "@/lib/db";
import { formatBytes } from "@/lib/format";
import { SITE_NAME } from "@/lib/site";

export const alt = "应用详情";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Per-app social card.
 *
 * A shared link that shows the actual app name, version and size gets clicked far
 * more often than a generic site card, which is the whole point of posting to
 * communities. Falls back to the site card's copy if the app cannot be read.
 */
export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let name = SITE_NAME;
  let summary = "用 AI 做的 app，传上来大家都能用";
  let meta = "";
  let initials = "AI";

  try {
    const app = await getAppBySlug(slug, true);
    if (app) {
      name = app.name;
      summary = app.summary?.trim() || `${app.kind === "html" ? "网页应用" : "Android 应用"}`;
      const parts: string[] = [];
      if (app.version_name) parts.push(`v${app.version_name}`);
      if (app.apk_size) parts.push(formatBytes(app.apk_size));
      if (app.category) parts.push(app.category);
      meta = parts.join("  ·  ");
      initials = name.trim().slice(0, /[\u4e00-\u9fa5]/.test(name.trim()[0] ?? "") ? 1 : 2);
    }
  } catch {
    // Fall through to the site-level card.
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "linear-gradient(135deg, #070b14 0%, #0d1526 55%, #10203a 100%)",
          padding: "64px 72px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: "rgba(34,211,238,0.16)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
            }}
          >
            📦
          </div>
          <div style={{ color: "#7dd3fc", fontSize: 26 }}>{SITE_NAME}</div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
          <div
            style={{
              width: 132,
              height: 132,
              borderRadius: 30,
              background: "linear-gradient(135deg, #164e63, #0e7490)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#ffffff",
              fontSize: 60,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {initials}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <div
              style={{
                color: "#ffffff",
                fontSize: 68,
                fontWeight: 700,
                lineHeight: 1.2,
                maxWidth: 860,
              }}
            >
              {name.length > 18 ? `${name.slice(0, 18)}…` : name}
            </div>
            <div
              style={{
                color: "#94a3b8",
                fontSize: 30,
                maxWidth: 860,
                lineHeight: 1.4,
              }}
            >
              {summary.length > 40 ? `${summary.slice(0, 40)}…` : summary}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              background: "#22d3ee",
              color: "#070b14",
              fontSize: 28,
              fontWeight: 700,
              padding: "12px 32px",
              borderRadius: 999,
            }}
          >
            免费下载
          </div>
          {meta ? <div style={{ color: "#64748b", fontSize: 26 }}>{meta}</div> : null}
        </div>
      </div>
    ),
    size,
  );
}
