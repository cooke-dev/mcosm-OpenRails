# OpenRails V1: Arc Network EVM Hardfork Compatibility

This document evaluates the compatibility of the Arc Network (arc.io) with newer EVM hardforks (Shanghai and Cancun) and details how to optimize OpenRails contracts for the Arc runtime substrate.

> [!NOTE]
> Planning and analysis note. Confirm current implementation before treating any item as shipped.

---

## 1. Arc Network Execution Layer & Client Context

Arc is an EVM-compatible Layer-1 blockchain built specifically for stablecoin-native finance.

* **Reth Under the Hood:** The execution layer of Arc is powered by **Reth** (Rust Ethereum execution client).
* **Opcode Support:** Because Reth natively implements the complete suite of EVM specifications, the client binary inherently supports the latest Ethereum hardforks, including:
  * **Shanghai:** `PUSH0` opcode.
  * **Cancun:** `TSTORE` and `TLOAD` opcodes (transient storage).

---

## 2. Does EVM Hardfork Selection Still Matter on Arc?

**Yes.** Even though the underlying Reth client supports Cancun, the compatibility of compiled bytecode depends on two factors:

### A. Network Fork Activation Status
The Arc L1 chain's genesis block or protocol parameters determine which hardfork is active:
* If the Arc testnet/mainnet node configuration has activated Cancun, you can safely deploy contracts compiled with `evm_version = "cancun"`.
* If the network is running a customized genesis state that blocks newer forks, deploying Cancun compiled bytecode will revert with `invalid opcode` exceptions.

### B. Local Sandbox Node Alignment
During development, contracts are run locally via a Hardhat node (`npm run node` / `hardhat node`).
* If Hardhat's default EVM settings are configured to an older hardfork (e.g. `london` or `paris`), compiling the SDK or contracts with `evm_version = "cancun"` will cause local unit tests to fail, even if the remote Arc Network supports it.

---

## 3. Recommended Optimization Strategy on Arc

Given that Arc is built on Reth, we can optimize the Vault's reentrancy guards and stack allocation by target testing the Cancun upgrade.

### Step 1: Probe the Network
Deploy a simple probe contract to the Arc Testnet using Hardhat/Foundry to assert transient storage support:

```solidity
contract ArcForkProbe {
    function testTransientStorage() external {
        assembly {
            tstore(0, 1) // Attempt transient write
        }
    }
}
```
* If the transaction executes and is mined successfully, **Cancun is active on Arc**.
* If it reverts during gas estimation or execution, the network does not support transient storage yet.

### Step 2: Configure Compiler in configuration files

If the probe succeeds, update both configuration files to leverage the gas savings:

1. **In `foundry.toml`:**
   ```toml
   solc_version = "0.8.26"
   evm_version = "cancun"
   ```
2. **In `hardhat.config.ts`:**
   ```typescript
   solidity: {
     version: "0.8.26",
     settings: {
       evmVersion: "cancun", // Set to Cancun
       optimizer: {
         enabled: true,
         runs: 200,
       },
     },
   }
   ```

### Step 3: Implement Transient Reentrancy Guard
Replace the state-variable reentrancy guard in [ArcOpenRailsHubV1.sol](../contracts/ArcOpenRailsHubV1.sol#L18) with a transient guard, dropping execution gas by **~20,000 gas**:

```solidity
// Cancun Optimized Transient Reentrancy Guard (saves ~20k gas)
modifier nonReentrant() {
    assembly {
        // Slot 0 is used for the transient reentrancy lock
        if tload(0) {
            // Revert with custom error string
            mstore(0, 0x08c379a000000000000000000000000000000000000000000000000000000000)
            mstore(4, 0x20)
            mstore(36, 17)
            mstore(68, "REENTRANT_ATTEMPT")
            revert(0, 100)
        }
        tstore(0, 1)
    }
    _;
    assembly {
        tstore(0, 0)
    }
}
```
