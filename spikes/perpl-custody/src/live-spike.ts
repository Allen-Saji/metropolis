import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatEther,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem/utils";
import { erc20Abi, harnessAbi } from "./abis.js";
import { exchangeReadAbi } from "./abis.js";
import { DEFAULTS, fetchPerplContext, primaryInstance } from "./config.js";

type Artifact = { abi: typeof harnessAbi; bytecode: Hex };

const chain = defineChain({
  id: DEFAULTS.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl] } },
});

function requiredPrivateKey(name: "MONAD_TESTNET_PRIVATE_KEY" | "MONAD_TESTNET_OPERATOR_PRIVATE_KEY"): Hex {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is absent. The live proof requires separate dedicated owner and operator testnet keys.`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} has invalid shape`);
  return value as Hex;
}

function isContractRevert(error: unknown, errorName: string): boolean {
  if (!(error instanceof BaseError)) return false;
  const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError && revert.data?.errorName === errorName;
}

async function main() {
  const owner = privateKeyToAccount(requiredPrivateKey("MONAD_TESTNET_PRIVATE_KEY"));
  const operator = privateKeyToAccount(requiredPrivateKey("MONAD_TESTNET_OPERATOR_PRIVATE_KEY"));
  if (owner.address.toLowerCase() === operator.address.toLowerCase()) {
    throw new Error("Owner and operator must be different accounts");
  }
  const rpcUrl = process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const ownerWalletClient = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
  const operatorWalletClient = createWalletClient({ account: operator, chain, transport: http(rpcUrl) });
  const context = await fetchPerplContext();
  const { instance, collateral } = primaryInstance(context);
  const exchange = instance.address as Address;
  const collateralAddress = collateral.address as Address;
  const minimum = BigInt(instance.min_account_open_amount);
  const [ownerMonBalance, operatorMonBalance, collateralBalance] = await Promise.all([
    publicClient.getBalance({ address: owner.address }),
    publicClient.getBalance({ address: operator.address }),
    publicClient.readContract({
      address: collateralAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner.address],
    }),
  ]);

  console.log(JSON.stringify({
    owner: owner.address,
    operator: operator.address,
    ownerMonBalance: formatEther(ownerMonBalance),
    operatorMonBalance: formatEther(operatorMonBalance),
    ownerCollateralBalance: formatUnits(collateralBalance, collateral.decimals),
    collateralSymbol: collateral.symbol,
    requiredCollateral: formatUnits(minimum, collateral.decimals),
  }, null, 2));

  if (ownerMonBalance === 0n || operatorMonBalance === 0n || collateralBalance < minimum) {
    throw new Error(
      `Live gate blocked: both dedicated signers need testnet MON and the owner needs at least ${formatUnits(minimum, collateral.decimals)} ${collateral.symbol}. No transaction was sent.`,
    );
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const artifact = JSON.parse(
    await readFile(resolve(here, "../artifacts/PerplCustodyHarness.json"), "utf8"),
  ) as Artifact;
  const maxLotLNS = 100n;
  const maxAmountCNS = minimum * 10n;
  const deployData = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [exchange, collateralAddress, operator.address, maxLotLNS, maxAmountCNS],
  });
  const deploymentHash = await ownerWalletClient.sendTransaction({ data: deployData });
  const deploymentReceipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
  if (!deploymentReceipt.contractAddress || deploymentReceipt.status !== "success") {
    throw new Error("Harness deployment failed");
  }
  const harness = deploymentReceipt.contractAddress;

  const operatorDeniedFunctions = ["withdrawToOwner", "recoverIdleCollateral"] as const;
  for (const functionName of operatorDeniedFunctions) {
    let unauthorized = false;
    try {
      await publicClient.simulateContract({
        account: operator,
        address: harness,
        abi: harnessAbi,
        functionName,
        args: [1n],
      });
    } catch (error) {
      unauthorized = isContractRevert(error, "Unauthorized");
      if (!unauthorized) throw error;
    }
    if (!unauthorized) {
      throw new Error(`Custody invariant failed: operator could call ${functionName}`);
    }
  }

  const transferHash = await ownerWalletClient.writeContract({
    address: collateralAddress,
    abi: erc20Abi,
    functionName: "transfer",
    args: [harness, minimum],
  });
  await publicClient.waitForTransactionReceipt({ hash: transferHash });

  const openHash = await ownerWalletClient.writeContract({
    address: harness,
    abi: harnessAbi,
    functionName: "openAccount",
    args: [minimum],
  });
  await publicClient.waitForTransactionReceipt({ hash: openHash });

  const accountState = await publicClient.readContract({
    address: harness,
    abi: harnessAbi,
    functionName: "account",
  });

  const btc = context.markets.find((market) => market.symbol === "BTC");
  if (!btc) throw new Error("BTC market missing from live Perpl context");
  const accountId = accountState[0];
  const openRequestId = BigInt(Date.now());
  const openBlock = await publicClient.getBlockNumber();
  const openOrder = {
    orderDescId: openRequestId,
    perpId: BigInt(btc.perpetual_id),
    orderType: 0,
    orderId: 0n,
    pricePNS: (BigInt(btc.state.ask) * 10_100n + 9_999n) / 10_000n,
    lotLNS: maxLotLNS,
    expiryBlock: 0n,
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: true,
    maxMatches: 10n,
    leverageHdths: 200n,
    lastExecutionBlock: openBlock + BigInt(btc.order_ttl_blocks),
    amountCNS: 0n,
    maxNegPnlCollatBPS: BigInt(btc.order_max_neg_pnl_collat_bps),
  } as const;

  let extensionRejected = false;
  try {
    await publicClient.simulateContract({
      account: operator,
      address: harness,
      abi: harnessAbi,
      functionName: "executeOrder",
      args: [openOrder, "0x01"],
    });
  } catch (error) {
    extensionRejected = isContractRevert(error, "InvalidExtension");
    if (!extensionRejected) throw error;
  }
  if (!extensionRejected) throw new Error("Custody invariant failed: operator-supplied builder extension accepted");

  await publicClient.simulateContract({
    account: operator,
    address: harness,
    abi: harnessAbi,
    functionName: "executeOrder",
    args: [openOrder, "0x"],
  });
  const openOrderHash = await operatorWalletClient.writeContract({
    address: harness,
    abi: harnessAbi,
    functionName: "executeOrder",
    args: [openOrder, "0x"],
  });
  const openOrderReceipt = await publicClient.waitForTransactionReceipt({ hash: openOrderHash });
  if (openOrderReceipt.status !== "success") throw new Error("BTC open transaction reverted");

  const [openedPosition] = await publicClient.readContract({
    address: exchange,
    abi: exchangeReadAbi,
    functionName: "getPositionV2",
    args: [BigInt(btc.perpetual_id), accountId],
  });
  if (openedPosition.accountId !== accountId || openedPosition.lotLNS === 0n) {
    throw new Error("BTC IOC order produced no open position; collateral remains in the harness-owned account");
  }

  const closeContext = await fetchPerplContext();
  const closeBtc = closeContext.markets.find((market) => market.symbol === "BTC");
  if (!closeBtc) throw new Error("BTC market missing while preparing the close order");
  const closeBlock = await publicClient.getBlockNumber();
  const closeOrder = {
    orderDescId: openRequestId + 1n,
    perpId: BigInt(btc.perpetual_id),
    orderType: 2,
    orderId: 0n,
    pricePNS: (BigInt(closeBtc.state.bid) * 9_900n) / 10_000n,
    lotLNS: openedPosition.lotLNS,
    expiryBlock: 0n,
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: true,
    maxMatches: 10n,
    leverageHdths: 200n,
    lastExecutionBlock: closeBlock + BigInt(closeBtc.order_ttl_blocks),
    amountCNS: 0n,
    maxNegPnlCollatBPS: BigInt(closeBtc.order_max_neg_pnl_collat_bps),
  } as const;

  await publicClient.simulateContract({
    account: operator,
    address: harness,
    abi: harnessAbi,
    functionName: "executeOrder",
    args: [closeOrder, "0x"],
  });
  const closeOrderHash = await operatorWalletClient.writeContract({
    address: harness,
    abi: harnessAbi,
    functionName: "executeOrder",
    args: [closeOrder, "0x"],
  });
  const closeOrderReceipt = await publicClient.waitForTransactionReceipt({ hash: closeOrderHash });
  if (closeOrderReceipt.status !== "success") throw new Error("BTC close transaction reverted");

  const [closedPosition] = await publicClient.readContract({
    address: exchange,
    abi: exchangeReadAbi,
    functionName: "getPositionV2",
    args: [BigInt(btc.perpetual_id), accountId],
  });
  if (closedPosition.accountId === accountId && closedPosition.lotLNS !== 0n) {
    throw new Error("BTC position remains open after the close transaction");
  }

  const afterClose = await publicClient.readContract({
    address: harness,
    abi: harnessAbi,
    functionName: "account",
  });
  const withdrawable = afterClose[1] - afterClose[2];
  if (withdrawable === 0n) throw new Error("No collateral is withdrawable after closing the position");
  const withdrawHash = await ownerWalletClient.writeContract({
    address: harness,
    abi: harnessAbi,
    functionName: "withdrawToOwner",
    args: [withdrawable],
  });
  const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash });
  if (withdrawReceipt.status !== "success") throw new Error("Collateral withdrawal reverted");

  console.log(JSON.stringify({
    status: "live-custody-cycle-complete",
    owner: owner.address,
    operator: operator.address,
    harness,
    deploymentHash,
    transferHash,
    openHash,
    accountId: accountId.toString(),
    exchangeBalance: formatUnits(accountState[1], collateral.decimals),
    lockedBalance: formatUnits(accountState[2], collateral.decimals),
    openOrderHash,
    closeOrderHash,
    withdrawHash,
    openedLotRaw: openedPosition.lotLNS.toString(),
    withdrawnCollateral: formatUnits(withdrawable, collateral.decimals),
    operatorWithdrawalBlocked: true,
    operatorIdleCollateralRecoveryBlocked: true,
    operatorBuilderExtensionBlocked: extensionRejected,
    proven: [
      "contract-owned Perpl account",
      "separate hot operator with no withdrawal authority",
      "bounded direct BTC order submitted by the operator",
      "position reconciliation",
      "bounded close",
      "collateral recovery to owner",
    ],
  }, null, 2));
}

await main();
