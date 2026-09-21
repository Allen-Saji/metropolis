import { createPublicClient, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { erc20Abi, exchangeReadAbi, harnessAbi } from "./abis.js";
import { DEFAULTS } from "./config.js";
import { estimateEquity, positionIds } from "./accounting.js";

const harness = process.env.PERPL_HARNESS_ADDRESS;
if (!harness || !isAddress(harness)) throw new Error("Set PERPL_HARNESS_ADDRESS to a deployed testnet adapter");
const client = createPublicClient({ transport: http(process.env.MONAD_TESTNET_RPC_URL ?? DEFAULTS.rpcUrl) });
if (await client.getChainId() !== DEFAULTS.chainId) throw new Error("Expected Monad Testnet");
const finalized = await client.getBlock({ blockTag: "finalized" });
const txHash = process.env.PERPL_SNAPSHOT_TX_HASH;
if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Invalid PERPL_SNAPSHOT_TX_HASH");
const receipt = txHash ? await client.getTransactionReceipt({ hash: txHash as Hex }) : undefined;
if (receipt && (receipt.status !== "success" || receipt.blockNumber > finalized.number)) {
  throw new Error("Snapshot transaction must be successful and finalized");
}
const blockNumber = receipt?.blockNumber ?? finalized.number;
const block = await client.getBlock({ blockNumber });
if (receipt && receipt.blockHash !== block.hash) throw new Error("Receipt block hash mismatch");
const [exchange, collateral] = await Promise.all([
  client.readContract({ address: harness, abi: harnessAbi, functionName: "exchange", blockNumber }),
  client.readContract({ address: harness, abi: harnessAbi, functionName: "collateral", blockNumber }),
]);
const [account, idle, decimals] = await Promise.all([
  client.readContract({ address: exchange, abi: exchangeReadAbi, functionName: "getAccountByAddr", args: [harness], blockNumber }),
  client.readContract({ address: collateral, abi: erc20Abi, functionName: "balanceOf", args: [harness], blockNumber }),
  client.readContract({ address: collateral, abi: erc20Abi, functionName: "decimals", blockNumber }),
]);
if (account.accountId === 0n || account.accountAddr.toLowerCase() !== harness.toLowerCase()) {
  throw new Error("Adapter does not own the exchange account");
}
const ids = positionIds([account.positions.bank1, account.positions.bank2, account.positions.bank3, account.positions.bank4]);
const positions = await Promise.all(ids.map(async (perpId) => {
  const [p, markPricePNS, markPriceValid] = await client.readContract({
    address: exchange, abi: exchangeReadAbi, functionName: "getPositionV2", args: [perpId, account.accountId], blockNumber,
  });
  if (p.accountId !== account.accountId || p.lotLNS === 0n) throw new Error("Position bitmap does not match position data");
  return { perpId, ...p, markPricePNS, markPriceValid };
}));
const extraAbi = parseAbi([
  "function getContractVersion() view returns (uint256 major,uint256 minor,uint256 patch)",
  "function getOrderLocks(uint256 accountId) view returns ((uint32 orderLockId,uint32 nextOrderLockId,uint32 prevOrderLockId,uint8 orderType,uint40 lotLNS,uint80 amountCNS)[] orderLocks)",
]);
const [version, locks] = await Promise.all([
  client.readContract({ address: exchange as Address, abi: extraAbi, functionName: "getContractVersion", blockNumber }),
  client.readContract({ address: exchange as Address, abi: extraAbi, functionName: "getOrderLocks", args: [account.accountId], blockNumber }),
]);
const valuation = estimateEquity(idle, account.balanceCNS, account.lockedBalanceCNS, positions);
console.log(JSON.stringify({
  observedAt: new Date().toISOString(), blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp,
  snapshotKind: receipt ? "historical-end-of-block" : "finalized-end-of-block",
  harness, exchange, collateral, collateralDecimals: decimals, exchangeVersion: version,
  account, idleCollateralCNS: idle, positions, orderLocks: locks, ...valuation,
  usableForSharePricing: false,
  limitation: "Diagnostic equity estimate only. Does not prove executable close value, withdrawal availability, or ERC-4626 compliance.",
}, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2));
