import { expect } from "chai";
import { ethers } from "hardhat";

import {
  GIWA_SEPOLIA_CHAIN_ID,
  GIWA_SEPOLIA_OPENRAILS,
  buildRailsFlowDraft,
  getOpenRailsNetworkByChainId,
  resolveOpenRailsSettlementToken,
  toEip155ChainIdHex,
  toWalletNetworkParams,
} from "../sdk/src";

describe(
  "OpenRails GIWA SDK foundation",
  function () {
    it(
      "exposes the canonical GIWA deployment preset",
      function () {
        const network =
          getOpenRailsNetworkByChainId(
            GIWA_SEPOLIA_CHAIN_ID,
          );

        expect(network.chainId).to.equal(
          91342,
        );

        expect(
          network.contracts
            .canonicalVault,
        ).to.equal(
          "0x623daf607A0C8F841a72012BCE19cfe9E5fbAbf1",
        );

        expect(
          network.settlementToken.symbol,
        ).to.equal("orUSD");

        expect(
          network.settlementToken.decimals,
        ).to.equal(6);

        expect(
          network.settlementToken.testOnly,
        ).to.equal(true);
      },
    );

    it(
      "produces wallet parameters for GIWA",
      function () {
        const params =
          toWalletNetworkParams();

        expect(params.chainId).to.equal(
          91342,
        );

        expect(
          toEip155ChainIdHex(
            params.chainId,
          ),
        ).to.equal("0x164ce");

        expect(params.rpcUrls).to.deep.equal([
          "https://sepolia-rpc.giwa.io",
        ]);
      },
    );

    it(
      "builds an unsigned bounded GIWA RailsFlow draft",
      function () {
        const draft =
          buildRailsFlowDraft({
            payerAddress:
              "0x1111111111111111111111111111111111111111",
            recipientAddress:
              "0x2222222222222222222222222222222222222222",
            totalAllocationBaseUnits:
              "1000000",
            flowVelocityBaseUnitsPerSecond:
              "1000",
            genesisTimestamp:
              1_800_000_000,
            lifespanSeconds: 600,
            nonceChannel: 7,
            nonceValue: 0,
            metadataRef:
              "test:giwa-sdk",
          });

        expect(
          draft.network.chainId,
        ).to.equal(91342);

        expect(
          draft.network
            .clearinghouseAddress,
        ).to.equal(
          GIWA_SEPOLIA_OPENRAILS
            .contracts.canonicalVault,
        );

        expect(
          draft.approval.tokenAddress,
        ).to.equal(
          GIWA_SEPOLIA_OPENRAILS
            .settlementToken.address,
        );

        expect(
          draft.approval.spender,
        ).to.equal(
          GIWA_SEPOLIA_OPENRAILS
            .contracts.canonicalVault,
        );

        expect(
          draft.typedData.domain.chainId,
        ).to.equal(91342);

        expect(
          draft.typedData.domain
            .verifyingContract,
        ).to.equal(
          GIWA_SEPOLIA_OPENRAILS
            .contracts.canonicalVault,
        );

        expect(
          ethers.isHexString(
            draft.intent.paycardId,
            32,
          ),
        ).to.equal(true);

        expect(
          ethers.isHexString(
            draft.metadataHash,
            32,
          ),
        ).to.equal(true);

        expect(
          draft.economics
            .projectedFullTermAmountBaseUnits,
        ).to.equal("600000");

        expect(
          draft.economics
            .fullyFundedForLifespan,
        ).to.equal(true);

        expect(
          resolveOpenRailsSettlementToken({
            chainId: 91342,
            clearinghouseAddress:
              draft.network
                .clearinghouseAddress,
            settlementTokenAddress:
              draft.network
                .settlementTokenAddress,
          }),
        ).to.equal(
          GIWA_SEPOLIA_OPENRAILS
            .settlementToken.address,
        );
      },
    );
  },
);
