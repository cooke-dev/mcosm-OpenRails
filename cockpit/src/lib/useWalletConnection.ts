/**
 * Single source of truth for "is a wallet really connected and usable."
 *
 * wagmi's useAccount().isConnected/address can report a real, persisted connection while
 * Privy's own authenticated session is still false/expired — @privy-io/wagmi's sync hook
 * reconnects wagmi from its own localStorage-persisted connector state the moment Privy's
 * wallet list resolves (`useWallets().ready`), independent of whether the public
 * usePrivy().authenticated session is actually valid. That desync showed up as two widgets
 * on the same page disagreeing about connection state (ConnectWalletButton correctly gated
 * on `authenticated`, other consumers gated on wagmi alone). Every consumer of "is connected"
 * should go through this hook instead of calling useAccount()/usePrivy() separately.
 */
import { usePrivy } from "@privy-io/react-auth";
import { useAccount } from "wagmi";

export function useWalletConnection() {
  const { ready, authenticated } = usePrivy();
  const { address, chainId } = useAccount();
  return { isConnected: ready && authenticated && !!address, address, chainId, ready };
}
