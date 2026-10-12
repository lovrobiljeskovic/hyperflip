// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IInbox, SettlementRelay} from "../src/SettlementRelay.sol";

/// Deploys the 998 SettlementRelay bound to the Elysium Orbit Inbox.
///
/// Required env: INBOX_ADDRESS.
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
