// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IInbox, SettlementRelay} from "../src/SettlementRelay.sol";

/// Deploys the HyperEVM side of Elysium settlement: one SettlementRelay per
/// deployment, bound to the Orbit Inbox of the Elysium rollup.
///
/// Required env: INBOX_ADDRESS (Elysium testnet: 0x11178Df40CBf87a4343f4B3F8B09B366ceFA8Ec0).
///
/// Run: `forge script script/DeployRelay.s.sol --rpc-url hyperevm_testnet` for a
/// dry run; add `--private-key $PRIVATE_KEY --broadcast` to deploy.
contract DeployRelay is Script {
    function run() external returns (SettlementRelay relay) {
        IInbox inbox = IInbox(vm.envAddress("INBOX_ADDRESS"));

        vm.startBroadcast();
        relay = new SettlementRelay(inbox);
        vm.stopBroadcast();

        console.log("settlementRelay", address(relay));
        console.log("inbox", address(inbox));
    }
}
