// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IExecutionVerifier} from "../src/IExecutionVerifier.sol";
import {KeeperVerifier} from "../src/KeeperVerifier.sol";
import {OutcomeVault} from "../src/OutcomeVault.sol";

/// Per-market deploy. No factory (plan text: "one deploy script per market
/// ... factory only when market count makes scripts painful"). Deploys one
/// OutcomeVault, which deploys its own oYES/oNO pair (vault-gated mint/burn
/// is wired automatically — OutcomeToken sets `vault = msg.sender` in its own
/// constructor). Reuses a shared KeeperVerifier when VERIFIER_ADDRESS is set,
/// else deploys a fresh one owned by the broadcaster.
///
/// Required env: QUOTE_TOKEN_ADDRESS, CORE_SYSTEM_ADDRESS, QUESTION_ID,
/// OUTCOME_ID, KEEPER_ADDRESS, MARKET_SYMBOL.
/// Optional env: QUOTE_TOKEN_CORE_INDEX (default 0 — confirmed USDC index,
/// FINDINGS.md), QUOTE_DECIMALS (default 6 — real USDC), VERIFIER_ADDRESS
/// (reuse an already-deployed shared verifier instead of deploying a fresh
/// one), MIN_DELAY_SECONDS (applied only to a freshly deployed verifier;
/// KeeperVerifier's own default is 10 minutes).
///
/// Run: `forge script script/Deploy.s.sol --rpc-url $TESTNET_RPC --sig
/// "run()"` for a dry run (needs --rpc-url: the constructor checks live code
/// at CoreConstants.CORE_DEPOSIT_WALLET, which only exists on-chain); add
/// `--broadcast` with `PRIVATE_KEY` in the environment to actually deploy.
/// The key is read from env, never passed as `--private-key`: process
/// arguments are world-readable on the box (`ps`, /proc), environment is not.
/// `--private-key` still works when PRIVATE_KEY is unset.
contract Deploy is Script {
    /// Own function so run() keeps its stack: one more local there is "stack too deep".
    function _startBroadcast() internal {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey != 0) vm.startBroadcast(deployerKey);
        else vm.startBroadcast();
    }

    function run() external returns (OutcomeVault vault, KeeperVerifier verifier) {
        IERC20 quoteToken = IERC20(vm.envAddress("QUOTE_TOKEN_ADDRESS"));
        address coreSystemAddress = vm.envAddress("CORE_SYSTEM_ADDRESS");
        uint64 quoteTokenCoreIndex = uint64(vm.envOr("QUOTE_TOKEN_CORE_INDEX", uint256(0)));
        uint32 question = uint32(vm.envUint("QUESTION_ID"));
        uint32 outcome = uint32(vm.envUint("OUTCOME_ID"));
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        string memory marketSymbol = vm.envString("MARKET_SYMBOL");
        uint8 quoteDecimals = uint8(vm.envOr("QUOTE_DECIMALS", uint256(6)));
        address existingVerifier = vm.envOr("VERIFIER_ADDRESS", address(0));

        _startBroadcast();

        if (existingVerifier != address(0)) {
            verifier = KeeperVerifier(existingVerifier);
            console.log("reusing verifier", address(verifier));
        } else {
            verifier = new KeeperVerifier(keeper);
            uint256 minDelay = vm.envOr("MIN_DELAY_SECONDS", uint256(0));
            if (minDelay > 0) verifier.setMinDelay(minDelay);
            console.log("deployed verifier", address(verifier));
        }

        vault = new OutcomeVault(
            quoteToken,
            coreSystemAddress,
            quoteTokenCoreIndex,
            question,
            outcome,
            keeper,
            IExecutionVerifier(address(verifier)),
            marketSymbol,
            quoteDecimals
        );

        vm.stopBroadcast();

        console.log("vault", address(vault));
        console.log("oYes", address(vault.oYes()));
        console.log("oNo", address(vault.oNo()));
    }
}
