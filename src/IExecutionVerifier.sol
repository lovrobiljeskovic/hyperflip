// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Attests whether a queued Core action executed.
interface IExecutionVerifier {
    enum Status {
        Pending,
        Executed,
        Failed
    }

    /// opKey = keccak256(abi.encode(vault, opId))
    function statusOf(bytes32 opKey) external view returns (Status);
}
