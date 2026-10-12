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
/// binary market, and a KeeperVerifier whose keeper is the CoreSim.
///
/// The quote mock is 5-decimal so one EVM quote unit is exactly one outcome
/// wei (MULT = 1, which the anchors rebuild split payloads from; 6-dec USDC
/// would need MULT = 1/10). Core quote wei is 8-dec, hence QUOTE_MULT = 1000.
abstract contract BaseTest is Test {
    address internal constant SYSTEM_ADDR = 0x2000000000000000000000000000000000000001;
    uint64 internal constant TOKEN_INDEX = 1;
    /// CoreWriter drops split/merge payloads with a non-zero question word.
    uint32 internal constant QUESTION = 0;
    uint32 internal constant OUTCOME = 3;
    uint8 internal constant DECIMALS = 5;
    uint256 internal constant MULT = 1;
    uint256 internal constant QUOTE_MULT = 1000;

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
        // Default pruned: the state where the keeper may relay the fraction it saw.
        outcomeStatus.set(CoreConstants.OUTCOME_PRUNED, 0, QUESTION);

        sim = new CoreSim(quote, TOKEN_INDEX, QUOTE_MULT);
        verifier = new KeeperVerifier(address(sim));
        verifier.setMinDelay(0);
        vault = new OutcomeVault(
            IERC20(address(quote)), SYSTEM_ADDR, TOKEN_INDEX, QUESTION, OUTCOME, keeper, verifier, "BTC100K", DECIMALS
        );
        sim.setVault(vault);
        sim.setVerifier(verifier);

        quote.mint(user, 1_000e6);
        vm.prank(user);
        quote.approve(address(vault), type(uint256).max);
    }

    function depositAndClaim(uint256 amount) internal {
        vm.prank(user);
        vault.deposit(amount);
        sim.processAll();
        vault.claimDeposit();
    }
}
