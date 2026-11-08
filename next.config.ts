import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Memoizes components and hooks automatically (fewer re-renders site-wide).
  reactCompiler: true,
};

export default nextConfig;
