import { expect } from "chai";
import { ethers } from "ethers";

import {
  assertExactNonceBeforeApproval,
  parseOpenRailsCliArgs,
  runOpenRailsCli,
} from "../sdk/src/cli";
import { parseOpenRailsLink } from "../sdk/src/links";

const HUB = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const MERCHANT = "0x0000000000000000000000000000000000000003";
const RECIPIENT = "0x0000000000000000000000000000000000000004";
const RECOVERY = "0x0000000000000000000000000000000000000005";
const BYTES32 = ethers.keccak256(ethers.toUtf8Bytes("openrails-cli-test"));

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runOpenRailsCli(args, env, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return {
    code,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
  };
}

describe("OpenRails CLI", () => {
  it("prints root and command help", async () => {
    const root = await runCli(["--help"]);
    expect(root.code).to.equal(0);
    expect(root.stdout).to.include("request-stream");
    expect(root.stdout).to.include("pay-stream");

    const command = await runCli(["close", "--help"]);
    expect(command.code).to.equal(0);
    expect(command.stdout).to.include("openrails close");
    expect(command.stdout).to.include("--execute");
    expect(command.stdout).to.include("--ack-irrevocable-close");
    // per-command help must be command-specific, not the generic root listing
    expect(command.stdout).to.not.include("request-stream");

    const payStream = await runCli(["pay-stream", "--help"]);
    expect(payStream.stdout).to.include("--total-allocation-pool");
    expect(payStream.stdout).to.include("--sign-only");
  });

  it("rejects private key material on argv", () => {
    expect(() =>
      parseOpenRailsCliArgs(["pay-stream", "--private-key", "0xabc"])
    ).to.throw("Private keys must not be passed on argv");
    expect(() =>
      parseOpenRailsCliArgs(["pay-stream", "--payer-private-key-file", "secret"])
    ).to.throw("Private keys must not be passed on argv");
  });

  it("defaults transaction commands to dry-run without signer access", async () => {
    const result = await runCli([
      "settle",
      "--hub",
      HUB,
      "--paycard-id",
      BYTES32,
    ]);

    expect(result.code).to.equal(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.command).to.equal("settle");
    expect(parsed.dryRun).to.equal(true);
    expect(parsed.action).to.equal("submit_settlement_transaction_preview");
  });

  it("builds parseable request-stream links", async () => {
    const result = await runCli([
      "request-stream",
      "--execute",
      "--chain-id",
      "5042002",
      "--hub",
      HUB,
      "--token",
      TOKEN,
      "--metadata-hash",
      BYTES32,
      "--merchant",
      MERCHANT,
      "--recipient",
      RECIPIENT,
      "--amount",
      "1000000",
      "--flow-velocity-per-second",
      "10",
      "--lifespan-seconds",
      "3600",
      "--app-base-url",
      "https://example.test/app",
    ]);

    expect(result.code).to.equal(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.dryRun).to.equal(false);
    const artifact = parseOpenRailsLink(parsed.link);
    expect(artifact.kind).to.equal("railsflow");
    expect(artifact.chainId).to.equal(5042002);
    expect(artifact.vault).to.equal(ethers.getAddress(HUB));
    expect(artifact.metadataHash).to.equal(BYTES32);
  });

  it("signs pay-stream links from signer env only", async () => {
    const wallet = ethers.Wallet.createRandom();
    const paycardId = ethers.keccak256(ethers.toUtf8Bytes("signed-cli-paycard"));
    const result = await runCli(
      [
        "pay-stream",
        "--sign-only",
        "--signer-env",
        "CLI_TEST_PRIVATE_KEY",
        "--chain-id",
        "5042002",
        "--hub",
        HUB,
        "--token",
        TOKEN,
        "--paycard-id",
        paycardId,
        "--metadata-hash",
        BYTES32,
        "--recipient",
        RECIPIENT,
        "--total-allocation-pool",
        "1000000",
        "--flow-velocity-per-second",
        "10",
        "--lifespan-seconds",
        "3600",
        "--residual-delta-recipient",
        RECOVERY,
        "--nonce-channel",
        "7",
        "--nonce-value",
        "1",
      ],
      { CLI_TEST_PRIVATE_KEY: wallet.privateKey }
    );

    expect(result.code).to.equal(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.payerAddress).to.equal(wallet.address);
    expect(parsed.dryRun).to.equal(true);
    expect(parsed.envelopeToken).to.be.a("string");
    const artifact = parseOpenRailsLink(parsed.link);
    expect("envelopeToken" in artifact.payload).to.equal(true);
  });

  it("gates close execution behind explicit confirmation", async () => {
    const dryRun = await runCli([
      "close",
      "--hub",
      HUB,
      "--paycard-id",
      BYTES32,
    ]);
    expect(dryRun.code).to.equal(0);
    expect(JSON.parse(dryRun.stdout).closeGate).to.include("--ack-irrevocable-close");

    const blocked = await runCli([
      "close",
      "--execute",
      "--hub",
      HUB,
      "--paycard-id",
      BYTES32,
    ]);
    expect(blocked.code).to.equal(1);
    expect(blocked.stderr).to.include("close requires --ack-irrevocable-close");
  });

  it("requires exact nonce before any executable open approval", () => {
    expect(() => assertExactNonceBeforeApproval(7, 6)).to.throw(
      "--nonce-value must equal current nonce"
    );
    expect(() => assertExactNonceBeforeApproval(5, 6)).to.throw(
      "--nonce-value must equal current nonce"
    );
    expect(() => assertExactNonceBeforeApproval(6, 6)).not.to.throw();
  });
});
