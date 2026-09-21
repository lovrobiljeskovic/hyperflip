// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOutcomeLeg} from "./IOutcomeLeg.sol";
import {OutcomeLeg} from "./OutcomeLeg.sol";

/// Stock Nitro delayed inbox, the one call we use. Elysium bridges with HYPE
/// as msg.value (canonical bridge, per Kinetiq docs), so this is the native
/// value variant, not ERC20Inbox.
interface IInbox {
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);
}

/// HyperEVM side of Elysium settlement. Permissionless: anyone pays the
/// retryable fees and pushes a settled OutcomeVault's fraction up to its
/// OutcomeLeg. The fraction is read on-chain here, so the caller chooses
/// only *when*, never *what*; the leg checks the vault it mirrors.
contract SettlementRelay {
    IInbox public immutable inbox;

    event Relayed(address indexed vault, address indexed leg, uint256 fractionWad, uint256 ticketId);

    constructor(IInbox inbox_) {
        require(address(inbox_) != address(0), "ZERO_ADDRESS");
        inbox = inbox_;
    }

    /// Fee params are the caller's (stock retryable pricing; refunds go back
    /// to the caller on Elysium). Reverts if the vault has not settled — a
    /// live market can never be relayed.
    function relay(address vault, address leg, uint256 maxSubmissionCost, uint256 gasLimit, uint256 maxFeePerGas)
        external
        payable
        returns (uint256 ticketId)
    {
        require(IOutcomeLeg(vault).settled(), "NOT_SETTLED");
        uint256 fractionWad = IOutcomeLeg(vault).settleFractionWad();
        bytes memory data = abi.encodeCall(OutcomeLeg.receiveSettlement, (vault, fractionWad));
        ticketId = inbox.createRetryableTicket{value: msg.value}(
            leg, 0, maxSubmissionCost, msg.sender, msg.sender, gasLimit, maxFeePerGas, data
        );
        emit Relayed(vault, leg, fractionWad, ticketId);
    }
}
