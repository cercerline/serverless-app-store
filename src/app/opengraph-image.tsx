import { ImageResponse } from "next/og";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";

export const alt = `${SITE_NAME} — ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Social card for the site as a whole.
 *
 * Rendered at request time rather than committed as a PNG so the copy follows
 * the configured site name instead of drifting from it.
 */
export default async function Image() {
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
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              background: "rgba(34,211,238,0.16)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 34,
            }}
          >
            📦
          </div>
          <div style={{ color: "#7dd3fc", fontSize: 30, letterSpacing: 1 }}>{SITE_NAME}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ color: "#ffffff", fontSize: 82, fontWeight: 700, lineHeight: 1.15 }}>
            用 AI 做的 app
          </div>
          <div style={{ color: "#22d3ee", fontSize: 82, fontWeight: 700, lineHeight: 1.15 }}>
            传上来，大家都能用
          </div>
        </div>

        <div style={{ display: "flex", gap: 16 }}>
          {["APK 下载", "HTML 应用", "免费发布", "无需开发者账号"].map((tag) => (
            <div
              key={tag}
              style={{
                border: "1px solid rgba(125,211,252,0.35)",
                color: "#bae6fd",
                fontSize: 26,
                padding: "10px 24px",
                borderRadius: 999,
              }}
            >
              {tag}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
