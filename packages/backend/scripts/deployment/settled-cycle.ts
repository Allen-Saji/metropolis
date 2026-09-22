import { readFile, stat, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Hex,
  type Address,
} from "viem";
import { ensure, json } from "../../src/common.js";
import { publicClient, sendStep } from "./journal.js";

async function main() {
  ensure(
    process.env.METROPOLIS_TESTNET_DEPLOY === "true",
    "TESTNET_BROADCAST_NOT_ENABLED",
  );
  const manifest = JSON.parse(
    await readFile(
      new URL("../../../../deployments/monad-testnet.json", import.meta.url),
      "utf8",
    ),
  );
  ensure(
    manifest.chainId === 10143 && (await publicClient.getChainId()) === 10143,
    "TESTNET_ONLY",
  );
  const directory =
    process.env.METROPOLIS_PRIVATE_DIR ?? join(homedir(), ".config/metropolis");
  const path = join(directory, "perpl-spike.env");
  ensure(((await stat(path)).mode & 0o077) === 0, "INSECURE_SECRET_FILE");
  const env = parseEnv(await readFile(path, "utf8")),
    owner = privateKeyToAccount(env.MONAD_TESTNET_PRIVATE_KEY as Hex);
  ensure(
    owner.address.toLowerCase() === manifest.owner.toLowerCase(),
    "OWNER_MISMATCH",
  );
  const registryAbi = parseAbi([
    "function isQualified(uint256 agentId,address operator,bytes32 suite) view returns (bool)",
  ]);
  let qualified = false;
  for (let i = 0; i < 40; i++) {
    qualified = await publicClient.readContract({
      address: manifest.qualificationRegistry,
      abi: registryAbi,
      functionName: "isQualified",
      args: [BigInt(manifest.agentId), manifest.operator, manifest.suiteHash],
    });
    if (qualified) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  ensure(qualified, "QUALIFICATION_NOT_FINALIZED");
  const abi: Abi = JSON.parse(
    await readFile(
      new URL(
        "../../../contracts/out/MetropolisVault.sol/MetropolisVault.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ).abi;
  const tokenAbi = parseAbi([
    "function approve(address spender,uint256 amount) returns (bool)",
    "function balanceOf(address account) view returns (uint256)",
  ]);
  const vault = manifest.vault as Address,
    journal = join(directory, "testnet-settled-cycle-v1");
  const startingBalance = await publicClient.readContract({
    address: manifest.asset,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [owner.address],
  });
  const activation = await sendStep(journal, "activate-agent", owner, {
    to: vault,
    data: encodeFunctionData({
      abi,
      functionName: "activateAgent",
      args: [BigInt(manifest.agentId), manifest.operator],
    }),
  });
  const approval = await sendStep(journal, "approve-collateral", owner, {
    to: manifest.asset,
    data: encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [vault, 100_000_000n],
    }),
  });
  const deposit = await sendStep(journal, "deposit-collateral", owner, {
    to: vault,
    data: encodeFunctionData({
      abi,
      functionName: "deposit",
      args: [100_000_000n, owner.address, 100_000_000_000_000n],
    }),
  });
  const redeem = await sendStep(journal, "redeem-collateral", owner, {
    to: vault,
    data: encodeFunctionData({
      abi,
      functionName: "redeem",
      args: [100_000_000_000_000n, owner.address, 100_000_000n],
    }),
  });
  const finalBalance = await publicClient.readContract({
    address: manifest.asset,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: [owner.address],
  });
  const state = await publicClient.readContract({
    address: vault,
    abi,
    functionName: "state",
  });
  const totalSupply = await publicClient.readContract({
    address: vault,
    abi,
    functionName: "totalSupply",
  });
  const settledUntil = (await publicClient.readContract({
    address: vault,
    abi,
    functionName: "settledUntil",
  })) as bigint;
  ensure(
    startingBalance === finalBalance && state === 0 && totalSupply === 0n,
    "SETTLED_CYCLE_RECONCILIATION_FAILED",
  );
  const result = {
    chainId: 10143,
    vault,
    agentId: manifest.agentId,
    qualified,
    activationTx: activation.transactionHash,
    approvalTx: approval.transactionHash,
    depositTx: deposit.transactionHash,
    redemptionTx: redeem.transactionHash,
    collateralAUSD: "100.000000",
    recoveredAUSD: "100.000000",
    state: "settled",
    totalSupply: "0",
    tradingEligibleAt: new Date(Number(settledUntil) * 1000).toISOString(),
    verification:
      "Public-testnet qualification, activation, deposit and redemption. No Perpl trade in this application vault yet.",
  };
  await writeFile(
    new URL(
      "../../../../deployments/monad-testnet-settled-proof.json",
      import.meta.url,
    ),
    json(result) + "\n",
  );
  console.log(json(result));
}
main().catch((error) => {
  console.error(
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "Settled testnet cycle incomplete; inspect the private journal and retry identical inputs.",
  );
  process.exitCode = 1;
});
