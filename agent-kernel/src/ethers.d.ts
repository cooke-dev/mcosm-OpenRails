declare module "ethers" {
  export function verifyTypedData(
    domain: Record<string, unknown>,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
    signature: string,
  ): string;
  export function getAddress(value: string): string;
}
