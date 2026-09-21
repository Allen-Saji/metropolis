import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem/utils";
import { ausdFaucetAbi, erc20Abi } from "./abis.js";
import { DEFAULTS, fetchPerplContext, primaryInstance } from "./config.js";

const chain = defineChain({
  id: DEFAULTS.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl] } },
});

function requiredPrivateKey(name: "MONAD_TESTNET_PRIVATE_KEY" | "MONAD_TESTNET_OPERATOR_PRIVATE_KEY"): Hex {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} is absent or invalid`);
  }
  return value as Hex;
}

async function main() {
  const owner = privateKeyToAccount(requiredPrivateKey("MONAD_TESTNET_PRIVATE_KEY"));
  const operator = privateKeyToAccount(requiredPrivateKey("MONAD_TESTNET_OPERATOR_PRIVATE_KEY"));
  const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const ownerWalletClient = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
  const context = await fetchPerplContext();
  const { instance, collateral } = primaryInstance(context);
  const collateralAddress = collateral.address as Address;
  const minimum = BigInt(instance.min_account_open_amount);

  let [ownerMon, operatorMon, ownerAusd] = await Promise.all([
    publicClient.getBalance({ address: owner.address }),
    publicClient.getBalance({ address: operator.address }),
    publicClient.readContract({
      address: collateralAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner.address],
    }),
  ]);

  if (ownerMon === 0n) {
    console.log(JSON.stringify({
      status: "blocked-on-native-gas",
      owner: owner.address,
      operator: operator.address,
      ownerMon: "0",
      ownerAusd: formatUnits(ownerAusd, collateral.decimals),
      next: "Fund the owner with Monad Testnet MON, then rerun this command.",
    }, null, 2));
    return;
  }

  let ausdFaucetHash: Hex | undefined;
  if (ownerAusd < minimum) {
    const simulation = await publicClient.simulateContract({
      account: owner,
      address: DEFAULTS.ausdFaucet,
      abi: ausdFaucetAbi,
      functionName: "requestFunds",
      args: [owner.address],
    });
    ausdFaucetHash = await ownerWalletClient.writeContract(simulation.request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: ausdFaucetHash });
    if (receipt.status !== "success") throw new Error("AUSD faucet transaction reverted");
    ownerAusd = await publicClient.readContract({
      address: collateralAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner.address],
    });
  }

  let operatorFundingHash: Hex | undefined;
  if (operatorMon === 0n) {
    ownerMon = await publicClient.getBalance({ address: owner.address });
    const operatorFunding = ownerMon / 4n;
    if (operatorFunding === 0n) throw new Error("Owner MON balance is too small to fund the operator");
    operatorFundingHash = await ownerWalletClient.sendTransaction({
      to: operator.address,
      value: operatorFunding,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: operatorFundingHash });
    if (receipt.status !== "success") throw new Error("Operator gas funding reverted");
    operatorMon = await publicClient.getBalance({ address: operator.address });
  }

  ownerMon = await publicClient.getBalance({ address: owner.address });
  console.log(JSON.stringify({
    status: ownerAusd >= minimum && ownerMon > 0n && operatorMon > 0n ? "ready" : "insufficient-funds",
    owner: owner.address,
    operator: operator.address,
    ownerMon: formatEther(ownerMon),
    operatorMon: formatEther(operatorMon),
    ownerAusd: formatUnits(ownerAusd, collateral.decimals),
    requiredAusd: formatUnits(minimum, collateral.decimals),
    ausdFaucetHash,
    operatorFundingHash,
  }, null, 2));
}

await main();
