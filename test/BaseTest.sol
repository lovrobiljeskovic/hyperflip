// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {CoreConstants} from "../src/CoreConstants.sol";
import {KeeperVerifier} from "../src/KeeperVerifier.sol";
import {OutcomeVault} from "../src/OutcomeVault.sol";
import {MockCoreDepositWallet, MockOutcomeStatus, MockQuote, MockCoreWriter, MockSpotBalance} from "./mocks/Mocks.sol";
import {CoreSim} from "./CoreSim.sol";

/// Shared fixture: mocks etched at the real Core addresses, one vault for a
/// binary market, and a KeeperVerifier whose keeper is the CoreSim (it attests
/// whatever it just simulated).
///
/// Decimals: the quote mock is 5-decimal so that one EVM quote unit is exactly
/// one 5-decimal outcome wei — MULT, the EVM-units→outcome-wei factor the
/// anchor suite rebuilds split payloads from, is then 1. Real USDC is 6-dec
/// (MULT would be 1/10, which no uint can express), so a fixture that exercises
/// the spike-correct encoding has to use a quote with <= 5 decimals. Quote wei
/// is 8-dec on Core regardless, hence QUOTE_MULT = 1e8/1e5 = 1000.
abstract contract BaseTest is Test {
    address internal constant SYSTEM_ADDR = 0x2000000000000000000000000000000000000001;
    uint64 internal constant TOKEN_INDEX = 1;
    /// CoreWriter drops split/merge payloads with a non-zero question word
    /// (FINDINGS.md #1), so the encoded — and therefore expected — question is 0.
    uint32 internal constant QUESTION = 0;
    uint32 internal constant OUTCOME = 3;
    uint8 internal constant DECIMALS = 5;
    uint256 internal constant MULT = 1;
    uint256 internal constant QUOTE_MULT = 1000;
    uint256 internal constant DIV = 1;

    MockQuote internal quote;
    MockCoreWriter internal writer;
    MockOutcomeStatus internal outcomeStatus;
    MockCoreDepositWallet internal depositWallet;
    KeeperVerifier internal verifier;
    CoreSim internal sim;
    OutcomeVault internal vault;

    address internal keeper;
    address internal user;
    address internal other;

    function setUp() public virtual {
        keeper = address(this);
        user = makeAddr("user");
        other = makeAddr("other");

        quote = new MockQuote("Mock USD", "mUSD", DECIMALS);
        vm.etch(CoreConstants.CORE_WRITER, type(MockCoreWriter).runtimeCode);
        vm.etch(CoreConstants.SPOT_BALANCE_PRECOMPILE, type(MockSpotBalance).runtimeCode);
        vm.etch(CoreConstants.OUTCOME_STATUS_PRECOMPILE, type(MockOutcomeStatus).runtimeCode);
        vm.etch(CoreConstants.CORE_DEPOSIT_WALLET, type(MockCoreDepositWallet).runtimeCode);
        writer = MockCoreWriter(CoreConstants.CORE_WRITER);
        outcomeStatus = MockOutcomeStatus(CoreConstants.OUTCOME_STATUS_PRECOMPILE);
        depositWallet = MockCoreDepositWallet(CoreConstants.CORE_DEPOSIT_WALLET);
        depositWallet.setQuote(IERC20(address(quote)));
        outcomeStatus.set(CoreConstants.OUTCOME_ACTIVE, 0, QUESTION);

        sim = new CoreSim(quote, SYSTEM_ADDR, TOKEN_INDEX, QUOTE_MULT, DIV);
        verifier = new KeeperVerifier(address(sim));
        verifier.setMinDelay(0); // attestation maturity is drilled in its own test
        vault = new OutcomeVault(
            IERC20(address(quote)), SYSTEM_ADDR, TOKEN_INDEX, QUESTION, OUTCOME, keeper, verifier, "BTC100K", DECIMALS
        );
        sim.setVault(vault);
        sim.setVerifier(verifier);

        quote.mint(user, 1_000e6);
        vm.prank(user);
        quote.approve(address(vault), type(uint256).max);
    }

    /// Full happy-path deposit: user deposits `amount`, Core processes and the
    /// keeper attests, pair minted.
    function depositAndClaim(uint256 amount) internal {
        vm.prank(user);
        vault.deposit(amount);
        sim.processAll();
        vault.claimDeposit();
    }
}
