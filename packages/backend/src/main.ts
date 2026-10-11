import { configuration } from "./config.js";
import { postgres, migrate, locked } from "./db.js";
import { gateway } from "./gateway.js";
import { Service } from "./service.js";
import { Worker } from "./worker.js";
import { api } from "./api.js";
import { ensure, json } from "./common.js";
import type { Hex } from "viem";

async function main() {
  const c = configuration();
  const db = postgres(c.DATABASE_URL);
  try {
    await migrate(db);
    const artifactDirectory = new URL(
      "../../../contracts/out/",
      import.meta.url,
    );
    // Compiled code lives in dist/src; source execution needs one fewer parent.
    const artifacts = import.meta.url.includes("/dist/")
      ? artifactDirectory
      : new URL("../../contracts/out/", import.meta.url);
    const chain = await gateway({
      rpcUrl: c.RPC_URL,
      broadcastRpcUrl: c.BROADCAST_RPC_URL,
      chainId: 10143,
      vault: c.VAULT_ADDRESS,
      deploymentBlock: BigInt(c.DEPLOYMENT_BLOCK),
      evaluatorKey: c.EVALUATOR_PRIVATE_KEY as Hex,
      keeperKey: c.KEEPER_PRIVATE_KEY as Hex,
      maxFeePerGas: BigInt(c.MAX_FEE_PER_GAS),
      maxGas: BigInt(c.MAX_TX_GAS),
      artifactDirectory: artifacts,
    });
    const binding = json({
      chainId: chain.chainId,
      vault: chain.vault,
      registry: chain.registry,
      deploymentBlock: chain.deploymentBlock.toString(),
    });
    await db.exec(
      "CREATE TABLE IF NOT EXISTS deployment_binding(id integer PRIMARY KEY CHECK(id=1), binding text NOT NULL)",
    );
    await locked(db, async (sql) => {
      const [row] = await sql.query<{ binding: string }>(
        "SELECT binding FROM deployment_binding WHERE id=1",
      );
      if (row) ensure(row.binding === binding, "DATABASE_DEPLOYMENT_MISMATCH");
      else
        await sql.query(
          "INSERT INTO deployment_binding(id,binding) VALUES(1,$1)",
          [binding],
        );
    });
    const service = new Service(
        db,
        chain,
        c.APP_ORIGIN,
        undefined,
        c.APP_ADDITIONAL_ORIGINS.split(",").filter(Boolean),
      ),
      worker = new Worker(service, BigInt(c.RECOVERY_CHUNK));
    const app = await api(service);
    let stopping = false;
    const loop = async () => {
      while (!stopping) {
        try {
          if (c.KEEPER_ENABLED === "true") await worker.tick();
          else await service.expire();
        } catch {
          app.log.error(
            { code: "WORKER_UNAVAILABLE" },
            "Worker tick failed; durable state retained",
          );
        }
        if (!stopping)
          await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    };
    await app.listen({ host: c.HOST, port: c.PORT });
    const work = loop();
    const shutdown = async () => {
      stopping = true;
      await app.close();
      await work;
      await db.close();
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
  } catch (error) {
    await db.close();
    throw error;
  }
}
main().catch(() => {
  console.error(
    "Backend startup failed. Check configuration, database and contract deployment.",
  );
  process.exitCode = 1;
});
