import { expect } from "chai";
import { ethers } from "hardhat";

describe("AgentBudgetRegistry", () => {
  let snapshotId: string;

  beforeEach(async () => {
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  afterEach(async () => {
    await ethers.provider.send("evm_revert", [snapshotId]);
  });

  async function deployRegistry() {
    const [owner, agent, recipient, stranger] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory("AgentBudgetRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    const token = ethers.Wallet.createRandom().address;
    const scopeHash = ethers.keccak256(ethers.toUtf8Bytes("paid-content:arc-demo"));
    const salt = ethers.keccak256(ethers.toUtf8Bytes("budget-salt"));
    return { registry, owner, agent, recipient, stranger, token, scopeHash, salt };
  }

  async function createBudget(overrides: Record<string, unknown> = {}) {
    const ctx = await deployRegistry();
    const latest = await ethers.provider.getBlock("latest");
    const validUntil = (latest?.timestamp ?? Math.floor(Date.now() / 1000)) + 3600;
    const args = {
      agent: ctx.agent.address,
      token: ctx.token,
      maxAllocation: ethers.parseUnits("2", 6),
      maxVelocityPerSecond: ethers.parseUnits("0.003", 6),
      validUntil,
      scopeHash: ctx.scopeHash,
      salt: ctx.salt,
      ...overrides,
    };
    const tx = await ctx.registry.connect(ctx.owner).createBudget(
      args.agent as string,
      args.token as string,
      args.maxAllocation as bigint,
      args.maxVelocityPerSecond as bigint,
      args.validUntil as number,
      args.scopeHash as string,
      args.salt as string,
    );
    const receipt = await tx.wait();
    const event = receipt?.logs
      .map((log: any) => {
        try { return ctx.registry.interface.parseLog(log); } catch { return null; }
      })
      .find((parsed: any) => parsed?.name === "BudgetCreated");
    const budgetId = event?.args?.budgetId as string;
    return { ...ctx, args, budgetId };
  }

  it("creates an active bounded budget", async () => {
    const { registry, owner, agent, token, scopeHash, budgetId, args } = await createBudget();

    await expect(
      registry.connect(owner).createBudget(
        agent.address,
        token,
        args.maxAllocation,
        args.maxVelocityPerSecond,
        args.validUntil,
        scopeHash,
        ethers.keccak256(ethers.toUtf8Bytes("second-budget")),
      )
    ).to.emit(registry, "BudgetCreated");

    const budget = await registry.budgets(budgetId);
    expect(budget.owner).to.equal(owner.address);
    expect(budget.agent).to.equal(agent.address);
    expect(budget.token).to.equal(token);
    expect(budget.maxAllocation).to.equal(args.maxAllocation);
    expect(budget.maxVelocityPerSecond).to.equal(args.maxVelocityPerSecond);
    expect(budget.scopeHash).to.equal(scopeHash);
    expect(await registry.isBudgetActive(budgetId)).to.equal(true);
  });

  it("binds paycards within budget and tracks committed allocation", async () => {
    const { registry, agent, recipient, budgetId } = await createBudget();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("paycard-1"));

    await expect(
      registry.connect(agent).bindPaycard(
        budgetId,
        paycardId,
        recipient.address,
        ethers.parseUnits("1", 6),
        ethers.parseUnits("0.002", 6),
      )
    ).to.emit(registry, "PaycardBound").withArgs(
      budgetId,
      paycardId,
      recipient.address,
      ethers.parseUnits("1", 6),
      ethers.parseUnits("0.002", 6),
    );

    const budget = await registry.budgets(budgetId);
    expect(budget.committedAllocation).to.equal(ethers.parseUnits("1", 6));
    expect(await registry.getBudgetPaycards(budgetId)).to.deep.equal([paycardId]);
  });

  it("rejects unauthorized, over-cap, over-velocity, and duplicate bindings", async () => {
    const { registry, stranger, agent, recipient, budgetId } = await createBudget();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("paycard-1"));

    await expect(
      registry.connect(stranger).bindPaycard(
        budgetId,
        paycardId,
        recipient.address,
        ethers.parseUnits("1", 6),
        ethers.parseUnits("0.001", 6),
      )
    ).to.be.revertedWithCustomError(registry, "AccessViolation");

    await expect(
      registry.connect(agent).bindPaycard(
        budgetId,
        ethers.keccak256(ethers.toUtf8Bytes("too-fast")),
        recipient.address,
        ethers.parseUnits("1", 6),
        ethers.parseUnits("0.004", 6),
      )
    ).to.be.revertedWithCustomError(registry, "BudgetExceeded");

    await expect(
      registry.connect(agent).bindPaycard(
        budgetId,
        ethers.keccak256(ethers.toUtf8Bytes("too-large")),
        recipient.address,
        ethers.parseUnits("3", 6),
        ethers.parseUnits("0.001", 6),
      )
    ).to.be.revertedWithCustomError(registry, "BudgetExceeded");

    await registry.connect(agent).bindPaycard(
      budgetId,
      paycardId,
      recipient.address,
      ethers.parseUnits("1", 6),
      ethers.parseUnits("0.001", 6),
    );

    await expect(
      registry.connect(agent).bindPaycard(
        budgetId,
        paycardId,
        recipient.address,
        ethers.parseUnits("0.5", 6),
        ethers.parseUnits("0.001", 6),
      )
    ).to.be.revertedWithCustomError(registry, "PaycardAlreadyBound");
  });

  it("halts budgets by owner or agent and blocks further spend", async () => {
    const { registry, agent, recipient, budgetId } = await createBudget();
    await expect(registry.connect(agent).haltBudget(budgetId))
      .to.emit(registry, "BudgetHalted")
      .withArgs(budgetId, agent.address);

    expect(await registry.isBudgetActive(budgetId)).to.equal(false);
    expect(await registry.isSpendAllowed(budgetId, ethers.parseUnits("1", 6), ethers.parseUnits("0.001", 6))).to.equal(false);

    await expect(
      registry.connect(agent).bindPaycard(
        budgetId,
        ethers.keccak256(ethers.toUtf8Bytes("after-halt")),
        recipient.address,
        ethers.parseUnits("1", 6),
        ethers.parseUnits("0.001", 6),
      )
    ).to.be.revertedWithCustomError(registry, "BudgetInactive");
  });

  it("expires budgets by validUntil", async () => {
    const latest = await ethers.provider.getBlock("latest");
    const shortExpiry = (latest?.timestamp ?? Math.floor(Date.now() / 1000)) + 10;
    const { registry, agent, recipient, budgetId } = await createBudget({ validUntil: shortExpiry });
    await ethers.provider.send("evm_setNextBlockTimestamp", [shortExpiry + 1]);
    await ethers.provider.send("evm_mine", []);

    expect(await registry.isBudgetActive(budgetId)).to.equal(false);
    await expect(
      registry.connect(agent).bindPaycard(
        budgetId,
        ethers.keccak256(ethers.toUtf8Bytes("expired")),
        recipient.address,
        ethers.parseUnits("1", 6),
        ethers.parseUnits("0.001", 6),
      )
    ).to.be.revertedWithCustomError(registry, "BudgetInactive");
  });
});
