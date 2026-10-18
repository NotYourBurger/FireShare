import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@electric-sql/pglite"],
  // No next/image: pages use plain images, so sharp (a native module) isn't installed.
  images: { unoptimized: true },
};

export default nextConfig;
