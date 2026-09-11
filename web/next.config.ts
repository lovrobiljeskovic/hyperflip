import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  async redirects() {
    // Every alias host 308s to the canonical apex so search signals consolidate on one origin.
    return ["www.hyperflip.xyz", "overround.xyz", "www.overround.xyz"].map((host) => ({
      source: "/:path*",
      has: [{ type: "host" as const, value: host }],
      destination: "https://hyperflip.xyz/:path*",
      permanent: true,
    }));
  },
};

export default nextConfig;
