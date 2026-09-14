This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Landing and trading

One Next.js deployment serves `hyperflip.xyz` (landing) and `app.hyperflip.xyz`
(trading). The app root rewrites to the internal `/build` route; `/positions`
and `/pricing` share the trading layout and wallet providers. Locally and on
preview deployments, use `/`, `/build`, `/positions`, and `/pricing` on the same
origin. Production links are selected at build time from `VERCEL_ENV`.

Before launching the split, deploy the writer's additive `/limits.legEdgeBps`
field, attach `app.hyperflip.xyz` to the existing Vercel project, add the app
origin to Privy's allowed origins, and add `https://app.hyperflip.xyz` to the
writer's `CORS_ORIGINS` while retaining the landing origin for signup. Check
wallet connection, quotes, minting, claims, and beta signup on testnet before
promoting the frontend. Existing invite codes must be entered once on the new
app origin; no codes are transferred through URLs.

The pricing page reads the writer's current configuration without caching or
hardcoded fee fallbacks. For future pricing changes, publish an in-app notice
with the effective date and explanation before changing writer configuration.
Changes apply to new quotes; previously minted slips retain their terms. No fee
parameters or contract behavior are changed by the landing/app split.

Run `npm run check` here and in `../writer` before release.
The web check also verifies that the landing's initial JavaScript excludes
wallet providers. After a standalone build, run this check with
`node scripts/check-page-bundles.mjs`.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load Bricolage Grotesque, Instrument Sans, and Martian Mono.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
