import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, changeFrequency: "daily", priority: 1 },
    { url: `${siteUrl}/build`, changeFrequency: "daily", priority: 0.8 },
    { url: `${siteUrl}/positions`, changeFrequency: "daily", priority: 0.5 },
  ];
}
