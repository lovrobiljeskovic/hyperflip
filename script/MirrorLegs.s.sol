// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {OutcomeLeg} from "../src/OutcomeLeg.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

/// Bulk cutover: one OutcomeLeg per HyperEVM vault in SOURCE_VAULTS (comma
/// separated), each listed on the Elysium ParlayVault in the same broadcast.
/// The broadcaster must be the vault's owner or legRegistrar.
///
/// Required env: SOURCE_VAULTS, RELAY_ADDRESS, PARLAY_VAULT_ADDRESS.
/// Driven by `tools/mirror-legs.mjs`, which rewrites the registry afterwards.
contract MirrorLegs is Script {
    function run() external {
        address[] memory sources = vm.envAddress("SOURCE_VAULTS", ",");
        address relay = vm.envAddress("RELAY_ADDRESS");
        ParlayVault parlayVault = ParlayVault(vm.envAddress("PARLAY_VAULT_ADDRESS"));

        vm.startBroadcast();
        for (uint256 i = 0; i < sources.length; i++) {
            OutcomeLeg leg = new OutcomeLeg(sources[i], relay);
            parlayVault.allowLeg(address(leg));
            console.log("outcomeLeg", address(leg), "sourceVault", sources[i]);
        }
        vm.stopBroadcast();
    }
}
