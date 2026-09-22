import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import cors from "@fastify/cors";
import { z, ZodError } from "zod";
import type { Hex } from "viem";
import { address, uint, signature, Fault, ensure } from "./common.js";
import { actionSchema, SUITE, SUITE_HASH } from "./qualification.js";
import type { Service } from "./service.js";
const runId = z.object({ id: z.uuid() });
export async function api(service: Service, logging = true) {
  const app = Fastify({
    bodyLimit: 32768,
    requestTimeout: 15000,
    logger: logging
      ? { redact: ["req.headers.authorization", "req.body", "res.headers"] }
      : false,
  });
  await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });
  await app.register(cors, {
    origin: service.origin,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Fault)
      return reply.code(error.status).send({ error: error.code });
    if (error instanceof ZodError)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({ error: "REQUEST_REJECTED" });
    request.log.error({ code: "INTERNAL_ERROR" }, "Request failed");
    return reply.code(503).send({ error: "SERVICE_UNAVAILABLE" });
  });
  app.get("/ready", async () => {
    await service.chain.state();
    return { status: "ready" };
  });
  app.get("/health", async () => {
    await service.db.query("SELECT 1");
    return { status: "ok" };
  });
  app.get("/v1/qualification-suite", async () => ({
    suite: SUITE,
    suiteHash: SUITE_HASH,
    disclosure:
      "Public deterministic policy exercises; not proof of future profitability.",
  }));
  app.post(
    "/v1/auth/nonce",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const body = z.object({ address }).strict().parse(req.body);
      return service.challenge(body.address);
    },
  );
  app.post("/v1/auth/verify", async (req) => {
    const body = z
      .object({ nonce: z.string().regex(/^[a-f0-9]{64}$/), signature })
      .strict()
      .parse(req.body);
    return service.login(body.nonce, body.signature as Hex);
  });
  app.post("/v1/agents/:agentId/qualification-runs", async (req) => {
    const wallet = await service.authenticate(req.headers.authorization);
    const { agentId } = z.object({ agentId: uint }).parse(req.params);
    const body = z
      .object({ operator: address, publish: z.literal(true) })
      .strict()
      .parse(req.body);
    return service.start(agentId, wallet, body.operator);
  });
  app.get("/v1/agents/:agentId/status", async (req) => {
    const wallet = await service.authenticate(req.headers.authorization);
    const { agentId } = z.object({ agentId: uint }).parse(req.params);
    ensure(
      (await service.chain.identityOwner(agentId)).toLowerCase() === wallet,
      "NOT_IDENTITY_OWNER",
      403,
    );
    return service.db.query(
      "SELECT id,status,evidence_hash,created_at FROM runs WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 20",
      [agentId],
    );
  });
  app.get("/v1/qualification-runs/:id/observation", async (req) =>
    service.run(
      runId.parse(req.params).id,
      await service.authenticate(req.headers.authorization),
    ),
  );
  app.post("/v1/qualification-runs/:id/actions", async (req) => {
    const body = z
      .object({ step: z.number().int().min(0).max(1000), action: actionSchema })
      .strict()
      .parse(req.body);
    return service.act(
      runId.parse(req.params).id,
      await service.authenticate(req.headers.authorization),
      body.step,
      body.action,
    );
  });
  const vaultParams = z.object({ vaultId: address });
  const checkVault = (params: unknown) =>
    ensure(
      vaultParams.parse(params).vaultId === service.chain.vault.toLowerCase(),
      "VAULT_NOT_FOUND",
      404,
    );
  app.get("/v1/vaults/:vaultId/state", async (req) => {
    checkVault(req.params);
    return service.chain.state();
  });
  app.get("/v1/vaults/:vaultId/keeper", async (req) => {
    checkVault(req.params);
    const [lastOperation] = await service.db.query(
      "SELECT status,hash,error_code,updated_at FROM jobs WHERE kind='keeper' ORDER BY created_at DESC LIMIT 1",
    );
    const [indexedThrough] = await service.db.query(
      "SELECT block_number,block_hash FROM cursor WHERE id=1",
    );
    return {
      lastOperation: lastOperation ?? null,
      indexedThrough: indexedThrough ?? null,
    };
  });
  app.get("/v1/vaults/:vaultId/activity", async (req) => {
    checkVault(req.params);
    return service.db.query(
      "SELECT * FROM events ORDER BY block_number DESC,log_index DESC LIMIT 100",
    );
  });
  app.post("/v1/vaults/:vaultId/trade-intents", async (req) => {
    checkVault(req.params);
    const body = z
      .object({
        idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),
        signedTransaction: z
          .string()
          .regex(/^0x[0-9a-fA-F]+$/)
          .max(16000),
      })
      .strict()
      .parse(req.body);
    return service.trade(
      await service.authenticate(req.headers.authorization),
      body.idempotencyKey,
      body.signedTransaction as Hex,
    );
  });
  app.get("/v1/trade-intents/:key", async (req) => {
    const wallet = await service.authenticate(req.headers.authorization);
    const { key } = z
      .object({ key: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/) })
      .parse(req.params);
    return service.job(`trade:${wallet}:${key}`, wallet);
  });
  return app;
}
