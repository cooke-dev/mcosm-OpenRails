import { expect } from "chai";
import { ethers } from "hardhat";

import { turnkeyToAccount, type TurnkeyLikeSigner } from "../sdk/src/adapters/turnkey";
import {
  LeptonOpenRailsClient,
  OPENRAILS_EIP712_TYPES,
  buildOpenRailsDomain,
  buildSettlementIntentValue,
  type OpenRailsIntentV1,
  type CryptographicEnvelopeV1,
} from "../sdk/src/client";

const HUB = "0x941C8029F0f912df3fAb7423890ab2359b996D0b"; // V2 canonical hub
const CHAIN_ID = 5042002;
const B32 = ethers.keccak256(ethers.toUtf8Bytes("turnkey-adapter-test"));

function makeIntent(recipient: string): OpenRailsIntentV1 {
  return {
    paycardId: B32,
    metadataHash: B32,
    recipient,
    totalAllocationPool: "2000",
    flowVelocityPerSecond: "0",
    genesisTimestamp: Math.floor(Date.now() / 1000),
    lifespanSeconds: 0,
    residualDeltaRecipient: recipient,
    nonceChannel: 0,
    nonceValue: 0,
  };
}

describe("turnkeyToAccount (Turnkey Adapter)", () => {
  it("produces a signature that recovers to the Turnkey-signed wallet address", async () => {
    const wallet = ethers.Wallet.createRandom();

    // A minimal stand-in for @turnkey/ethers' TurnkeySigner (getAddress + signTypedData) — the
    // exact surface turnkeyToAccount depends on, per its own TurnkeyLikeSigner interface. Backed
    // by a real ethers.Wallet so the resulting signature is independently verifiable.
    const mockTurnkeySigner: TurnkeyLikeSigner = {
      getAddress: async () => wallet.address,
      signTypedData: async (domain, types, value) =>
        wallet.signTypedData(domain as ethers.TypedDataDomain, types as Record<string, ethers.TypedDataField[]>, value as Record<string, unknown>),
    };

    const account = turnkeyToAccount(mockTurnkeySigner);
    expect(account.isSmartAccount).to.equal(undefined); // sign-only EOA path, not a smart account
    expect(await account.getAddress()).to.equal(wallet.address);

    const client = await LeptonOpenRailsClient.fromAccount(account, HUB, CHAIN_ID);
    expect(client.getAddress()).to.equal(wallet.address);

    const intent = makeIntent(wallet.address);
    const token = await client.signPermissionEnvelope(intent);

    const env = LeptonOpenRailsClient.deserializePayload(token) as CryptographicEnvelopeV1;
    const domain = buildOpenRailsDomain(CHAIN_ID, HUB);
    const value = buildSettlementIntentValue(env.intent as unknown as OpenRailsIntentV1);
    const recovered = ethers.verifyTypedData(domain, OPENRAILS_EIP712_TYPES, value, env.envelopeSignature);

    expect(env.payerAddress).to.equal(wallet.address);
    expect(recovered).to.equal(wallet.address);
  });

  it("propagates a signing failure from the underlying Turnkey signer", async () => {
    const failingSigner: TurnkeyLikeSigner = {
      getAddress: async () => ethers.Wallet.createRandom().address,
      signTypedData: async () => {
        throw new Error("Turnkey policy denied this signing request");
      },
    };
    const account = turnkeyToAccount(failingSigner);
    const client = await LeptonOpenRailsClient.fromAccount(account, HUB, CHAIN_ID);
    const intent = makeIntent(await account.getAddress());

    let threw = false;
    try {
      await client.signPermissionEnvelope(intent);
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.include("Turnkey policy denied this signing request");
    }
    expect(threw).to.equal(true);
  });
});
