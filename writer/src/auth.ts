import { PrivyClient, InvalidAuthTokenError } from "@privy-io/node";
import { isAddress } from "viem";

export interface AuthenticatedAccount {
  userId: string;
  emails: string[];
  wallets: string[];
}

export function privyAuthenticator(appId: string, appSecret: string) {
  const client = new PrivyClient({ appId, appSecret, timeout: 5_000, maxRetries: 0 });
  return async (token: string): Promise<AuthenticatedAccount | null> => {
    let claims;
    try { claims = await client.utils().auth().verifyAccessToken(token); }
    catch (error) {
      if (error instanceof InvalidAuthTokenError) return null;
      throw new Error("Authentication unavailable");
    }
    try {
      // Read current links so an unlinked wallet cannot keep using an old token.
      const user = await client.users()._get(claims.user_id);
      if (user.id !== claims.user_id || user.is_guest) return null;
      const verified = user.linked_accounts.filter(a => "verified_at" in a && Number.isFinite(a.verified_at) && a.verified_at > 0);
      return {
        userId: user.id,
        emails: verified.flatMap(a => a.type === "email" ? [a.address.trim().toLowerCase()] : []),
        wallets: verified.flatMap(a => a.type === "wallet" && a.chain_type === "ethereum" && isAddress(a.address) ? [a.address.toLowerCase()] : []),
      };
    } catch { throw new Error("Authentication unavailable"); }
  };
}
