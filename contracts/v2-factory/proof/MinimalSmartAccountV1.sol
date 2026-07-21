// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal deployed EIP-1271 smart account, used to prove a real Circle-Smart-Account-style
/// open against the live OpenRails V2 Hub on Arc testnet (not just a local Hardhat mock).
/// `isValidSignature` verifies a 65-byte ECDSA signature against a fixed owner — the same
/// verification shape Circle Smart Accounts and most ERC-4337 wallets use for EIP-1271.
/// `approveToken` is the only state-changing entrypoint, owner-gated, used solely to approve the
/// Hub to pull the USDC this account escrows — mirroring what a real smart account's
/// session-key/execute path would do, without adding a general-purpose arbitrary-call surface.
contract MinimalSmartAccountV1 {
    bytes4 private constant MAGICVALUE = 0x1626ba7e;
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 0x20))
            v := byte(0, calldataload(add(signature.offset, 0x40)))
        }
        address recovered = ecrecover(hash, v, r, s);
        if (recovered != address(0) && recovered == owner) {
            return MAGICVALUE;
        }
        return 0xffffffff;
    }

    function approveToken(address token, address spender, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        (bool ok, ) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        require(ok, "approve failed");
    }
}
