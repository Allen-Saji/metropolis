import { createHash, randomBytes } from "node:crypto";
import { keccak256, toHex, type Address } from "viem";
import { z } from "zod";
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as Address);
export const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,76})$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
export const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
// Stable key ordering is essential: PostgreSQL JSONB reorders object properties.
export const json = (value: unknown): string =>
  JSON.stringify(value, (_, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v))
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, v[k]]),
      );
    return v;
  });
export const token = () => randomBytes(32).toString("hex");
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export const evidenceHash = (v: unknown) => keccak256(toHex(json(v)));
export class Fault extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function ensure(
  condition: unknown,
  code: string,
  status = 400,
): asserts condition {
  if (!condition) throw new Fault(code, status);
}
