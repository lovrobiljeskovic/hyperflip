// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

/// Deploys one ParlayVault v2 and registers its makers. Broadcaster becomes
/// owner. Every deploy yields a NEW address; v1 (domain "1") stays live and is
/// never upgraded — register the v2 address in registry/deployment.testnet.json
/// as `parlayVaultV2` alongside v1 (S8).
///
/// Required env: QUOTE_TOKEN_ADDRESS (USDC), MIN_PREMIUM_BPS, MAKERS =
/// `maker:signer,maker:signer` (bankroll address : quote-signing key address).
///
/// MIN_PREMIUM_BPS for the testnet beta: 100 (1%). Caps any single parlay at
/// 100x premium; long parlays (~5 legs at ~2x each = ~32x) still fit. The
/// floor is a signer-bug backstop, not pricing — makers quote well above it.
/// The constructor does not range-check this value (only the setter does), so
/// the script enforces < 10_000 itself.
///
/// After deploy the vault is inert until each maker approves USDC to the new
/// address — that allowance is the maker's exposure cap and pause switch. Keep
/// it small on testnet (e.g. 10 USDC).
///
/// Run: `forge script script/DeployParlay.s.sol --rpc-url $TESTNET_RPC` for a
/// dry run; add `--private-key $PRIVATE_KEY --broadcast` to deploy.
contract DeployParlay is Script {
    function run() external returns (ParlayVault vault) {
        IERC20 usdc = IERC20(vm.envAddress("QUOTE_TOKEN_ADDRESS"));
        uint256 minPremiumBps = vm.envUint("MIN_PREMIUM_BPS");
        require(minPremiumBps < 10_000, "BAD_BPS");
        string[] memory pairs = vm.split(vm.envString("MAKERS"), ",");
        require(pairs.length > 0 && bytes(pairs[0]).length > 0, "NO_MAKERS");

        vm.startBroadcast();
        vault = new ParlayVault(usdc, uint16(minPremiumBps));
        for (uint256 i; i < pairs.length; i++) {
            string[] memory kv = vm.split(pairs[i], ":");
            require(kv.length == 2, "BAD_MAKER_PAIR");
            address maker = vm.parseAddress(kv[0]);
            address signer = vm.parseAddress(kv[1]);
            vault.setMaker(maker, signer);
            console.log("maker", maker, "signer", signer);
        }
        vm.stopBroadcast();

        console.log("parlayVault", address(vault));
        console.log("minPremiumBps", minPremiumBps);
    }
}
