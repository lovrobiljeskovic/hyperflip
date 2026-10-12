// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {OutcomeLeg} from "../src/OutcomeLeg.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

/// Deploys one OutcomeLeg on Elysium mirroring a 998 OutcomeVault and, when
/// PARLAY_VAULT_ADDRESS is set, lists it (broadcaster = owner or legRegistrar).
///
/// Required env: SOURCE_VAULT, RELAY_ADDRESS. Optional: PARLAY_VAULT_ADDRESS, PRIVATE_KEY.
contract DeployLeg is Script {
    function run() external returns (OutcomeLeg leg) {
        address sourceVault = vm.envAddress("SOURCE_VAULT");
        address relay = vm.envAddress("RELAY_ADDRESS");
        address parlayVault = vm.envOr("PARLAY_VAULT_ADDRESS", address(0));

        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();
        leg = new OutcomeLeg(sourceVault, relay);
        if (parlayVault != address(0)) ParlayVault(parlayVault).allowLeg(address(leg));
        vm.stopBroadcast();

        console.log("outcomeLeg", address(leg));
        console.log("sourceVault", sourceVault);
        console.log("parlayVault", parlayVault);
    }
}
