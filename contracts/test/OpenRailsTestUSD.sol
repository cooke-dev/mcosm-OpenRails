// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    ERC20
} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {
    Ownable
} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title OpenRails Test USD
 * @notice Six-decimal test settlement token for GIWA Sepolia.
 * @dev This is not USDC and must never be represented as canonical USDC.
 */
contract OpenRailsTestUSD is ERC20, Ownable {
    uint256 public constant INITIAL_SUPPLY =
        10_000_000 * 10 ** 6;

    constructor()
        ERC20("OpenRails Test USD", "orUSD")
        Ownable(msg.sender)
    {
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(
        address recipient,
        uint256 amount
    ) external onlyOwner {
        require(recipient != address(0), "orUSD: zero recipient");
        _mint(recipient, amount);
    }
}
