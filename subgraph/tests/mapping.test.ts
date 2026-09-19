import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { assert, beforeEach, clearStore, newMockEvent, test } from "matchstick-as/assembly/index";
import { ParlayMinted, ParlayResolved, Transfer } from "../generated/ParlayVault/ParlayVault";
import { handleMint, handleResolve, handleTransfer } from "../src/mapping";
import { CHAIN_ID, VAULT } from "../src/deployment";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";
const ID = CHAIN_ID + ":" + VAULT + ":1";
const TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function mint(): void {
  const event = changetype<ParlayMinted>(newMockEvent());
  event.parameters = [
    new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))),
    new ethereum.EventParam("taker", ethereum.Value.fromAddress(Address.fromString(ALICE))),
    new ethereum.EventParam("quoteId", ethereum.Value.fromFixedBytes(Bytes.fromHexString(TX))),
    new ethereum.EventParam("premium", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1000000))),
    new ethereum.EventParam("maxPayout", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(2000000))),
  ];
  handleMint(event);
}
function transfer(from: string, to: string): void {
  const event = changetype<Transfer>(newMockEvent());
  event.transaction.hash = Bytes.fromHexString(TX);
  event.parameters = [
    new ethereum.EventParam("from", ethereum.Value.fromAddress(Address.fromString(from))),
    new ethereum.EventParam("to", ethereum.Value.fromAddress(Address.fromString(to))),
    new ethereum.EventParam("tokenId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))),
  ];
  handleTransfer(event);
}
function resolve(status: i32): void {
  const event = changetype<ParlayResolved>(newMockEvent());
  event.parameters = [
    new ethereum.EventParam("id", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))),
    new ethereum.EventParam("status", ethereum.Value.fromI32(status)),
  ];
  handleResolve(event);
}

beforeEach(() => clearStore());

test("mint ordering, exact terms, ownership associations and replay", () => {
  transfer(ZERO, ALICE);
  assert.entityCount("Ticket", 0);
  mint();
  mint();
  transfer(ALICE, BOB);
  transfer(BOB, ALICE);
  assert.entityCount("Ticket", 1);
  assert.entityCount("WalletTicket", 2);
  assert.fieldEquals("Ticket", ID, "owner", ALICE);
  assert.fieldEquals("Ticket", ID, "premium", "1000000");
  assert.fieldEquals("Ticket", ID, "maxPayout", "2000000");
  assert.fieldEquals("WalletTicket", ID + ":" + BOB, "ticket", ID);
});

test("Won remains unpaid until burn; claim receipt and last holder survive", () => {
  mint();
  resolve(1);
  assert.fieldEquals("Ticket", ID, "burned", "false");
  transfer(ALICE, BOB);
  transfer(BOB, ZERO);
  assert.fieldEquals("Ticket", ID, "status", "1");
  assert.fieldEquals("Ticket", ID, "burned", "true");
  assert.fieldEquals("Ticket", ID, "burnHolder", BOB);
  assert.fieldEquals("Ticket", ID, "burnTransaction", TX);
  assert.entityCount("WalletTicket", 2);
});

test("Void burns in the same transaction; Dead retains its receipt token", () => {
  mint();
  resolve(3);
  transfer(ALICE, ZERO);
  assert.fieldEquals("Ticket", ID, "status", "3");
  assert.fieldEquals("Ticket", ID, "burnHolder", ALICE);
  assert.entityCount("WalletTicket", 1);
  clearStore();
  mint();
  resolve(2);
  assert.fieldEquals("Ticket", ID, "burned", "false");
  assert.fieldEquals("Ticket", ID, "owner", ALICE);
});

test("mint, auto-resolve and claim in one transaction", () => {
  transfer(ZERO, ALICE);
  mint();
  resolve(1);
  transfer(ALICE, ZERO);
  assert.fieldEquals("Ticket", ID, "status", "1");
  assert.fieldEquals("Ticket", ID, "burned", "true");
  assert.entityCount("WalletTicket", 1);
});
