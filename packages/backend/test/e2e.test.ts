import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  toHex,
  encodeFunctionData,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { gateway } from "../src/gateway.js";
import { Service } from "../src/service.js";
import { Worker } from "../src/worker.js";
import { api } from "../src/api.js";
import { SUITE_HASH } from "../src/qualification.js";
import { database } from "./helpers.js";
import type { Job } from "../src/types.js";

// Public Anvil development mnemonic. Never used against a public network.
const mnemonic = "test test test test test test test test test test test junk";
const accounts = Array.from({ length: 4 }, (_, addressIndex) =>
  mnemonicToAccount(mnemonic, { addressIndex }),
);
const [owner, evaluator, keeper, operator] = accounts as [
  (typeof accounts)[number],
  (typeof accounts)[number],
  (typeof accounts)[number],
  (typeof accounts)[number],
];
const artifacts = new URL("../../contracts/out/", import.meta.url);
async function contract(
  name: string,
): Promise<{ abi: Abi; bytecode: { object: Hex } }> {
  return JSON.parse(
    await readFile(
      new URL(
        `${name.startsWith("Test") ? "Fixtures" : name}.sol/${name}.json`,
        artifacts,
      ),
      "utf8",
    ),
  );
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

test(
  "real local EVM: HTTP qualification -> publication -> signed trade -> keeper settlement -> redemption",
  { timeout: 60000 },
  async (t) => {
    const binary = process.env.ANVIL_BIN ?? `${homedir()}/.foundry/bin/anvil`;
    await access(binary); // This integration test is mandatory, not silently skipped.
    const port = await freePort(),
      rpcUrl = `http://127.0.0.1:${port}`;
    const processHandle = spawn(
      binary,
      [
        "--silent",
        "--port",
        String(port),
        "--chain-id",
        "10143",
        "--slots-in-an-epoch",
        "1",
      ],
      { stdio: "ignore" },
    );
    t.after(() => {
      processHandle.kill("SIGTERM");
    });
    const chain = defineChain({
      id: 10143,
      name: "Local Monad integration",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl, { retryCount: 0 }),
    });
    for (let i = 0; ; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch {
        if (i > 50) throw new Error("Local EVM failed to start");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const mineFinality = () =>
      publicClient.request({
        method: "anvil_mine" as any,
        params: ["0x2", "0x0"] as any,
      });
    const wallet = createWalletClient({
      account: owner,
      chain,
      transport: http(rpcUrl),
    });
    const deploy = async (name: string, args: unknown[] = []) => {
      const a = await contract(name);
      const hash = await wallet.deployContract({
        abi: a.abi,
        bytecode: a.bytecode.object,
        args,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      await mineFinality();
      return receipt.contractAddress!;
    };
    const write = async (
      address: Address,
      name: string,
      fn: string,
      args: unknown[],
      account = owner,
    ) => {
      const a = await contract(name);
      const hash = await wallet.writeContract({
        account,
        address,
        abi: a.abi,
        functionName: fn,
        args,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      await mineFinality();
    };
    const asset = await deploy("TestAsset"),
      identity = await deploy("TestIdentity"),
      exchange = await deploy("TestExchange", [asset]);
    await write(identity, "TestIdentity", "setOwner", [7n, owner.address]);
    const registry = await deploy("QualificationRegistry", [
      identity,
      evaluator.address,
    ]);
    const vault = await deploy("MetropolisVault", [
      asset,
      exchange,
      registry,
      SUITE_HASH,
      owner.address,
    ]);
    const deploymentBlock = await publicClient.getBlockNumber();
    let now = new Date();
    const g = await gateway({
      rpcUrl,
      rpcRequestIntervalMs: 0,
      chainId: 10143,
      vault: vault.toLowerCase() as Address,
      deploymentBlock,
      evaluatorKey: toHex(evaluator.getHdKey().privateKey!),
      keeperKey: toHex(keeper.getHdKey().privateKey!),
      maxFeePerGas: 1_000_000_000_000n,
      maxGas: 3_000_000n,
      artifactDirectory: artifacts,
      nowSeconds: () => Math.floor(now.getTime() / 1000),
    });
    const db = await database();
    const service = new Service(db, g, "http://localhost:3000", () => now);
    const app = await api(service, false);
    t.after(async () => {
      await app.close();
      await db.close();
    });
    const login = async (account: typeof owner) => {
      const challenge = (
        await app.inject({
          method: "POST",
          url: "/v1/auth/nonce",
          payload: { address: account.address },
        })
      ).json();
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/verify",
        payload: {
          nonce: challenge.nonce,
          signature: await account.signMessage({ message: challenge.message }),
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      return { authorization: `Bearer ${response.json().token}` };
    };
    let ownerAuth = await login(owner),
      operatorAuth = await login(operator);
    let response = await app.inject({
      method: "POST",
      url: "/v1/agents/7/qualification-runs",
      headers: ownerAuth,
      payload: { operator: operator.address, publish: true },
    });
    assert.equal(response.statusCode, 200, response.body);
    let run = response.json();
    while (run.observation.status === "active") {
      response = await app.inject({
        method: "POST",
        url: `/v1/qualification-runs/${run.id}/actions`,
        headers: operatorAuth,
        payload: {
          step: run.observation.step,
          action:
            run.observation.tick === 0
              ? { kind: "target", targetBps: 1000 }
              : { kind: "hold" },
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      run = response.json();
    }
    assert.equal(run.observation.status, "passed");
    const worker = new Worker(service, 1000_000_000n);
    await worker.tick();
    await mineFinality();
    await worker.tick();
    let [publication] = await db.query<Job>(
      "SELECT * FROM jobs WHERE kind='qualification'",
    );
    assert.equal(
      publication!.status,
      "confirmed",
      publication!.error_code ?? "publication pending",
    );
    const reg = await contract("QualificationRegistry");
    assert.equal(
      await publicClient.readContract({
        address: registry,
        abi: reg.abi,
        functionName: "isQualified",
        args: [7n, operator.address, SUITE_HASH],
      }),
      true,
    );
    await write(asset, "TestAsset", "mint", [owner.address, 1000_000_000n]);
    await write(asset, "TestAsset", "approve", [vault, 1000_000_000n]);
    await write(vault, "MetropolisVault", "deposit", [
      1000_000_000n,
      owner.address,
      1000_000_000_000_000n,
    ]);
    await write(vault, "MetropolisVault", "activateAgent", [
      7n,
      operator.address,
    ]);
    const latest = await publicClient.getBlock();
    now = new Date((Number(latest.timestamp) + 3601) * 1000);
    await publicClient.request({
      method: "evm_setNextBlockTimestamp" as any,
      params: [Math.floor(now.getTime() / 1000)] as any,
    });
    await write(vault, "MetropolisVault", "startTrading", [1000_000_000n]);
    ownerAuth = await login(owner);
    operatorAuth = await login(operator);
    const v = await contract("MetropolisVault");
    const block = await publicClient.getBlockNumber();
    const order = {
      orderDescId: 1n,
      perpId: 16n,
      orderType: 0,
      orderId: 0n,
      pricePNS: 100000n,
      lotLNS: 10n,
      expiryBlock: 0n,
      postOnly: false,
      fillOrKill: false,
      immediateOrCancel: true,
      maxMatches: 10n,
      leverageHdths: 200n,
      lastExecutionBlock: block + 20n,
      amountCNS: 0n,
      maxNegPnlCollatBPS: 1000n,
    };
    const raw = await operator.signTransaction({
      chainId: 10143,
      type: "eip1559",
      to: vault,
      data: encodeFunctionData({
        abi: v.abi,
        functionName: "executeTrade",
        args: [order],
      }),
      nonce: 0,
      gas: 1_000_000n,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    await assert.rejects(
      g.validateTrade(raw, owner.address.toLowerCase() as Address),
      /WRONG_TRANSACTION_SIGNER/,
    );
    await assert.rejects(
      g.validateTrade("0x02dead", operator.address.toLowerCase() as Address),
      /INVALID_SIGNED_TRANSACTION/,
    );
    const forbidden = await operator.signTransaction({
      chainId: 10143,
      type: "eip1559",
      to: vault,
      data: encodeFunctionData({
        abi: v.abi,
        functionName: "setPaused",
        args: [true],
      }),
      nonce: 0,
      gas: 1_000_000n,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    await assert.rejects(
      g.validateTrade(forbidden, operator.address.toLowerCase() as Address),
      /TRADE_METHOD_ONLY/,
    );
    const oversized = await operator.signTransaction({
      chainId: 10143,
      type: "eip1559",
      to: vault,
      data: encodeFunctionData({
        abi: v.abi,
        functionName: "executeTrade",
        args: [{ ...order, lotLNS: 251n }],
      }),
      nonce: 0,
      gas: 1_000_000n,
      maxFeePerGas: 10_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    await assert.rejects(
      g.validateTrade(oversized, operator.address.toLowerCase() as Address),
      /TRANSACTION_REJECTED/,
    );
    response = await app.inject({
      method: "POST",
      url: `/v1/vaults/${vault}/trade-intents`,
      headers: operatorAuth,
      payload: { idempotencyKey: "e2e_trade_1", signedTransaction: raw },
    });
    assert.equal(response.statusCode, 200, response.body);
    await worker.tick();
    await mineFinality();
    await worker.tick();
    assert.equal(
      (
        await service.job(
          `trade:${operator.address.toLowerCase()}:e2e_trade_1`,
          operator.address.toLowerCase() as Address,
        )
      ).status,
      "confirmed",
    );
    assert.equal((await g.state()).positions.length, 1);
    await write(vault, "MetropolisVault", "requestSettlement", []);
    // Advance the service scheduler without changing market validity (test exchange uses block time).
    for (let i = 0; i < 8 && (await g.state()).state !== 0; i++) {
      now = new Date(now.getTime() + 31000);
      await publicClient.request({
        method: "evm_setNextBlockTimestamp" as any,
        params: [Math.floor(now.getTime() / 1000)] as any,
      });
      await publicClient.request({
        method: "evm_mine" as any,
        params: [] as any,
      });
      await worker.tick();
      await mineFinality();
      await worker.tick();
    }
    assert.equal((await g.state()).state, 0, "keeper must finish settlement");
    await write(vault, "MetropolisVault", "redeem", [
      1000_000_000_000_000n,
      owner.address,
      1000_000_000n,
    ]);
    await worker.tick();
    assert.ok((await db.query("SELECT * FROM events")).length > 0);
    const hashes = await db.query<{ hash: string }>(
      "SELECT hash FROM jobs WHERE hash IS NOT NULL",
    );
    assert.equal(new Set(hashes.map((x) => x.hash)).size, hashes.length);
  },
);
