const deploymentHost = process.env.VERCEL_URL;

export const websiteHref = process.env.NEXT_PUBLIC_SITE_ORIGIN || "/";
export function appHref(path = "/"): string {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN;
  return origin ? `${origin}${path}` : path === "/" ? "/build" : path;
}

export const siteUrl =
  process.env.VERCEL_ENV === "production"
    ? "https://hyperflip.xyz"
    : deploymentHost
      ? `https://${deploymentHost}`
      : "http://localhost:3000";

export function appCanonical(path = "/"): string {
  return new URL(appHref(path), siteUrl).href;
}
