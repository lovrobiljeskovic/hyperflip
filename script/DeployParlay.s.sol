// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ParlayVault} from "../src/ParlayVault.sol";

/// Deploys one ParlayVault. Broadcaster becomes owner.
///
/// Required env: QUOTE_TOKEN_ADDRESS (USDC), WRITER_ADDRESS (house bankroll
/// wallet), QUOTE_SIGNER_ADDRESS, MIN_PREMIUM_BPS.
///
/// MIN_PREMIUM_BPS for the testnet beta: 100 (1%). Caps any single parlay at
/// 100x premium; long parlays (~5 legs at ~2x each = ~32x) still fit. The
/// floor is a signer-bug backstop, not pricing — the writer service quotes
/// well above it. The constructor does not range-check this value (only the
/// setter does), so the script enforces < 10_000 itself.
///
/// After deploy the vault is inert until the writer wallet approves USDC to
/// it — that allowance is the exposure cap and pause switch. Keep it small on
/// testnet (e.g. 10 USDC).
///
/// Run: `forge script script/DeployParlay.s.sol --rpc-url $TESTNET_RPC` for a
/// dry run; add `--private-key $PRIVATE_KEY --broadcast` to deploy.
contract DeployParlay is Script {
    function run() external returns (ParlayVault vault) {
        IERC20 usdc = IERC20(vm.envAddress("QUOTE_TOKEN_ADDRESS"));
        address writer = vm.envAddress("WRITER_ADDRESS");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER_ADDRESS");
        uint256 minPremiumBps = vm.envUint("MIN_PREMIUM_BPS");
        require(minPremiumBps < 10_000, "BAD_BPS");

        vm.startBroadcast();
        vault = new ParlayVault(usdc, writer, quoteSigner, uint16(minPremiumBps));
        vm.stopBroadcast();

        console.log("parlayVault", address(vault));
        console.log("writer", writer);
        console.log("quoteSigner", quoteSigner);
        console.log("minPremiumBps", minPremiumBps);
    }
}
