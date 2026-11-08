import "server-only";
import { slipCardState, type CardState } from "./share-card";
import { legsFromSearch, restoreLegs } from "./slip-storage";
import { fetchMarkets, type Market } from "./writer";

/** The card for a `/build?leg=…` link: the legs the board still carries, no stake (the link has none). */
export async function loadSlipCard(search: string, markets: () => Promise<Market[]> = () => fetchMarkets(true)): Promise<CardState | null> {
  try {
    const legs = restoreLegs(legsFromSearch(search), await markets());
    return legs.length ? slipCardState(legs) : null;
  } catch { return null; }
}
