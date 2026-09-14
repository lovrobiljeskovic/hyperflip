# Hyperflip web

Next.js frontend for the sports-only testnet app. See the [root README](../README.md)
for installation and full repository verification.

Create `.env.local` from `.env.example`, set the writer endpoint, and run:

```bash
npm run dev
```

Use `/` for the landing page and `/build`, `/positions`, and `/pricing` for trading.
The landing page renders without loading wallet providers. Wallet providers belong
to the trading layout; `scripts/check-page-bundles.mjs` checks that boundary after
building. Run `npm run check` for the web build, tests, and bundle check, or run
`bash scripts/verify.sh` from the repository root for fixture build settings.

On production, `hyperflip.xyz` serves the landing page and `app.hyperflip.xyz`
rewrites its root to `/build`. Local and preview deployments use one origin.
The writer CORS allowlist and Privy allowed origins must include both production
origins. Invite codes are stored per origin and must be entered again on a new
origin. They are never transferred through URLs.

`/pricing` reads the writer's current fees. Announce fee changes in the app before
they take effect. New fees apply to new quotes; minted tickets retain their terms.

Only public configuration belongs in `NEXT_PUBLIC_*` variables. An empty Privy
app ID uses the wallet-connector fallback. Fonts are fetched during the build.
