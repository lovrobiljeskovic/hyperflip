import { verifyDeploymentRpc } from "../../registry/deployment.mjs";
import crypto from "node:crypto";
import { createPublicClient, fallback, http, isAddressEqual, zeroAddress, type Address, type Hex } from "viem";
import { parlayVaultAbi } from "./abi.js";
import { loadRelayConfig } from "./config.js";
import { QuoteJournal } from "./journal.js";
import { newRelayMetrics, startRelay, type RelayDeps } from "./relay.js";
import { RateLimiter, sendInviteEmail, Waitlist } from "./waitlist.js";

const SIGNER_REFRESH_MS = 60_000;

async function main(): Promise<void> {
  const cfg = loadRelayConfig();
  const journal = new QuoteJournal(cfg.rfqJournalFile);
  const rpcUrls = cfg.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
  const publicClient = createPublicClient({ transport: fallback(rpcUrls.map((u) => http(u))) });
  await verifyDeploymentRpc(publicClient, cfg);
  const log = (msg: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...msg }));

  cfg.minPremiumBps = BigInt(
    (await publicClient.readContract({ address: cfg.parlayVault, abi: parlayVaultAbi, functionName: "minPremiumBps" })) as number,
  );

  // Signer registry is read from chain, never from a maker: a rotated key shows up
  // here within a minute and an unregistered maker cannot boot the relay at all.
  const signers = new Map<string, Address>();
  const refreshSigners = async () => {
    for (const m of cfg.makers) {
      const signer = (await publicClient.readContract({
        address: cfg.parlayVault, abi: parlayVaultAbi, functionName: "signerOf", args: [m.maker],
      })) as Address;
      const prev = signers.get(m.maker.toLowerCase());
      if (prev && !isAddressEqual(prev, signer)) log({ event: "maker-signer-changed", maker: m.maker, from: prev, to: signer });
      signers.set(m.maker.toLowerCase(), signer);
    }
  };
  await refreshSigners();
  for (const m of cfg.makers) {
    if (isAddressEqual(signers.get(m.maker.toLowerCase())!, zeroAddress)) {
      console.error(new Date().toISOString(), "FATAL", JSON.stringify({ event: "maker-not-registered", maker: m.maker }));
      process.exit(1);
    }
  }
  setInterval(() => refreshSigners().catch((err) => console.error(new Date().toISOString(), "signer refresh failed", err)), SIGNER_REFRESH_MS).unref();

  const deps: RelayDeps = {
    cfg,
    metrics: newRelayMetrics(),
    now: () => Date.now(),
    randomId: () => `0x${crypto.randomBytes(32).toString("hex")}` as Hex,
    signerOf: (maker) => signers.get(maker.toLowerCase()) ?? zeroAddress,
    askMaker: async (m, body, signal) => {
      const r = await fetch(`${m.url}/rfq`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.makerToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      return { status: r.status, json: await r.json() };
    },
    makerHealth: async (m) => {
      try {
        return await (await fetch(`${m.url}/health`, { signal: AbortSignal.timeout(2000) })).json();
      } catch {
        return null;
      }
    },
    recordRfq: async (r) => journal.append(r),
    waitlist: new Waitlist(cfg.waitlistFile),
    sendInvite: cfg.resendApiKey ? (email, code) => sendInviteEmail(cfg.resendApiKey!, email, code) : undefined,
    signupLimiter: new RateLimiter(5, 60 * 60 * 1000),
    badInviteLimiter: new RateLimiter(20, 60 * 60 * 1000),
    quoteLimiter: new RateLimiter(300, 60 * 60 * 1000),
  };
  if (!cfg.resendApiKey) console.warn(JSON.stringify({ event: "waitlist-disabled", reason: "RESEND_API_KEY unset" }));

  startRelay(deps, cfg.port, () => ({ ok: true }));
  log({ event: "relay-listening", port: cfg.port, makers: cfg.makers.length, chainId: cfg.chainId });
}

main().catch((err) => {
  console.error(new Date().toISOString(), "FATAL", err);
  process.exit(1);
});
