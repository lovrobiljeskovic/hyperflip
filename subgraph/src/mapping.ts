import { Address, BigInt } from "@graphprotocol/graph-ts";
import { ParlayMinted, ParlayResolved, Transfer } from "../generated/ParlayVault/ParlayVault";
import { Deployment, Ticket, WalletTicket } from "../generated/schema";
import { CHAIN_ID, START_BLOCK, VAULT } from "./deployment";

const SCOPE = CHAIN_ID + ":" + VAULT;
const ZERO = "0x0000000000000000000000000000000000000000";

function associate(wallet: Address, ticket: Ticket): void {
  if (wallet.toHexString() == ZERO) return;
  const id = ticket.id + ":" + wallet.toHexString();
  if (WalletTicket.load(id) != null) return;
  const association = new WalletTicket(id);
  association.deployment = SCOPE;
  association.wallet = wallet;
  association.number = ticket.number;
  association.ticket = ticket.id;
  association.save();
}

export function handleMint(event: ParlayMinted): void {
  if (Deployment.load(SCOPE) == null) {
    const deployment = new Deployment(SCOPE);
    deployment.chainId = BigInt.fromString(CHAIN_ID);
    deployment.vault = Address.fromString(VAULT);
    deployment.startBlock = BigInt.fromString(START_BLOCK);
    deployment.schemaVersion = 1;
    deployment.save();
  }
  const id = SCOPE + ":" + event.params.id.toString();
  if (Ticket.load(id) != null) return;
  const ticket = new Ticket(id);
  ticket.deployment = SCOPE;
  ticket.number = event.params.id;
  ticket.taker = event.params.taker;
  ticket.owner = event.params.taker;
  ticket.quoteId = event.params.quoteId;
  ticket.premium = event.params.premium;
  ticket.maxPayout = event.params.maxPayout;
  ticket.status = 0;
  ticket.burned = false;
  ticket.mintBlock = event.block.number;
  ticket.mintHash = event.block.hash;
  ticket.mintTransaction = event.transaction.hash;
  ticket.mintTimestamp = event.block.timestamp;
  ticket.save();
  associate(event.params.taker, ticket);
}

export function handleTransfer(event: Transfer): void {
  // ERC-721 mint Transfer precedes ParlayMinted; that handler creates the ticket.
  if (event.params.from.toHexString() == ZERO) return;
  const ticket = Ticket.load(SCOPE + ":" + event.params.tokenId.toString());
  assert(ticket != null, "Transfer without indexed mint");
  if (ticket == null) return;
  associate(event.params.from, ticket);
  associate(event.params.to, ticket);
  if (event.params.to.toHexString() == ZERO) {
    ticket.owner = null;
    ticket.burned = true;
    ticket.burnHolder = event.params.from;
    ticket.burnBlock = event.block.number;
    ticket.burnTransaction = event.transaction.hash;
  } else {
    ticket.owner = event.params.to;
  }
  ticket.save();
}

export function handleResolve(event: ParlayResolved): void {
  const ticket = Ticket.load(SCOPE + ":" + event.params.id.toString());
  assert(ticket != null, "Resolution without indexed mint");
  if (ticket == null) return;
  assert(event.params.status > 0 && event.params.status <= 3, "Invalid resolution status");
  ticket.status = event.params.status;
  ticket.resolutionBlock = event.block.number;
  ticket.resolutionTransaction = event.transaction.hash;
  ticket.save();
}
