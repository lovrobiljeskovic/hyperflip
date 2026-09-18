import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, changeFrequency: "daily", priority: 1 },
    ...["/terms", "/privacy", "/risk", "/security", "/official"].map((path) => ({
      url: `${siteUrl}${path}`, changeFrequency: "monthly" as const, priority: 0.3,
    })),
  ];
}
