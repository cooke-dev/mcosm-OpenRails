// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title OpenRails V2 Initializable Clearinghouse Ledger Prototype
 */
interface ISettlementToken {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ArcOpenRailsHubV2Initializable {
    // =========================================================================
    //                        Reentrancy Guard
    // =========================================================================
    uint256 private _status;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // =========================================================================
    //                        Ownable2Step
    // =========================================================================
    address public owner;
    address public pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Ownable: caller is not the owner");
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Ownable: new owner is the zero address");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Ownable2Step: caller is not the new owner");
        address oldOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }

    // =========================================================================
    //                        Pausable Circuit Breaker
    // =========================================================================
    bool public isPaused;

    event Paused(address account);
    event Unpaused(address account);

    modifier whenNotPaused() {
        require(!isPaused, "Pausable: paused");
        _;
    }

    function pause() external onlyOwner {
        isPaused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        isPaused = false;
        emit Unpaused(msg.sender);
    }

    // =========================================================================
    //                        2D Nonce Mapping
    // =========================================================================
    mapping(address => mapping(uint256 => uint256)) public accountNonceTracks;

    function _consumeNonce(address account, uint256 channel, uint256 expectedNonce) internal {
        require(accountNonceTracks[account][channel] == expectedNonce, "Nonce: invalid nonce");
        accountNonceTracks[account][channel] = expectedNonce + 1;
    }

    // --- Constant Event Log Matrix ---
    event PaycardProvisioned(
        bytes32 indexed paycardId,
        address indexed payer,
        address indexed recipient,
        bytes32 metadataHash,
        uint256 poolAllocation,
        uint256 flowVelocityPerSecond,
        uint256 genesisTimestamp,
        uint256 lifespanSeconds
    );
    event SettlementFlushed(bytes32 indexed paycardId, address indexed recipient, uint256 amountWithdrawn);
    event ResidualDeltaReclaimed(bytes32 indexed paycardId, address indexed recoveryVault, uint256 varianceSwept);

    // --- Structural Guard Failures ---
    error TimeWindowClosed();
    error AccessViolation();
    error CryptographicCollision();
    error BalanceExhausted();
    error InvalidIntent();

    enum ChannelStatus { Active, Terminated }

    struct PaycardRegistry {
        address payer;
        address recipient;
        bytes32 metadataHash;
        uint256 totalAllocationPool;
        uint256 availableBalance;
        uint256 flowVelocityPerSecond;
        uint256 genesisTimestamp;
        uint256 lifespanSeconds;
        uint256 lastCheckpointEpoch;
        address residualDeltaRecipient;
        ChannelStatus operationalStatus;
    }

    struct OpenParams {
        bytes32 paycardId;
        bytes32 metadataHash;
        address signedRecipient;
        address storedRecipient;
        uint256 totalAllocationPool;
        uint256 flowVelocityPerSecond;
        uint256 genesisTimestamp;
        uint256 lifespanSeconds;
        address residualDeltaRecipient;
        bytes envelopeSignature;
        uint256 nonceChannel;
        uint256 nonceValue;
        address payer;
    }

    // Storage variables (not immutable in proxy context)
    ISettlementToken public settlementToken;
    bytes32 public DOMAIN_SEPARATOR;
    bool private _initialized;

    // Global map of unique, one-time Paycard cryptographic hashes to active states
    mapping(bytes32 => PaycardRegistry) public registry;

    // EIP-712 Structural Schema Signatures
    bytes32 private constant ENVELOPE_TYPEHASH = keccak256(
        "SettlementIntent(bytes32 paycardId,bytes32 metadataHash,address recipient,uint256 totalAllocationPool,uint256 flowVelocityPerSecond,uint256 genesisTimestamp,uint256 lifespanSeconds,address residualDeltaRecipient,uint256 nonceChannel,uint256 nonceValue)"
    );
    // Constructor seals master implementation
    constructor() {
        _initialized = true;
    }

    /**
     * @notice Initializer sets clearing token and owner dynamically in proxy context.
     */
    function initialize(address _tokenAddress, address _owner) external {
        require(!_initialized, "Contract already initialized");
        _initialized = true;

        if (_tokenAddress == address(0)) revert InvalidIntent();
        settlementToken = ISettlementToken(_tokenAddress);

        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);

        _status = _NOT_ENTERED;

        uint256 chainId;
        assembly { chainId := chainid() }
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("OpenRails Network"),
            keccak256("2.0.0"),
            chainId,
            address(this)
        ));
    }


    /**
     * @notice Compatibility getter retained for existing Arc SDK consumers.
     * @dev New integrations should use settlementToken().
     */
    function arcUsdc() external view returns (address) {
        return address(settlementToken);
    }

    // =========================================================================
    //                  SafeERC20-style Internal Wrappers
    // =========================================================================

    function _safeTransfer(ISettlementToken token, address to, uint256 value) internal {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transfer.selector, to, value)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "SafeERC20: transfer failed");
    }

    function _safeTransferFrom(ISettlementToken token, address from, address to, uint256 value) internal {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.transferFrom.selector, from, to, value)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "SafeERC20: transferFrom failed");
    }

    // =========================================================================
    //                        Core Functions
    // =========================================================================

    function openPaycardChannel(
        bytes32 paycardId,
        bytes32 metadataHash,
        address recipient,
        uint256 totalAllocationPool,
        uint256 flowVelocityPerSecond,
        uint256 genesisTimestamp,
        uint256 lifespanSeconds,
        address residualDeltaRecipient,
        bytes calldata envelopeSignature,
        uint256 nonceChannel,
        uint256 nonceValue,
        address payer
    ) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert InvalidIntent();
        _openPaycardChannel(OpenParams({
            paycardId: paycardId,
            metadataHash: metadataHash,
            signedRecipient: recipient,
            storedRecipient: recipient,
            totalAllocationPool: totalAllocationPool,
            flowVelocityPerSecond: flowVelocityPerSecond,
            genesisTimestamp: genesisTimestamp,
            lifespanSeconds: lifespanSeconds,
            residualDeltaRecipient: residualDeltaRecipient,
            envelopeSignature: envelopeSignature,
            nonceChannel: nonceChannel,
            nonceValue: nonceValue,
            payer: payer
        }));
    }

    function claimWildcardPaycardChannel(
        bytes32 paycardId,
        bytes32 metadataHash,
        address claimRecipient,
        uint256 totalAllocationPool,
        uint256 flowVelocityPerSecond,
        uint256 genesisTimestamp,
        uint256 lifespanSeconds,
        address residualDeltaRecipient,
        bytes calldata envelopeSignature,
        uint256 nonceChannel,
        uint256 nonceValue,
        address payer
    ) external nonReentrant whenNotPaused {
        if (claimRecipient == address(0)) revert InvalidIntent();
        _openPaycardChannel(OpenParams({
            paycardId: paycardId,
            metadataHash: metadataHash,
            signedRecipient: address(0),
            storedRecipient: claimRecipient,
            totalAllocationPool: totalAllocationPool,
            flowVelocityPerSecond: flowVelocityPerSecond,
            genesisTimestamp: genesisTimestamp,
            lifespanSeconds: lifespanSeconds,
            residualDeltaRecipient: residualDeltaRecipient,
            envelopeSignature: envelopeSignature,
            nonceChannel: nonceChannel,
            nonceValue: nonceValue,
            payer: payer
        }));
    }

    function processDripSettle(bytes32 paycardId) external nonReentrant {
        PaycardRegistry storage card = registry[paycardId];
        if (card.operationalStatus != ChannelStatus.Active) revert AccessViolation();
        _settlePaycard(paycardId, card);
    }

    function flushResidualDelta(bytes32 paycardId) external nonReentrant {
        PaycardRegistry storage card = registry[paycardId];
        if (msg.sender != card.payer && msg.sender != card.recipient) revert AccessViolation();
        if (card.operationalStatus == ChannelStatus.Terminated) revert AccessViolation();

        _settlePaycard(paycardId, card);
        if (card.operationalStatus == ChannelStatus.Terminated) return;

        uint256 residualDelta = card.availableBalance;
        card.availableBalance = 0;
        card.operationalStatus = ChannelStatus.Terminated;

        if (residualDelta > 0) {
            _safeTransfer(settlementToken, card.residualDeltaRecipient, residualDelta);
            emit ResidualDeltaReclaimed(paycardId, card.residualDeltaRecipient, residualDelta);
        }
    }

    function _openPaycardChannel(OpenParams memory params) internal {
        if (registry[params.paycardId].payer != address(0)) revert CryptographicCollision();
        if (params.metadataHash == bytes32(0)) revert InvalidIntent();
        if (params.totalAllocationPool == 0 || params.residualDeltaRecipient == address(0)) revert InvalidIntent();
        if (params.lifespanSeconds > 0 && params.flowVelocityPerSecond == 0) revert InvalidIntent();
        if (params.lifespanSeconds > 0 && block.timestamp >= params.genesisTimestamp + params.lifespanSeconds) revert TimeWindowClosed();
        if (params.payer == address(0)) revert InvalidIntent();

        address payer = params.payer;
        {
            bytes32 structHash = keccak256(abi.encode(
                ENVELOPE_TYPEHASH,
                params.paycardId,
                params.metadataHash,
                params.signedRecipient,
                params.totalAllocationPool,
                params.flowVelocityPerSecond,
                params.genesisTimestamp,
                params.lifespanSeconds,
                params.residualDeltaRecipient,
                params.nonceChannel,
                params.nonceValue
            ));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
            if (!SignatureChecker.isValidSignatureNow(payer, digest, params.envelopeSignature)) revert AccessViolation();
        }

        _consumeNonce(payer, params.nonceChannel, params.nonceValue);
        _safeTransferFrom(settlementToken, payer, address(this), params.totalAllocationPool);

        PaycardRegistry storage card = registry[params.paycardId];
        card.payer = payer;
        card.recipient = params.storedRecipient;
        card.metadataHash = params.metadataHash;
        card.totalAllocationPool = params.totalAllocationPool;
        card.availableBalance = params.totalAllocationPool;
        card.flowVelocityPerSecond = params.flowVelocityPerSecond;
        card.genesisTimestamp = params.genesisTimestamp;
        card.lifespanSeconds = params.lifespanSeconds;
        card.lastCheckpointEpoch = params.genesisTimestamp;
        card.residualDeltaRecipient = params.residualDeltaRecipient;
        card.operationalStatus = ChannelStatus.Active;

        emit PaycardProvisioned(
            params.paycardId,
            payer,
            params.storedRecipient,
            params.metadataHash,
            params.totalAllocationPool,
            params.flowVelocityPerSecond,
            params.genesisTimestamp,
            params.lifespanSeconds
        );
    }

    function _settlePaycard(bytes32 paycardId, PaycardRegistry storage card) internal {
        uint256 accruedDebt;
        uint256 evaluatedEpoch = card.lastCheckpointEpoch;

        if (card.lifespanSeconds == 0) {
            accruedDebt = card.availableBalance;
            evaluatedEpoch = block.timestamp;
        } else {
            if (block.timestamp <= card.lastCheckpointEpoch) return;
            uint256 staticHorizon = card.genesisTimestamp + card.lifespanSeconds;
            evaluatedEpoch = block.timestamp > staticHorizon ? staticHorizon : block.timestamp;
            if (evaluatedEpoch <= card.lastCheckpointEpoch) return;

            uint256 elapsedDelta;
            unchecked {
                elapsedDelta = evaluatedEpoch - card.lastCheckpointEpoch;
            }
            accruedDebt = elapsedDelta * card.flowVelocityPerSecond;
        }

        if (accruedDebt == 0) return;

        if (accruedDebt >= card.availableBalance) {
            uint256 finalPayout = card.availableBalance;
            card.availableBalance = 0;
            card.lastCheckpointEpoch = evaluatedEpoch;
            card.operationalStatus = ChannelStatus.Terminated;

            _safeTransfer(settlementToken, card.recipient, finalPayout);
            emit SettlementFlushed(paycardId, card.recipient, finalPayout);
        } else {
            unchecked {
                card.availableBalance -= accruedDebt;
            }
            card.lastCheckpointEpoch = evaluatedEpoch;

            _safeTransfer(settlementToken, card.recipient, accruedDebt);
            emit SettlementFlushed(paycardId, card.recipient, accruedDebt);
        }
    }

}
