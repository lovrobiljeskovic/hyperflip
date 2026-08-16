// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {CoreConstants} from "../src/CoreConstants.sol";
import {OutcomeVault} from "../src/OutcomeVault.sol";
import {MockQuote, MockCoreWriter, MockSpotBalance} from "./mocks/Mocks.sol";
import {CoreSim} from "./CoreSim.sol";

/// Shared fixture: mocks etched at the real Core addresses, one vault for a
/// binary market (question 7, outcome 3), quote with 6 decimals, Core wei with
/// 8 (multiplier 100).
abstract contract BaseTest is Test {
    address internal constant SYSTEM_ADDR = 0x2000000000000000000000000000000000000001;
    uint64 internal constant TOKEN_INDEX = 1;
    uint32 internal constant QUESTION = 7;
    uint32 internal constant OUTCOME = 3;
    uint256 internal constant MULT = 100;
    uint256 internal constant DIV = 1;

    MockQuote internal quote;
    MockCoreWriter internal writer;
    CoreSim internal sim;
    OutcomeVault internal vault;

    address internal keeper;
    address internal user;
    address internal other;

    function setUp() public virtual {
        keeper = address(this);
        user = makeAddr("user");
        other = makeAddr("other");

        quote = new MockQuote("Mock USD", "mUSD", 6);
        vm.etch(CoreConstants.CORE_WRITER, type(MockCoreWriter).runtimeCode);
        vm.etch(CoreConstants.SPOT_BALANCE_PRECOMPILE, type(MockSpotBalance).runtimeCode);
        writer = MockCoreWriter(CoreConstants.CORE_WRITER);

        sim = new CoreSim(quote, SYSTEM_ADDR, TOKEN_INDEX, MULT, DIV);
        vault = new OutcomeVault(
            IERC20(address(quote)), SYSTEM_ADDR, TOKEN_INDEX, MULT, DIV, QUESTION, OUTCOME, keeper, "BTC100K", 6
        );
        sim.setVault(address(vault));

        quote.mint(user, 1_000e6);
        vm.prank(user);
        quote.approve(address(vault), type(uint256).max);
    }

    /// Full happy-path deposit: user deposits `amount`, Core processes, pair minted.
    function depositAndClaim(uint256 amount) internal {
        vm.prank(user);
        vault.deposit(amount);
        sim.processAll();
        vault.claimDeposit();
    }
}
