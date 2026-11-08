import type { MetadataRoute } from "next";
import { appCanonical, siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, changeFrequency: "daily", priority: 1 },
    { url: appCanonical("/leaderboard"), changeFrequency: "hourly", priority: 0.6 },
    ...["/terms", "/privacy", "/risk", "/security", "/official"].map((path) => ({
      url: `${siteUrl}${path}`, changeFrequency: "monthly" as const, priority: 0.3,
    })),
  ];
}
