// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/**
 * @title AgentBudgetRegistry
 * @notice Part of the OpenRails Agent application layer (not the core rail) — an ASP-facing
 *         control plane for bounded AI-agent budgets, chain-agnostic.
 * @dev IMPORTANT — this registry does NOT enforce spend caps on-chain and does NOT custody funds.
 *      It is an off-chain-checked ledger: `bindPaycard` checks `isSpendAllowed` (cap + velocity)
 *      only at bind time, and the OpenRails Hub has zero awareness of this contract — nothing
 *      here stops a caller from opening a Paycard Stream directly at the Hub for an amount this
 *      registry would reject, if they simply skip calling `bindPaycard`. The only real on-chain
 *      guarantee remains the Hub's own bounded escrow: the amount signed into a RailsFlow/
 *      RailsCard intent. This contract is a monitoring/policy layer for an ASP backend that
 *      voluntarily checks it before opening a stream — useful for demo receipts, halt/revoke, and
 *      budget bookkeeping across multiple Paycard Streams, not a second on-chain bound.
 */
contract AgentBudgetRegistry {
    error InvalidBudget();
    error AccessViolation();
    error BudgetInactive();
    error BudgetExceeded();
    error PaycardAlreadyBound();

    struct AgentBudget {
        address owner;
        address agent;
        address token;
        uint256 maxAllocation;
        uint256 maxVelocityPerSecond;
        uint256 validUntil;
        bool halted;
        bytes32 scopeHash;
        uint256 committedAllocation;
        uint256 paycardCount;
    }

    struct PaycardBinding {
        bytes32 budgetId;
        address recipient;
        uint256 allocation;
        uint256 velocityPerSecond;
        uint256 boundAt;
    }

    mapping(bytes32 => AgentBudget) public budgets;
    mapping(bytes32 => PaycardBinding) public paycardBindings;
    mapping(bytes32 => mapping(uint256 => bytes32)) public budgetPaycards;

    event BudgetCreated(
        bytes32 indexed budgetId,
        address indexed owner,
        address indexed agent,
        address token,
        uint256 maxAllocation,
        uint256 maxVelocityPerSecond,
        uint256 validUntil,
        bytes32 scopeHash
    );
    event BudgetHalted(bytes32 indexed budgetId, address indexed caller);
    event PaycardBound(
        bytes32 indexed budgetId,
        bytes32 indexed paycardId,
        address indexed recipient,
        uint256 allocation,
        uint256 velocityPerSecond
    );

    function createBudget(
        address agent,
        address token,
        uint256 maxAllocation,
        uint256 maxVelocityPerSecond,
        uint256 validUntil,
        bytes32 scopeHash,
        bytes32 salt
    ) external returns (bytes32 budgetId) {
        if (agent == address(0) || token == address(0) || maxAllocation == 0 || maxVelocityPerSecond == 0) {
            revert InvalidBudget();
        }
        if (validUntil != 0 && validUntil <= block.timestamp) revert InvalidBudget();
        if (scopeHash == bytes32(0)) revert InvalidBudget();

        budgetId = keccak256(abi.encode(block.chainid, address(this), msg.sender, agent, token, scopeHash, salt));
        if (budgets[budgetId].owner != address(0)) revert InvalidBudget();

        budgets[budgetId] = AgentBudget({
            owner: msg.sender,
            agent: agent,
            token: token,
            maxAllocation: maxAllocation,
            maxVelocityPerSecond: maxVelocityPerSecond,
            validUntil: validUntil,
            halted: false,
            scopeHash: scopeHash,
            committedAllocation: 0,
            paycardCount: 0
        });

        emit BudgetCreated(budgetId, msg.sender, agent, token, maxAllocation, maxVelocityPerSecond, validUntil, scopeHash);
    }

    function haltBudget(bytes32 budgetId) external {
        AgentBudget storage budget = budgets[budgetId];
        if (budget.owner == address(0)) revert InvalidBudget();
        if (msg.sender != budget.owner && msg.sender != budget.agent) revert AccessViolation();
        if (!budget.halted) {
            budget.halted = true;
            emit BudgetHalted(budgetId, msg.sender);
        }
    }

    function bindPaycard(
        bytes32 budgetId,
        bytes32 paycardId,
        address recipient,
        uint256 allocation,
        uint256 velocityPerSecond
    ) external {
        AgentBudget storage budget = budgets[budgetId];
        if (budget.owner == address(0) || paycardId == bytes32(0) || recipient == address(0)) revert InvalidBudget();
        if (msg.sender != budget.owner && msg.sender != budget.agent) revert AccessViolation();
        if (!isBudgetActive(budgetId)) revert BudgetInactive();
        if (paycardBindings[paycardId].budgetId != bytes32(0)) revert PaycardAlreadyBound();
        if (!isSpendAllowed(budgetId, allocation, velocityPerSecond)) revert BudgetExceeded();

        budget.committedAllocation += allocation;
        uint256 index = budget.paycardCount++;
        budgetPaycards[budgetId][index] = paycardId;
        paycardBindings[paycardId] = PaycardBinding({
            budgetId: budgetId,
            recipient: recipient,
            allocation: allocation,
            velocityPerSecond: velocityPerSecond,
            boundAt: block.timestamp
        });

        emit PaycardBound(budgetId, paycardId, recipient, allocation, velocityPerSecond);
    }

    function isBudgetActive(bytes32 budgetId) public view returns (bool) {
        AgentBudget storage budget = budgets[budgetId];
        return budget.owner != address(0)
            && !budget.halted
            && (budget.validUntil == 0 || block.timestamp <= budget.validUntil);
    }

    function isSpendAllowed(
        bytes32 budgetId,
        uint256 allocation,
        uint256 velocityPerSecond
    ) public view returns (bool) {
        AgentBudget storage budget = budgets[budgetId];
        if (!isBudgetActive(budgetId)) return false;
        if (allocation == 0 || velocityPerSecond == 0) return false;
        if (velocityPerSecond > budget.maxVelocityPerSecond) return false;
        return budget.committedAllocation + allocation <= budget.maxAllocation;
    }

    function getBudgetPaycards(bytes32 budgetId) external view returns (bytes32[] memory ids) {
        AgentBudget storage budget = budgets[budgetId];
        ids = new bytes32[](budget.paycardCount);
        for (uint256 i = 0; i < budget.paycardCount; i++) {
            ids[i] = budgetPaycards[budgetId][i];
        }
    }
}
