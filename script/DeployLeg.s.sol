// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {OutcomeLeg} from "../src/OutcomeLeg.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

/// Deploys one OutcomeLeg on Elysium mirroring a HyperEVM OutcomeVault, and
/// lists it on the Elysium ParlayVault when PARLAY_VAULT_ADDRESS is set (the
/// broadcaster must then be that vault's owner or legRegistrar).
///
/// Required env: SOURCE_VAULT (998 OutcomeVault), RELAY_ADDRESS (998
/// SettlementRelay). Optional: PARLAY_VAULT_ADDRESS.
///
/// Run: `forge script script/DeployLeg.s.sol --rpc-url elysium_testnet` for a
/// dry run; add `--private-key $PRIVATE_KEY --broadcast` to deploy.
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
