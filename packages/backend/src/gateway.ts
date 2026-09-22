import { readFile } from "node:fs/promises";
import {
  BaseError,
  ExecutionRevertedError,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  decodeFunctionData,
  decodeEventLog,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionReceiptNotFoundError,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ensure, Fault, json } from "./common.js";
import { exchangeEventAbi } from "./perpl-events.js";
import { limitedHttp } from "./rpc.js";
import { SUITE_HASH } from "./qualification.js";
import type { Gateway, Job, State, Prepared, Event } from "./types.js";

export type ChainConfig = {
  rpcUrl: string;
  chainId: number;
  vault: Address;
  deploymentBlock: bigint;
  evaluatorKey: Hex;
  keeperKey: Hex;
  maxFeePerGas: bigint;
  maxGas: bigint;
  artifactDirectory: URL;
  nowSeconds?: () => number;
  rpcRequestIntervalMs?: number;
};
async function artifact(directory: URL, name: string): Promise<Abi> {
  return JSON.parse(
    await readFile(new URL(`${name}.sol/${name}.json`, directory), "utf8"),
  ).abi;
}
const identityAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
]);
const tokenAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
]);
type Position = {
  accountId: bigint;
  lotLNS: bigint;
  pnlCNS: bigint;
  depositCNS: bigint;
  [key: string]: unknown;
};
type Account = {
  accountId: bigint;
  balanceCNS: bigint;
  lockedBalanceCNS: bigint;
  frozen: number;
  positions: Record<string, bigint>;
};
export async function gateway(config: ChainConfig): Promise<Gateway> {
  const chain = defineChain({
    id: config.chainId,
    name: "Monad Testnet",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  ensure(config.chainId === 10143, "TESTNET_ONLY");
  const client = createPublicClient({
    chain,
    transport: limitedHttp(config.rpcUrl, config.rpcRequestIntervalMs),
    batch: { multicall: false },
  });
  const evaluator = privateKeyToAccount(config.evaluatorKey),
    keeper = privateKeyToAccount(config.keeperKey);
  ensure(
    evaluator.address.toLowerCase() !== keeper.address.toLowerCase(),
    "SIGNERS_MUST_DIFFER",
  );
  const [vaultAbi, registryAbi, adapterAbi, riskAbi, exchangeAbi] =
    await Promise.all(
      [
        "MetropolisVault",
        "QualificationRegistry",
        "PerplAdapter",
        "RiskController",
        "IPerplExchange",
      ].map((n) => artifact(config.artifactDirectory, n)),
    );
  const read = <T>(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] = [],
    blockNumber?: bigint,
  ) =>
    client.readContract({
      address,
      abi,
      functionName,
      args,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    }) as Promise<T>;
  ensure((await client.getChainId()) === config.chainId, "WRONG_CHAIN");
  const [registry, adapter, risk, exchange, asset, suite] = await Promise.all([
    read<Address>(config.vault, vaultAbi!, "registry"),
    read<Address>(config.vault, vaultAbi!, "adapter"),
    read<Address>(config.vault, vaultAbi!, "risk"),
    read<Address>(config.vault, vaultAbi!, "exchange"),
    read<Address>(config.vault, vaultAbi!, "asset"),
    read<Hex>(config.vault, vaultAbi!, "requiredSuite"),
  ]);
  ensure(suite === SUITE_HASH, "SUITE_MISMATCH");
  const [identity, evaluatorOwner] = await Promise.all([
    read<Address>(registry, registryAbi!, "identity"),
    read<Address>(registry, registryAbi!, "owner"),
  ]);
  ensure(
    evaluatorOwner.toLowerCase() === evaluator.address.toLowerCase(),
    "WRONG_EVALUATOR",
  );
  for (const address of [
    config.vault,
    registry,
    adapter,
    risk,
    exchange,
    asset,
    identity,
  ])
    ensure(await client.getBytecode({ address }), "MISSING_CONTRACT");
  const freshBlock = async () => {
    const block = await client.getBlock({ blockTag: "finalized" });
    const age =
      (config.nowSeconds?.() ?? Math.floor(Date.now() / 1000)) -
      Number(block.timestamp);
    ensure(age >= -10 && age <= 60, "STALE_CHAIN", 503);
    return block;
  };
  const identityOwner = async (agentId: string) =>
    (
      await read<Address>(
        identity,
        identityAbi,
        "ownerOf",
        [BigInt(agentId)],
        (await freshBlock()).number,
      )
    ).toLowerCase() as Address;
  const state = async (): Promise<State> => {
    const block = await freshBlock(),
      b = block.number;
    const [
      status,
      paused,
      operator,
      agent,
      requestId,
      accountId,
      idle,
      supply,
      highWater,
      settledUntil,
    ] = await Promise.all([
      read<number>(config.vault, vaultAbi!, "state", [], b),
      read<boolean>(config.vault, vaultAbi!, "paused", [], b),
      read<Address>(config.vault, vaultAbi!, "operator", [], b),
      read<bigint>(config.vault, vaultAbi!, "activeAgentId", [], b),
      read<bigint>(config.vault, vaultAbi!, "nextOrderId", [], b),
      read<bigint>(adapter, adapterAbi!, "accountId", [], b),
      read<bigint>(asset, tokenAbi, "balanceOf", [config.vault], b),
      read<bigint>(config.vault, vaultAbi!, "totalSupply", [], b),
      read<bigint>(config.vault, vaultAbi!, "highWaterEquity", [], b),
      read<bigint>(config.vault, vaultAbi!, "settledUntil", [], b),
    ]);
    let a: Account | undefined;
    const positions: State["positions"] = [];
    if (accountId > 0n) {
      a = await read<Account>(
        exchange,
        exchangeAbi!,
        "getAccountByAddr",
        [adapter],
        b,
      );
      for (const perpId of [16n, 32n]) {
        const [p, mark, valid] = await read<[Position, bigint, boolean]>(
          exchange,
          exchangeAbi!,
          "getPositionV2",
          [perpId, accountId],
          b,
        );
        if (p.lotLNS > 0n)
          positions.push(
            JSON.parse(json({ ...p, perpId, mark, markValid: valid })),
          );
      }
    }
    let riskValue: unknown = null,
      riskAvailable = false;
    if (accountId > 0n) {
      try {
        riskValue = await read(
          risk,
          riskAbi!,
          "snapshot",
          [config.vault, adapter],
          b,
        );
        riskAvailable = true;
      } catch {
        /* Risk-unavailable is explicit; keeper still invokes the contract checkpoint. */
      }
    }
    const settledAssets =
      status === 0
        ? await read<bigint>(config.vault, vaultAbi!, "settledAssets", [], b)
        : null;
    return JSON.parse(
      json({
        blockNumber: b,
        blockHash: block.hash,
        timestamp: Number(block.timestamp),
        state: status,
        paused,
        operator: operator.toLowerCase(),
        activeAgentId: agent,
        nextOrderId: requestId,
        accountId,
        exchangeBalance: a?.balanceCNS ?? 0n,
        lockedBalance: a?.lockedBalanceCNS ?? 0n,
        positions,
        risk: riskValue,
        riskAvailable,
        idleCollateral: idle,
        totalShares: supply,
        highWaterEquity: highWater,
        settledUntil,
        settledAssets,
        adapter,
        registry,
        exchange,
        asset,
        accountingMode:
          status === 0 ? "settled-collateral" : "estimated-live-equity",
      }),
    );
  };
  const prepareCall = async (job: Job): Promise<Prepared> => {
    const signer = job.kind === "qualification" ? evaluator : keeper;
    let to = config.vault,
      data: Hex;
    if (job.kind === "qualification") {
      const p = job.payload;
      ensure(
        (await identityOwner(p.agentId)) === p.owner,
        "IDENTITY_OWNER_CHANGED",
        409,
      );
      ensure(
        !p.passed || p.expiresAt > Math.floor(Date.now() / 1000),
        "QUALIFICATION_EXPIRED",
        409,
      );
      to = registry;
      data = encodeFunctionData({
        abi: registryAbi!,
        functionName: "recordForOwner",
        args: [
          BigInt(p.agentId),
          p.owner,
          p.operator,
          p.suite,
          p.evidence,
          BigInt(p.expiresAt),
          p.passed,
        ],
      });
    } else {
      ensure(job.kind === "keeper", "INVALID_KEEPER_METHOD");
      const p = job.payload;
      const latest = await state();
      ensure(
        p.method === "checkpointRisk" ? latest.state === 1 : latest.state === 2,
        "STALE_KEEPER_ACTION",
        409,
      );
      ensure(
        [
          "checkpointRisk",
          "closePosition",
          "recoverCollateral",
          "finishSettlement",
        ].includes(p.method),
        "INVALID_KEEPER_METHOD",
      );
      if (p.method === "closePosition") {
        ensure(
          latest.positions.some(
            (position) =>
              position.perpId === p.argument && BigInt(position.lotLNS) > 0n,
          ),
          "STALE_KEEPER_ACTION",
          409,
        );
      }
      if (p.method === "recoverCollateral") {
        ensure(
          latest.positions.length === 0 &&
            p.argument &&
            BigInt(p.argument) > 0n &&
            BigInt(p.argument) <= BigInt(latest.exchangeBalance),
          "STALE_KEEPER_ACTION",
          409,
        );
      }
      if (p.method === "finishSettlement") {
        ensure(
          latest.positions.length === 0 &&
            BigInt(latest.exchangeBalance) === 0n,
          "STALE_KEEPER_ACTION",
          409,
        );
      }
      const args = p.argument === undefined ? [] : [BigInt(p.argument)];
      data = encodeFunctionData({
        abi: vaultAbi!,
        functionName: p.method,
        args,
      });
    }
    await freshBlock();
    await client.call({ account: signer.address, to, data });
    const estimate = await client.estimateGas({
      account: signer.address,
      to,
      data,
    });
    const gas = estimate + (estimate + 9n) / 10n;
    ensure(gas <= config.maxGas, "GAS_LIMIT");
    const nonce = await client.getTransactionCount({
      address: signer.address,
      blockTag: "pending",
    });
    const fees = await client.estimateFeesPerGas();
    ensure(fees.maxFeePerGas <= config.maxFeePerGas, "GAS_PRICE_LIMIT");
    const raw = await signer.signTransaction({
      chainId: config.chainId,
      type: "eip1559",
      to,
      data,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      value: 0n,
    });
    return {
      signer: signer.address.toLowerCase() as Address,
      nonce,
      raw,
      hash: keccak256(raw),
    };
  };
  return {
    chainId: config.chainId,
    vault: config.vault,
    registry,
    deploymentBlock: config.deploymentBlock,
    verify: (address, message, signature) =>
      client.verifyMessage({ address, message, signature }),
    identityOwner,
    state,
    validateTrade: async (raw, walletAddress) => {
      ensure(raw.startsWith("0x02"), "EIP1559_TRANSACTION_REQUIRED");
      const serialized = raw as `0x02${string}`;
      let tx, signer: Address;
      try {
        tx = parseTransaction(serialized);
        signer = (
          await recoverTransactionAddress({ serializedTransaction: serialized })
        ).toLowerCase() as Address;
      } catch {
        throw new Fault("INVALID_SIGNED_TRANSACTION");
      }
      ensure(signer === walletAddress, "WRONG_TRANSACTION_SIGNER", 403);
      ensure(
        signer !== evaluator.address.toLowerCase() &&
          signer !== keeper.address.toLowerCase(),
        "RESERVED_SIGNER",
        403,
      );
      ensure(
        tx.chainId === config.chainId &&
          tx.type === "eip1559" &&
          tx.to?.toLowerCase() === config.vault.toLowerCase() &&
          (tx.value ?? 0n) === 0n &&
          tx.data &&
          tx.nonce !== undefined &&
          Number.isSafeInteger(tx.nonce) &&
          tx.nonce >= 0,
        "INVALID_TRADE_TRANSACTION",
      );
      ensure(
        tx.gas !== undefined &&
          tx.gas <= config.maxGas &&
          tx.maxFeePerGas !== undefined &&
          tx.maxFeePerGas <= config.maxFeePerGas,
        "GAS_LIMIT",
      );
      let decoded;
      try {
        decoded = decodeFunctionData({ abi: vaultAbi!, data: tx.data });
      } catch {
        throw new Fault("INVALID_TRADE_CALLDATA");
      }
      ensure(decoded.functionName === "executeTrade", "TRADE_METHOD_ONLY", 403);
      const s = await state();
      ensure(s.operator === signer, "NOT_ACTIVE_OPERATOR", 403);
      ensure(
        tx.nonce ===
          (await client.getTransactionCount({
            address: signer,
            blockTag: "pending",
          })),
        "NONCE_CONFLICT",
        409,
      );
      try {
        await client.call({
          account: signer,
          to: config.vault,
          data: tx.data,
          gas: tx.gas,
        });
      } catch (error) {
        if (
          error instanceof BaseError &&
          error.walk(
            (cause) => cause instanceof ExecutionRevertedError,
          ) instanceof ExecutionRevertedError
        )
          throw new Fault("TRANSACTION_REJECTED", 422);
        throw error;
      }
      return { signer, nonce: tx.nonce, raw, hash: keccak256(raw) };
    },
    prepare: prepareCall,
    broadcast: async (raw) => {
      await client.sendRawTransaction({ serializedTransaction: raw });
    },
    receipt: async (hash) => {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
      const block = await freshBlock();
      if (receipt.blockNumber > block.number) return null;
      ensure(
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash ===
          receipt.blockHash,
        "RECEIPT_REORG",
        503,
      );
      return receipt.status === "success" ? "confirmed" : "reverted";
    },
    nonceConsumed: async (signer, nonce) =>
      (await client.getTransactionCount({
        address: signer,
        blockTag: "finalized",
      })) > nonce,
    blockHash: async (block) =>
      (await client.getBlock({ blockNumber: block })).hash!,
    events: async (from, to) => {
      const logs = await client.getLogs({
        address: [config.vault, adapter, registry],
        fromBlock: from,
        toBlock: to,
      });
      const hashes = [...new Set(logs.map((l) => l.transactionHash!))];
      const result: Event[] = [];
      for (const hash of hashes) {
        const receipt = await client.getTransactionReceipt({ hash });
        for (const log of receipt.logs) {
          const lower = log.address.toLowerCase();
          const abi =
            lower === config.vault.toLowerCase()
              ? vaultAbi
              : lower === adapter.toLowerCase()
                ? adapterAbi
                : lower === registry.toLowerCase()
                  ? registryAbi
                  : lower === exchange.toLowerCase()
                    ? exchangeEventAbi
                    : undefined;
          if (!abi) continue;
          try {
            const decoded = decodeEventLog({
              abi,
              data: log.data,
              topics: log.topics,
            });
            result.push({
              blockNumber: log.blockNumber.toString(),
              blockHash: log.blockHash,
              txHash: hash,
              logIndex: log.logIndex,
              address: log.address,
              name: decoded.eventName ?? "Unknown",
              data: JSON.parse(json(decoded.args)),
            });
          } catch {
            /* ABI-unknown events are retained as raw logs, never guessed. */
            result.push({
              blockNumber: log.blockNumber.toString(),
              blockHash: log.blockHash,
              txHash: hash,
              logIndex: log.logIndex,
              address: log.address,
              name: "Unknown",
              data: { topics: log.topics, data: log.data },
            });
          }
        }
      }
      return result;
    },
  };
}
