import type { NextConfig } from "next";
import { loadDeployment } from "./deployment/deployment.mts";

const deployment = loadDeployment(process.env, true);

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  env: {
    NEXT_PUBLIC_CHAIN_ID: String(deployment.chainId),
    NEXT_PUBLIC_PARLAY_VAULT: deployment.parlayVault,
    NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: String(deployment.deployBlock),
    NEXT_PUBLIC_APP_ORIGIN: process.env.VERCEL_ENV === "production" ? "https://app.hyperflip.xyz" : "",
    NEXT_PUBLIC_SITE_ORIGIN: process.env.VERCEL_ENV === "production" ? "https://hyperflip.xyz" : "",
  },
  async redirects() {
    const aliases = ["www.hyperflip.xyz", "overround.xyz", "www.overround.xyz"];
    return [
      ...["hyperflip.xyz", ...aliases].flatMap((host) =>
        ["build", "positions", "pricing"].map((path) => ({
          source: `/${path}`,
          has: [{ type: "host" as const, value: host.replaceAll(".", "\\.") }],
          destination: `https://app.hyperflip.xyz${path === "build" ? "/" : `/${path}`}`,
          permanent: true,
        }))),
      {
        source: "/build",
        has: [{ type: "host" as const, value: "app\\.hyperflip\\.xyz" }],
        destination: "/",
        permanent: true,
      },
      ...aliases.map((host) => ({
        source: "/:path*",
        has: [{ type: "host" as const, value: host.replaceAll(".", "\\.") }],
        destination: "https://hyperflip.xyz/:path*",
        permanent: true,
      })),
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [{
        source: "/",
        has: [{ type: "host" as const, value: "app\\.hyperflip\\.xyz" }],
        destination: "/build",
      }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
