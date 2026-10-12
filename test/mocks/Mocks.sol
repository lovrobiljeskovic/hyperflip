// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {CoreConstants} from "../../src/CoreConstants.sol";

/// Freely mintable quote-token stand-in.
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

/// Etched at the real CoreWriter address; records every payload verbatim.
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
}

/// Etched at the 0x801 address. Reads arrive as raw abi.encode(user, token)
/// with no selector, so they land in the fallback; `set` never collides.
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

/// Etched at the 0x814 address, same fallback convention as MockSpotBalance.
contract MockOutcomeStatus {
    uint8 internal _status;
    uint64 internal _settledValue;
    uint32 internal _question;

    function set(uint8 status_, uint64 settledValue_, uint32 question_) external {
        _status = status_;
        _settledValue = settledValue_;
        _question = question_;
    }

    /// Core drops settledValue when it prunes.
    function prune() external {
        _status = 3;
        _settledValue = 0;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(_status, _settledValue, _question);
    }
}

/// Etched at CORE_DEPOSIT_WALLET; deposited quote sits here until CoreSim
/// credits it. `quote` is set post-etch because vm.etch drops immutables.
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
