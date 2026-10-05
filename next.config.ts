import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `pg` must stay external: it opens native TCP sockets and is never bundled.
  serverExternalPackages: ["pg"],
  experimental: {
    // Admin forms post small JSON payloads; APK bytes never pass through here.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  images: {
    // Icons come from R2 (custom domain, r2.dev, or an app route), so remote
    // patterns are permissive on purpose.
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
