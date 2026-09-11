const deploymentHost = process.env.VERCEL_URL;

export const siteUrl =
  process.env.VERCEL_ENV === "production"
    ? "https://hyperflip.xyz"
    : deploymentHost
      ? `https://${deploymentHost}`
      : "http://localhost:3000";
