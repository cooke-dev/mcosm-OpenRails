// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IERC20Like {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/// @notice Test-only stand-in for Circle's real `GatewayWallet` (deposit side only — the SDK's
/// `depositToGateway`/`depositForToGateway` only ever call `deposit`/`depositFor`). Mirrors the
/// real ABI's function signatures so `sdk/src/gateway.ts` is exercised unmodified.
contract MockGatewayWallet {
    mapping(bytes32 => uint256) public totalBalanceOf;

    event Deposited(address indexed token, address indexed depositor, uint256 value);

    function _key(address token, address depositor) internal pure returns (bytes32) {
        return keccak256(abi.encode(token, depositor));
    }

    function deposit(address token, uint256 value) external {
        require(IERC20Like(token).transferFrom(msg.sender, address(this), value), "transferFrom failed");
        totalBalanceOf[_key(token, msg.sender)] += value;
        emit Deposited(token, msg.sender, value);
    }

    function depositFor(address token, address depositor, uint256 value) external {
        require(IERC20Like(token).transferFrom(msg.sender, address(this), value), "transferFrom failed");
        totalBalanceOf[_key(token, depositor)] += value;
        emit Deposited(token, depositor, value);
    }

    function totalBalance(address token, address depositor) external view returns (uint256) {
        return totalBalanceOf[_key(token, depositor)];
    }

    function availableBalance(address token, address depositor) external view returns (uint256) {
        return totalBalanceOf[_key(token, depositor)];
    }
}

/// @notice Test-only stand-in for Circle's real `GatewayMinter`. The real contract verifies a
/// Circle-signed attestation off-chain payload; this mock just records the call so
/// `sdk/src/gateway.ts`'s `mintFromGateway` wiring (contract address, function selector, args,
/// returned tx hash) is exercised without needing a real Circle attestation.
contract MockGatewayMinter {
    bytes public lastAttestationPayload;
    bytes public lastSignature;
    uint256 public callCount;

    event Minted(bytes attestationPayload, bytes signature);

    function gatewayMint(bytes calldata attestationPayload, bytes calldata signature) external {
        lastAttestationPayload = attestationPayload;
        lastSignature = signature;
        callCount += 1;
        emit Minted(attestationPayload, signature);
    }
}
