// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {CoreConstants} from "../../src/CoreConstants.sol";

/// Freely mintable quote-token stand-in (collateral identity is a spike question).
contract MockQuote is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Etched at the real CoreWriter address. Records every payload verbatim so
/// tests can assert byte-exact encodings; CoreSim consumes the queue to model
/// HyperCore's asynchronous execution.
contract MockCoreWriter {
    bytes[] public payloads;
    uint256 public processedCount;

    function sendRawAction(bytes calldata data) external {
        payloads.push(data);
    }

    function payloadCount() external view returns (uint256) {
        return payloads.length;
    }

    function lastPayload() external view returns (bytes memory) {
        return payloads[payloads.length - 1];
    }

    function getPayload(uint256 i) external view returns (bytes memory) {
        return payloads[i];
    }

    function markProcessed(uint256 n) external {
        processedCount = n;
    }

    /// Models Core silently rejecting all queued-but-unprocessed actions.
    function dropPending() external {
        processedCount = payloads.length;
    }
}

/// Etched at the real spot-balance precompile address. The precompile is
/// called with raw abi.encode(user, token) — no selector — so queries land in
/// the fallback; `set` has a normal selector and never collides.
contract MockSpotBalance {
    mapping(address => mapping(uint64 => uint64)) public total;

    function set(address user, uint64 token, uint64 amount) external {
        total[user][token] = amount;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        (address user, uint64 token) = abi.decode(data, (address, uint64));
        return abi.encode(total[user][token], uint64(0), uint64(0));
    }
}

/// Etched at the outcome-status precompile (0x814). `set` has a normal
/// selector; reads land in the fallback via raw abi.encode(outcome), mirroring
/// MockSpotBalance's convention. Models the pruning risk: a test can flip a
/// settled outcome (status 2, value readable) to pruned (status 3, value gone).
contract MockOutcomeStatus {
    uint8 internal _status;
    uint64 internal _settledValue;
    uint32 internal _question;

    function set(uint8 status_, uint64 settledValue_, uint32 question_) external {
        _status = status_;
        _settledValue = settledValue_;
        _question = question_;
    }

    /// Core drops settledValue when it prunes — observed within ~10 minutes.
    function prune() external {
        _status = 3;
        _settledValue = 0;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(_status, _settledValue, _question);
    }
}

/// Etched at CORE_DEPOSIT_WALLET. The real EVM→Core USDC path is approve +
/// `deposit(amount, 4294967295)` here (FINDINGS.md #3); deposited quote sits in
/// this contract until CoreSim credits it to the vault's Core balance.
/// `quote` is set post-etch because vm.etch does not carry immutables.
contract MockCoreDepositWallet {
    IERC20 public quote;

    function setQuote(IERC20 quote_) external {
        quote = quote_;
    }

    function deposit(uint256 amount, uint32 sentinel) external {
        require(sentinel == CoreConstants.CORE_DEPOSIT_SENTINEL, "BAD_SENTINEL");
        quote.transferFrom(msg.sender, address(this), amount);
    }
}
