import { z } from "zod";
import { address, ensure } from "./common.js";
export function configuration(env = process.env) {
  const schema = z.object({
    DATABASE_URL: z.string().url(),
    RPC_URL: z.string().url(),
    BROADCAST_RPC_URL: z.string().url().optional(),
    VAULT_ADDRESS: address,
    DEPLOYMENT_BLOCK: z.string().regex(/^[1-9][0-9]*$/),
    APP_ORIGIN: z.string().url(),
    EVALUATOR_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    KEEPER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.string().default("127.0.0.1"),
    MAX_FEE_PER_GAS: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .default("1000000000000"),
    MAX_TX_GAS: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .default("3000000"),
    RECOVERY_CHUNK: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .default("100000000"),
    KEEPER_ENABLED: z.enum(["true", "false"]).default("false"),
  });
  const parsed = schema.safeParse(env);
  // Never include environment values or Zod error inputs in logs.
  ensure(parsed.success, "INVALID_ENVIRONMENT");
  const c = parsed.data;
  ensure(
    new URL(c.APP_ORIGIN).origin === c.APP_ORIGIN,
    "APP_ORIGIN_MUST_BE_ORIGIN",
  );
  return c;
}
