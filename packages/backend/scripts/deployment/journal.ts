import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createPublicClient,
  http,
  defineChain,
  keccak256,
  type Hex,
  type Address,
  TransactionReceiptNotFoundError,
  parseEther,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { ensure, json } from "../../src/common.js";

export const testnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
});
export const publicClient = createPublicClient({
  chain: testnet,
  transport: http(process.env.RPC_URL ?? testnet.rpcUrls.default.http[0], {
    timeout: 15000,
    retryCount: 1,
  }),
});
export async function finalized(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 90000,
  });
  ensure(receipt.status === "success", "TRANSACTION_REVERTED");
  for (let i = 0; i < 60; i++) {
    const block = await publicClient.getBlock({ blockTag: "finalized" });
    if (block.number >= receipt.blockNumber) {
      ensure(
        (await publicClient.getBlock({ blockNumber: receipt.blockNumber }))
          .hash === receipt.blockHash,
        "NONCANONICAL_RECEIPT",
      );
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("FINALITY_TIMEOUT");
}
export async function sendStep(
  directory: string,
  name: string,
  signer: PrivateKeyAccount,
  call: { to?: Address; data?: Hex; value?: bigint },
) {
  ensure((await publicClient.getChainId()) === 10143, "TESTNET_ONLY");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.json`),
    fingerprint = keccak256(
      new TextEncoder().encode(
        json({ chainId: 10143, signer: signer.address, ...call }),
      ),
    );
  let saved: { raw: Hex; hash: Hex; fingerprint: Hex; nonce: number };
  try {
    ensure(((await stat(path)).mode & 0o077) === 0, "INSECURE_JOURNAL");
    saved = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const fees = await publicClient.estimateFeesPerGas();
    ensure(fees.maxFeePerGas <= 200_000_000_000n, "GAS_PRICE_CAP");
    const estimate = call.data
      ? await publicClient.estimateGas({ account: signer.address, ...call })
      : 21000n;
    const gas = call.data ? estimate + (estimate + 9n) / 10n : estimate;
    ensure(gas <= 10_000_000n, "GAS_CAP");
    const required = gas * fees.maxFeePerGas + (call.value ?? 0n);
    ensure(required <= parseEther("2"), "STEP_BUDGET");
    ensure(
      (await publicClient.getBalance({ address: signer.address })) >= required,
      "INSUFFICIENT_TESTNET_MON",
    );
    const nonce = await publicClient.getTransactionCount({
      address: signer.address,
      blockTag: "pending",
    });
    const raw = await signer.signTransaction({
      chainId: 10143,
      type: "eip1559",
      nonce,
      gas,
      ...fees,
      ...call,
    });
    saved = { raw, hash: keccak256(raw), fingerprint, nonce };
    try {
      await writeFile(path, json(saved) + "\n", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      saved = JSON.parse(await readFile(path, "utf8"));
    }
  }
  ensure(saved.fingerprint === fingerprint, "JOURNAL_INPUT_CHANGED");
  try {
    const receipt = await publicClient.getTransactionReceipt({
      hash: saved.hash,
    });
    if (receipt) return finalized(saved.hash);
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
  }
  ensure(
    (await publicClient.getTransactionCount({
      address: signer.address,
      blockTag: "finalized",
    })) <= saved.nonce,
    "NONCE_RECONCILIATION_REQUIRED",
  );
  try {
    await publicClient.sendRawTransaction({ serializedTransaction: saved.raw });
  } catch {
    /* Same signed hash may already be accepted. */
  }
  const receipt = await finalized(saved.hash);
  console.log(
    json({ step: name, hash: saved.hash, block: receipt.blockNumber }),
  );
  return receipt;
}
