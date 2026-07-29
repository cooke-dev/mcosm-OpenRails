// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {
    IERC20
} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    SafeERC20
} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    Ownable
} from "@openzeppelin/contracts/access/Ownable.sol";
import {
    Pausable
} from "@openzeppelin/contracts/utils/Pausable.sol";
import {
    ReentrancyGuard
} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title OrUsdFaucet
 * @notice Bounded, pre-funded faucet for OpenRails Test USD on GIWA Sepolia.
 * @dev The faucet has no mint authority. It distributes only its deposited reserve.
 */
contract OrUsdFaucet is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroToken();
    error ZeroClaimAmount();
    error ZeroCooldown();
    error ZeroRecipient();
    error CooldownActive(uint256 nextClaimAt);
    error InsufficientReserve(
        uint256 available,
        uint256 required
    );

    event Claimed(
        address indexed claimant,
        uint256 amount,
        uint256 nextClaimAt
    );

    event ReserveRecovered(
        address indexed recipient,
        uint256 amount
    );

    IERC20 public immutable token;
    uint256 public immutable claimAmount;
    uint64 public immutable cooldown;

    mapping(address account => uint64 timestamp)
        public lastClaimAt;

    constructor(
        IERC20 token_,
        address initialOwner_,
        uint256 claimAmount_,
        uint64 cooldown_
    ) Ownable(initialOwner_) {
        if (address(token_) == address(0)) {
            revert ZeroToken();
        }

        if (claimAmount_ == 0) {
            revert ZeroClaimAmount();
        }

        if (cooldown_ == 0) {
            revert ZeroCooldown();
        }

        token = token_;
        claimAmount = claimAmount_;
        cooldown = cooldown_;
    }

    function nextClaimAt(
        address account
    ) public view returns (uint256) {
        uint64 previousClaim = lastClaimAt[account];

        if (previousClaim == 0) {
            return 0;
        }

        return uint256(previousClaim) + uint256(cooldown);
    }

    function canClaim(
        address account
    ) external view returns (bool) {
        if (paused()) {
            return false;
        }

        if (token.balanceOf(address(this)) < claimAmount) {
            return false;
        }

        uint256 nextClaim = nextClaimAt(account);

        return nextClaim == 0 || block.timestamp >= nextClaim;
    }

    function claim()
        external
        nonReentrant
        whenNotPaused
    {
        uint256 nextClaim = nextClaimAt(msg.sender);

        if (
            nextClaim != 0 &&
            block.timestamp < nextClaim
        ) {
            revert CooldownActive(nextClaim);
        }

        uint256 available =
            token.balanceOf(address(this));

        if (available < claimAmount) {
            revert InsufficientReserve(
                available,
                claimAmount
            );
        }

        lastClaimAt[msg.sender] =
            uint64(block.timestamp);

        token.safeTransfer(msg.sender, claimAmount);

        emit Claimed(
            msg.sender,
            claimAmount,
            block.timestamp + uint256(cooldown)
        );
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Recover some or all of the remaining faucet reserve.
     * @dev This cannot mint tokens or access user balances.
     */
    function recoverReserve(
        address recipient,
        uint256 amount
    ) external onlyOwner {
        if (recipient == address(0)) {
            revert ZeroRecipient();
        }

        token.safeTransfer(recipient, amount);

        emit ReserveRecovered(recipient, amount);
    }
}
