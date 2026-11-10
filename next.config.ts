import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Memoizes components and hooks automatically (fewer re-renders site-wide).
  reactCompiler: true,
  async headers() {
    return [
      {
        // The service worker must be re-checked on every visit and may control the whole site.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
