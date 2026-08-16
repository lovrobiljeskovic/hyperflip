// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// One side of a wrapped HIP-4 outcome (oYES or oNO). Minted and burned only
/// by the OutcomeVault that deployed it; freely transferable otherwise.
contract OutcomeToken is ERC20 {
    address public immutable vault;
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        vault = msg.sender;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        to;
        amount;
        revert("NOT_IMPLEMENTED");
    }

    function burn(address from, uint256 amount) external {
        from;
        amount;
        revert("NOT_IMPLEMENTED");
    }
}
