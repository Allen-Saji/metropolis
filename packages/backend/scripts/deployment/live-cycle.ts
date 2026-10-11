import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  encodeFunctionData,
  formatUnits,
  keccak256,
  parseEther,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import { z } from "zod";
import { ensure, json } from "../../src/common.js";
import { finalized, publicClient, sendStep } from "./journal.js";

const collateral = 1_000_000_000n; // 1,000 test AUSD
const lot = 100n; // 0.001 BTC at five lot decimals
const tokenAbi = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const registryAbi = parseAbi([
  "function isQualified(uint256,address,bytes32) view returns (bool)",
]);
const marketSchema = z.object({
  symbol: z.string(),
  perpetual_id: z.number().int(),
  order_ttl_blocks: z.number().int().positive(),
  order_max_neg_pnl_collat_bps: z.number().int(),
  config: z.object({
    is_open: z.boolean(),
    size_decimals: z.number().int(),
  }),
  state: z.object({ ask: z.number().int(), mrk: z.number().int() }),
});
const contextSchema = z.object({ markets: z.array(marketSchema) });

async function market() {
  const response = await fetch("https://testnet.perpl.xyz/api/v1/pub/context", {
    signal: AbortSignal.timeout(10_000),
  });
  ensure(response.ok, "PERPL_CONTEXT_UNAVAILABLE");
  const btc = contextSchema
    .parse(await response.json())
    .markets.find((entry) => entry.symbol === "BTC");
  ensure(
    btc &&
      btc.perpetual_id === 16 &&
      btc.config.is_open &&
      btc.config.size_decimals === 5 &&
      btc.order_ttl_blocks >= 20,
    "BTC_MARKET_UNAVAILABLE",
  );
  return btc;
}

async function request(path: string, payload?: unknown, bearer?: string) {
  const base = process.env.BACKEND_URL ?? "http://127.0.0.1:3311";
  const response = await fetch(new URL(path, base), {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(payload === undefined ? {} : { body: json(payload) }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  ensure(response.ok, `API_${response.status}_${body.error ?? "ERROR"}`);
  return body;
}

function transientReadFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error &&
      (error.name === "TimeoutError" ||
        error.message === "API_503_SERVICE_UNAVAILABLE"))
  );
}

async function login(operator: ReturnType<typeof privateKeyToAccount>) {
  const origin = process.env.APP_ORIGIN ?? "http://localhost:3000";
  const challenge = await request("/v1/auth/nonce", {
    address: operator.address,
  });
  const parsed = parseSiweMessage(challenge.message);
  ensure(
    parsed.chainId === 10143 &&
      parsed.domain === new URL(origin).host &&
      parsed.uri === origin &&
      parsed.address?.toLowerCase() === operator.address.toLowerCase() &&
      parsed.nonce === challenge.nonce,
    "UNEXPECTED_SIGN_IN_CHALLENGE",
  );
  const result = await request("/v1/auth/verify", {
    nonce: challenge.nonce,
    signature: await operator.signMessage({ message: challenge.message }),
  });
  return result.token as string;
}

async function main() {
  ensure(
    process.env.METROPOLIS_TESTNET_TRADE === "true",
    "TESTNET_TRADE_NOT_ENABLED",
  );
  ensure(
    ["open", "settle", "fund-keeper"].includes(process.argv[2] ?? ""),
    "USE_OPEN_SETTLE_OR_FUND_KEEPER",
  );
  ensure((await publicClient.getChainId()) === 10143, "TESTNET_ONLY");
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../../deployments/monad-testnet.json", import.meta.url),
      "utf8",
    ),
  );
  ensure(manifest.chainId === 10143, "TESTNET_ONLY");
  const directory =
    process.env.METROPOLIS_PRIVATE_DIR ?? join(homedir(), ".config/metropolis");
  const keyPath = join(directory, "perpl-spike.env");
  ensure(((await stat(keyPath)).mode & 0o077) === 0, "INSECURE_SECRET_FILE");
  const keys = parseEnv(await readFile(keyPath, "utf8"));
  const owner = privateKeyToAccount(keys.MONAD_TESTNET_PRIVATE_KEY as Hex);
  const operator = privateKeyToAccount(
    keys.MONAD_TESTNET_OPERATOR_PRIVATE_KEY as Hex,
  );
  ensure(
    owner.address.toLowerCase() === manifest.owner.toLowerCase() &&
      operator.address.toLowerCase() === manifest.operator.toLowerCase(),
    "SIGNER_MISMATCH",
  );
  const vault = manifest.vault as Address;
  const vaultAbi: Abi = JSON.parse(
    await readFile(
      new URL(
        "../../../contracts/out/MetropolisVault.sol/MetropolisVault.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).abi;
  const journalName =
    process.env.METROPOLIS_LIVE_CYCLE_JOURNAL ?? "testnet-live-cycle-v1";
  ensure(
    /^testnet-live-cycle-v[1-9][0-9]*$/.test(journalName),
    "INVALID_JOURNAL_NAME",
  );
  const journal = join(directory, journalName);
  await mkdir(journal, { recursive: true, mode: 0o700 });
  if (process.argv[2] === "fund-keeper") {
    const receipt = await sendStep(journal, "fund-keeper", owner, {
      to: manifest.keeper,
      value: parseEther("1"),
    });
    console.log(
      json({ phase: "fund-keeper", transactionHash: receipt.transactionHash }),
    );
  } else if (process.argv[2] === "open") {
    const attempt = process.env.METROPOLIS_LIVE_TRADE_ATTEMPT ?? "1";
    ensure(/^[1-9][0-9]*$/.test(attempt), "INVALID_TRADE_ATTEMPT");
    const qualified = await publicClient.readContract({
      address: manifest.qualificationRegistry,
      abi: registryAbi,
      functionName: "isQualified",
      args: [BigInt(manifest.agentId), operator.address, manifest.suiteHash],
      blockTag: "finalized",
    });
    ensure(qualified, "QUALIFICATION_NOT_ACTIVE");
    const state = Number(
      await publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "state",
        blockTag: "finalized",
      }),
    );
    ensure(state === 0 || state === 1, "VAULT_NOT_READY_TO_OPEN");
    const ownerBalance = await publicClient.readContract({
      address: manifest.asset,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [owner.address],
      blockTag: "finalized",
    });
    ensure(ownerBalance >= collateral || state === 1, "INSUFFICIENT_TEST_AUSD");
    const approval = await sendStep(journal, "approve", owner, {
      to: manifest.asset,
      data: encodeFunctionData({
        abi: tokenAbi,
        functionName: "approve",
        args: [vault, collateral],
      }),
    });
    const deposit = await sendStep(journal, "deposit", owner, {
      to: vault,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: "deposit",
        args: [collateral, owner.address, 1_000_000_000_000_000n],
      }),
    });
    const start = await sendStep(journal, "start-trading", owner, {
      to: vault,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: "startTrading",
        args: [collateral],
      }),
    });
    const token = await login(operator);
    const path = join(journal, `operator-open-${attempt}.json`);
    let saved: { raw: Hex; hash: Hex; idempotencyKey: string };
    try {
      ensure(((await stat(path)).mode & 0o077) === 0, "INSECURE_JOURNAL");
      saved = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const btc = await market();
      const orderId = (await publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "nextOrderId",
      })) as bigint;
      const price = BigInt(Math.ceil(btc.state.ask * 1.001));
      const mark = BigInt(btc.state.mrk);
      ensure(
        price >= (mark * 99n) / 100n && price <= (mark * 101n) / 100n,
        "PRICE_OUTSIDE_RISK_BOUND",
      );
      const order = {
        orderDescId: orderId,
        perpId: 16n,
        orderType: 0,
        orderId: 0n,
        pricePNS: price,
        lotLNS: lot,
        expiryBlock: 0n,
        postOnly: false,
        fillOrKill: false,
        immediateOrCancel: true,
        maxMatches: 10n,
        leverageHdths: 200n,
        lastExecutionBlock: 0n,
        amountCNS: 0n,
        maxNegPnlCollatBPS: BigInt(btc.order_max_neg_pnl_collat_bps),
      };
      const latest = await publicClient.getBlockNumber();
      order.lastExecutionBlock = latest + 20n;
      const data = encodeFunctionData({
        abi: vaultAbi,
        functionName: "executeTrade",
        args: [order],
      });
      const estimate = await publicClient.estimateGas({
        account: operator.address,
        to: vault,
        data,
      });
      ensure(estimate < 2_500_000n, "TRADE_GAS_TOO_HIGH");
      const fees = await publicClient.estimateFeesPerGas();
      ensure(fees.maxFeePerGas <= 200_000_000_000n, "GAS_PRICE_CAP");
      const nonce = await publicClient.getTransactionCount({
        address: operator.address,
        blockTag: "pending",
      });
      order.lastExecutionBlock = (await publicClient.getBlockNumber()) + 20n;
      const freshData = encodeFunctionData({
        abi: vaultAbi,
        functionName: "executeTrade",
        args: [order],
      });
      const raw = await operator.signTransaction({
        chainId: 10143,
        type: "eip1559",
        to: vault,
        data: freshData,
        nonce,
        gas: estimate + (estimate + 4n) / 5n,
        ...fees,
      });
      saved = {
        raw,
        hash: keccak256(raw),
        idempotencyKey: `live_btc_open_${attempt}`,
      };
      await writeFile(path, json(saved) + "\n", { mode: 0o600, flag: "wx" });
    }
    await request(
      `/v1/vaults/${vault}/trade-intents`,
      {
        idempotencyKey: saved.idempotencyKey,
        signedTransaction: saved.raw,
      },
      token,
    );
    let job;
    for (let i = 0; i < 90; i++) {
      try {
        job = await request(
          `/v1/trade-intents/${saved.idempotencyKey}`,
          undefined,
          token,
        );
      } catch (error) {
        if (!transientReadFailure(error)) throw error;
      }
      if (job.status === "confirmed" || job.status === "reverted") break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    ensure(job?.status === "confirmed", "TRADE_NOT_CONFIRMED");
    const live = await request(`/v1/vaults/${vault}/state`);
    ensure(
      live.state === 1 &&
        live.positions.some(
          (position: { perpId: string; lotLNS: string }) =>
            position.perpId === "16" && BigInt(position.lotLNS) > 0n,
        ),
      "TRADE_NO_FILL",
    );
    console.log(
      json({
        phase: "open",
        approvalTx: approval.transactionHash,
        depositTx: deposit.transactionHash,
        startTx: start.transactionHash,
        tradeTx: saved.hash,
        position: live.positions,
        risk: live.risk,
        riskAvailable: live.riskAvailable,
      }),
    );
  } else {
    const requestReceipt = await sendStep(
      journal,
      "request-settlement",
      owner,
      {
        to: vault,
        data: encodeFunctionData({
          abi: vaultAbi,
          functionName: "requestSettlement",
        }),
      },
    );
    let settled;
    for (let i = 0; i < 240; i++) {
      try {
        settled = await request(`/v1/vaults/${vault}/state`);
      } catch (error) {
        if (!transientReadFailure(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      if (
        settled.state === 0 &&
        settled.positions.length === 0 &&
        settled.exchangeBalance === "0"
      )
        break;
      if (i % 10 === 0)
        console.log(
          json({
            phase: "settling",
            state: settled.state,
            positions: settled.positions.length,
            exchangeBalance: settled.exchangeBalance,
          }),
        );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    ensure(
      settled?.state === 0 && settled.exchangeBalance === "0",
      "KEEPER_SETTLEMENT_INCOMPLETE",
    );
    const shares = (await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [owner.address],
      blockTag: "finalized",
    })) as bigint;
    ensure(shares > 0n, "NO_OWNER_SHARES");
    const quote = (await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "previewRedeem",
      args: [shares],
      blockTag: "finalized",
    })) as bigint;
    const redeem = await sendStep(journal, "redeem", owner, {
      to: vault,
      data: encodeFunctionData({
        abi: vaultAbi,
        functionName: "redeem",
        args: [shares, owner.address, (quote * 99n) / 100n],
      }),
    });
    const supply = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalSupply",
      blockTag: "finalized",
    });
    ensure(supply === 0n, "SHARES_REMAIN");
    console.log(
      json({
        phase: "settled",
        requestTx: requestReceipt.transactionHash,
        redeemTx: redeem.transactionHash,
        redeemedAUSD: formatUnits(quote, 6),
        totalShares: supply,
      }),
    );
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "Live testnet cycle incomplete; inspect the private journal and chain state.",
  );
  process.exitCode = 1;
});
