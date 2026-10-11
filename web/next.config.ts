import type { NextConfig } from "next";
import { loadDeployment } from "./deployment/deployment.mts";

const deployment = loadDeployment(process.env, true);
// One Vercel project per chain; APP_ORIGIN names this project's app host (default: the 998 app).
const appOrigin = process.env.APP_ORIGIN ?? "https://app.hyperflip.xyz";
const appHost = new URL(appOrigin).host.replaceAll(".", "\\.");
if (process.env.NEXT_PUBLIC_POSITIONS_SOURCE && !["legacy", "subgraph"].includes(process.env.NEXT_PUBLIC_POSITIONS_SOURCE)) {
  throw new Error("NEXT_PUBLIC_POSITIONS_SOURCE must be legacy or subgraph");
}

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  env: {
    NEXT_PUBLIC_CHAIN_ID: String(deployment.chainId),
    NEXT_PUBLIC_CHAIN_NAME: deployment.chainName,
    NEXT_PUBLIC_PARLAY_VAULT: deployment.parlayVault,
    NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: String(deployment.deployBlock),
    NEXT_PUBLIC_APP_ORIGIN: process.env.VERCEL_ENV === "production" ? appOrigin : "",
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
        has: [{ type: "host" as const, value: appHost }],
        destination: "/",
        permanent: true,
      },
      // Legal/identity pages live on the apex; keep scanners probing app. from 404ing.
      ...["/terms", "/privacy", "/risk", "/security", "/official", "/.well-known/security.txt"].map((path) => ({
        source: path,
        has: [{ type: "host" as const, value: appHost }],
        destination: `https://hyperflip.xyz${path}`,
        permanent: true,
      })),
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
        has: [{ type: "host" as const, value: appHost }],
        destination: "/build",
      }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
