import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  parseAbi,
  type Address,
  type EIP1193Provider,
} from "viem";
import { DEPLOYMENT, RPC_URL } from "../config";

export const monadTestnet = defineChain({
  id: DEPLOYMENT.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "Monadscan", url: "https://testnet.monadscan.com" },
  },
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL, { timeout: 20_000 }),
});

export const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function deposit(uint256 assets, address receiver, uint256 minShares) returns (uint256)",
  "function redeem(uint256 shares, address receiver, uint256 minAssets) returns (uint256)",
  "function requestSettlement()",
  "function activateAgent(uint256 agentId, address operator)",
  "function startTrading(uint256 assets)",
  "function setPaused(bool value)",
]);

export const assetAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

export const registryAbi = parseAbi([
  "function isQualified(uint256 agentId, address operator, bytes32 suite) view returns (bool)",
  "function qualifications(uint256 agentId) view returns (address identityOwner, address operator, bytes32 suite, bytes32 evidence, uint64 expiresAt, bool passed)",
]);

export const identityAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
]);

export type InjectedProvider = EIP1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type WalletOption = {
  id: string;
  name: string;
  provider: InjectedProvider;
};

type ProviderAnnouncement = CustomEvent<{
  info: { uuid: string; name: string };
  provider: InjectedProvider;
}>;

const announcedWallets = new Map<string, WalletOption>();
const walletListeners = new Set<(wallets: WalletOption[]) => void>();
let discoveryStarted = false;
let selectedProvider: InjectedProvider | null = null;

function publishWallets() {
  const wallets = [...announcedWallets.values()];
  for (const listener of walletListeners) listener(wallets);
}

function legacyWallet() {
  try { return window.ethereum; } catch { return undefined; }
}

export function requestWalletProviders() {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  window.setTimeout(() => {
    const provider = legacyWallet();
    if (announcedWallets.size || !provider) return;
    announcedWallets.set("legacy", { id: "legacy", name: "Browser wallet", provider });
    publishWallets();
  }, 400);
}

export function getWalletOptions() {
  return [...announcedWallets.values()];
}

export function subscribeWallets(listener: (wallets: WalletOption[]) => void) {
  walletListeners.add(listener);
  if (!discoveryStarted) {
    discoveryStarted = true;
    window.addEventListener("eip6963:announceProvider", event => {
      const detail = (event as ProviderAnnouncement).detail;
      if (!detail || typeof detail.info?.uuid !== "string" ||
          typeof detail.info.name !== "string" ||
          typeof detail.provider?.request !== "function") return;
      announcedWallets.delete("legacy");
      announcedWallets.set(detail.info.uuid, {
        id: detail.info.uuid,
        name: detail.info.name.slice(0, 50),
        provider: detail.provider,
      });
      publishWallets();
    });
  }
  listener(getWalletOptions());
  requestWalletProviders();
  return () => { walletListeners.delete(listener); };
}

export function selectWalletProvider(provider: InjectedProvider) {
  selectedProvider = provider;
}

declare global {
  interface Window {
    ethereum?: InjectedProvider;
  }
}

export function walletProvider(): InjectedProvider {
  const provider = selectedProvider ?? legacyWallet();
  if (!provider) throw new Error("Open this page in a browser with an EVM wallet installed.");
  return provider;
}

export async function ensureMonad(provider: InjectedProvider): Promise<void> {
  const current = await provider.request({ method: "eth_chainId" });
  if (Number(current) === DEPLOYMENT.chainId) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x279f" }],
    });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x279f",
          chainName: "Monad Testnet",
          nativeCurrency: monadTestnet.nativeCurrency,
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [monadTestnet.blockExplorers.default.url],
        },
      ],
    });
  }
}

export function walletClient(account: Address) {
  return createWalletClient({
    account,
    chain: monadTestnet,
    transport: custom(walletProvider()),
  });
}

export type WalletSnapshot = {
  ausd: bigint;
  shares: bigint;
  allowance: bigint;
  manager: Address;
  identityOwner: Address;
  qualified: boolean;
  qualificationExpiry: bigint;
};

export async function readWalletSnapshot(account: Address, suite: `0x${string}`): Promise<WalletSnapshot> {
  // The public testnet RPC rejects bursts. Space account reads across seconds.
  const pace = () => new Promise<void>(resolve => setTimeout(resolve, 250));
  const ausd = await publicClient.readContract({ address: DEPLOYMENT.asset, abi: assetAbi, functionName: "balanceOf", args: [account] });
  await pace();
  const shares = await publicClient.readContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "balanceOf", args: [account] });
  await pace();
  const allowance = await publicClient.readContract({ address: DEPLOYMENT.asset, abi: assetAbi, functionName: "allowance", args: [account, DEPLOYMENT.vault] });
  await pace();
  const manager = await publicClient.readContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "owner" });
  await pace();
  const identityOwner = await publicClient.readContract({ address: DEPLOYMENT.identityRegistry, abi: identityAbi, functionName: "ownerOf", args: [DEPLOYMENT.agentId] });
  await pace();
  const qualified = await publicClient.readContract({ address: DEPLOYMENT.registry, abi: registryAbi, functionName: "isQualified", args: [DEPLOYMENT.agentId, DEPLOYMENT.operator, suite] });
  await pace();
  const qualification = await publicClient.readContract({ address: DEPLOYMENT.registry, abi: registryAbi, functionName: "qualifications", args: [DEPLOYMENT.agentId] });
  return {
    ausd,
    shares,
    allowance,
    manager,
    identityOwner,
    qualified,
    qualificationExpiry: qualification[4],
  };
}
