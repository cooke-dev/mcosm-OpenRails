import type { AuthoritySignatureVerifier } from "./typedData.js";

export class EthersAuthoritySignatureVerifier implements AuthoritySignatureVerifier {
  async verify(input: Parameters<AuthoritySignatureVerifier["verify"]>[0]): Promise<boolean> {
    const { verifyTypedData, getAddress } = await import("ethers");
    try {
      const recovered = verifyTypedData(input.typedData.domain, input.typedData.types, input.typedData.message, input.signature);
      return getAddress(recovered) === getAddress(input.expectedSigner);
    } catch {
      return false;
    }
  }
}
