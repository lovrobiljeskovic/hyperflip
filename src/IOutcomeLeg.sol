// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// What ParlayVault needs from a leg: nothing more than these two views.
/// OutcomeVault (HyperEVM) satisfies it via public getters; OutcomeLeg
/// (Elysium) implements it from a bridged settlement.
interface IOutcomeLeg {
    function settled() external view returns (bool);
    function settleFractionWad() external view returns (uint256);
}
