// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

/// Deploys one ParlayVault. Broadcaster becomes owner unless OWNER_ADDRESS is set.
///
/// Required env: QUOTE_TOKEN_ADDRESS, WRITER_ADDRESS, QUOTE_SIGNER_ADDRESS,
/// MIN_PREMIUM_BPS. Optional env: LEG_REGISTRAR_ADDRESS, OWNER_ADDRESS.
contract DeployParlay is Script {
    function run() external returns (ParlayVault vault) {
        IERC20 usdc = IERC20(vm.envAddress("QUOTE_TOKEN_ADDRESS"));
        address writer = vm.envAddress("WRITER_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        uint256 minPremiumBps = vm.envUint("MIN_PREMIUM_BPS");
        require(minPremiumBps < 10_000, "BAD_BPS"); // constructor does not range-check

        vm.startBroadcast();
        vault = new ParlayVault(usdc, writer, quoteSigner, uint16(minPremiumBps));
        address registrar = vm.envOr("LEG_REGISTRAR_ADDRESS", address(0));
        if (registrar != address(0)) vault.setLegRegistrar(registrar);
        address owner = vm.envOr("OWNER_ADDRESS", address(0));
        if (owner != address(0)) vault.setOwner(owner);
        vm.stopBroadcast();

        console.log("parlayVault", address(vault));
        console.log("writer", writer);
        console.log("quoteSigner", quoteSigner);
        console.log("minPremiumBps", minPremiumBps);
    }
}
