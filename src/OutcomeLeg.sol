// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOutcomeLeg} from "./IOutcomeLeg.sol";

/// Elysium-side leg for one HIP-4 outcome. Holds no Core balance. Its
/// settlement arrives from the HyperEVM `SettlementRelay`, which reads the
/// 998 OutcomeVault's stored fraction and sends it up as a retryable ticket.
/// Trust added over 998: the canonical bridge, nothing else — the only caller
/// accepted is the L1→L2 alias of the relay, and the relay only ever forwards
/// what a settled vault stores.
///
/// Phase two (Elysium read precompile): add a `settle()` that reads outcome
/// status directly; this path stays as the fallback.
contract OutcomeLeg is IOutcomeLeg {
    /// Stock Nitro: an L1 contract's calls arrive on L2 from address + this.
    uint160 internal constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    /// HyperEVM OutcomeVault this leg mirrors.
    address public immutable sourceVault;
    /// L2 alias of the HyperEVM SettlementRelay.
    address public immutable aliasedRelay;

    bool public settled;
    uint256 public settleFractionWad;

    event Settled(uint256 fractionWad);

    constructor(address sourceVault_, address relay_) {
        require(sourceVault_ != address(0) && relay_ != address(0), "ZERO_ADDRESS");
        sourceVault = sourceVault_;
        aliasedRelay = address(uint160(relay_) + ALIAS_OFFSET);
    }

    /// Entry point of the relay's retryable ticket. `vault` is echoed by the
    /// relay so a ticket aimed at the wrong leg is rejected here, not trusted.
    function receiveSettlement(address vault, uint256 fractionWad) external {
        require(msg.sender == aliasedRelay, "NOT_RELAY");
        require(vault == sourceVault, "WRONG_VAULT");
        require(!settled, "ALREADY_SETTLED");
        require(fractionWad <= 1e18, "BAD_FRACTION");
        settled = true;
        settleFractionWad = fractionWad;
        emit Settled(fractionWad);
    }
}
