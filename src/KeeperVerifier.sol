// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IExecutionVerifier} from "./IExecutionVerifier.sol";

/// Keeper-attested IExecutionVerifier. The keeper posts a verdict once per
/// opKey; statusOf holds it at Pending for `minDelay` after attestation so a
/// bad attestation can be paused before OutcomeVault acts on it. Delay is a
/// blast-radius control, not a trustless challenge window.
/// Owner = deployer EOA for testnet; mainnet: replace with a timelock.
contract KeeperVerifier is IExecutionVerifier {
    struct Attestation {
        bool attested;
        bool executed;
        uint64 timestamp;
    }

    address public owner;
    address public keeper;
    uint256 public minDelay = 10 minutes;
    bool public paused;

    mapping(bytes32 => Attestation) public attestations;

    event Attested(bytes32 indexed opKey, bool executed);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    modifier onlyKeeper() {
        require(msg.sender == keeper, "NOT_KEEPER");
        _;
    }

    constructor(address keeper_) {
        owner = msg.sender;
        keeper = keeper_;
    }

    function attest(bytes32 opKey, bool executed) external onlyKeeper {
        require(!attestations[opKey].attested, "ALREADY_ATTESTED");
        attestations[opKey] = Attestation({attested: true, executed: executed, timestamp: uint64(block.timestamp)});
        emit Attested(opKey, executed);
    }

    function statusOf(bytes32 opKey) external view returns (Status) {
        if (paused) return Status.Pending;
        Attestation memory a = attestations[opKey];
        if (!a.attested || block.timestamp < a.timestamp + minDelay) return Status.Pending;
        return a.executed ? Status.Executed : Status.Failed;
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
    }

    function setMinDelay(uint256 minDelay_) external onlyOwner {
        minDelay = minDelay_;
    }

    function pause() external onlyOwner {
        paused = true;
    }

    function unpause() external onlyOwner {
        paused = false;
    }
}
