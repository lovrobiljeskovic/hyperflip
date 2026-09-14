import { parseAbi, parseAbiItem } from "viem";

// NEXT_PUBLIC_* must be read as static property access — Next.js inlines those
// into the client bundle; process.env[name] dynamic lookup stays empty in browser.
function requireEnv(name: string, v: string | undefined): string {
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

export const PARLAY_VAULT = process.env.NEXT_PUBLIC_PARLAY_VAULT as `0x${string}`;
export const DEPLOY_BLOCK = BigInt(
  requireEnv("NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK", process.env.NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK),
);

export const parlayVaultAbi = parseAbi([
  "error ERC721NonexistentToken(uint256 tokenId)",
  "struct Leg { address vault; bool isYes; }",
  "struct Quote { address taker; Leg[] legs; uint96 premium; uint96 maxPayout; uint256 deadline; bytes32 quoteId; }",
  "struct Parlay { Leg[] legs; address writer; uint96 premium; uint96 maxPayout; uint8 status; }",
  "function mint(Quote q, bytes sig) returns (uint256)",
  "function claim(uint256 id)",
  "function resolveParlay(uint256 id)",
  "function parlay(uint256 id) view returns (Parlay)",
  "function ownerOf(uint256 id) view returns (address)",
  "function usdc() view returns (address)",
]);

export const parlayMintedEvent = parseAbiItem(
  "event ParlayMinted(uint256 indexed id, address indexed taker, bytes32 quoteId, uint96 premium, uint96 maxPayout)",
);

export const outcomeVaultAbi = parseAbi([
  "function settled() view returns (bool)",
  "function settleFractionWad() view returns (uint256)",
]);

/** ParlayVault.Status */
export const STATUS = { Open: 0, Won: 1, Dead: 2, Void: 3 } as const;
