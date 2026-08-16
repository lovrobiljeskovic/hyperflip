// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Seam between OutcomeVault and whatever attests off-chain execution
/// (today: a keeper; later: something less trusted).
interface IExecutionVerifier {
    enum Status {
        Pending,
        Executed,
        Failed
    }

    /// opKey = keccak256(abi.encode(vault, opId))
    function statusOf(bytes32 opKey) external view returns (Status);
}
