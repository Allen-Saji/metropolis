import { z } from "zod";

export const DEFAULTS = {
  apiUrl: "https://testnet.perpl.xyz/api",
  wsUrl: "wss://testnet.perpl.xyz",
  rpcUrl: "https://testnet-rpc.monad.xyz",
  chainId: 10_143,
  delegatedAccountFactory: "0xf42548Ccb3300Bc76c35dc2D347416db2E8d7209",
  ausdFaucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
} as const;

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const tokenSchema = z.object({
  id: z.number().int().nonnegative(),
  address: addressSchema,
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
});

const instanceSchema = z.object({
  id: z.number().int().nonnegative(),
  address: addressSchema,
  collateral_token_id: z.number().int().nonnegative(),
  min_account_open_amount: z.string().regex(/^\d+$/),
  min_deposit_amount: z.string().regex(/^\d+$/),
  min_withdraw_amount: z.string().regex(/^\d+$/),
});

const marketSchema = z.object({
  id: z.number().int().positive(),
  symbol: z.string().min(1),
  perpetual_id: z.number().int().positive(),
  order_ttl_blocks: z.number().int().positive(),
  order_max_market_slippage_bps: z.number().int().nonnegative(),
  order_max_neg_pnl_collat_bps: z.number().int().nonnegative(),
  config: z.object({
    is_open: z.boolean(),
    price_decimals: z.number().int().nonnegative(),
    size_decimals: z.number().int().nonnegative(),
    initial_margin: z.number().int().nonnegative(),
    maintenance_margin: z.number().int().nonnegative(),
    maker_fee: z.number().int(),
    taker_fee: z.number().int(),
  }),
  state: z.object({
    bid: z.number().int().nonnegative(),
    ask: z.number().int().nonnegative(),
    mrk: z.number().int().nonnegative(),
  }),
});

const contextSchema = z.object({
  chain: z.unknown(),
  instances: z.array(instanceSchema).min(1),
  tokens: z.array(tokenSchema).min(1),
  markets: z.array(marketSchema).min(1),
});

export type PerplContext = z.infer<typeof contextSchema>;
export type PerplMarket = z.infer<typeof marketSchema>;

export async function fetchPerplContext(
  apiUrl = process.env.PERPL_API_URL ?? DEFAULTS.apiUrl,
): Promise<PerplContext> {
  const response = await fetch(`${apiUrl}/v1/pub/context`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Perpl context request failed with HTTP ${response.status}`);
  }
  return contextSchema.parse(await response.json());
}

export function primaryInstance(context: PerplContext) {
  const instance = context.instances[0];
  if (!instance) throw new Error("Perpl context has no exchange instance");
  const collateral = context.tokens.find(
    (token) => token.id === instance.collateral_token_id,
  );
  if (!collateral) throw new Error("Perpl collateral token is missing from context");
  return { instance, collateral };
}
