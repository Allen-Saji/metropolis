import { z } from "zod";
import { ensure, evidenceHash } from "./common.js";
// Public deterministic policy exercises, not hidden alpha tests or a profitability credential.
export const SUITE = {
  version: "policy-v1",
  initialEquity: "1000000000",
  quantityScale: "100000000",
  feeBps: 4,
  maxDrawdownBps: 1000,
  maxOrderBps: 2500,
  maxExposureBps: 10000,
  minVoluntaryTradesPerScenario: 1,
  minAggregateReturnBps: -500,
  scenarios: [
    { name: "trend", prices: [100, 102, 104, 103, 106, 108, 110, 109, 112] },
    { name: "chop", prices: [100, 102, 99, 101, 98, 100, 102, 99, 100] },
    { name: "crash-recovery", prices: [100, 99, 96, 85, 72, 78, 82, 90, 94] },
  ],
} as const;
export const SUITE_HASH = evidenceHash(SUITE);
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hold") }).strict(),
  z
    .object({
      kind: z.literal("target"),
      targetBps: z.number().int().min(-10000).max(10000),
    })
    .strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export type Evaluation = {
  step: number;
  scenario: number;
  tick: number;
  cash: string;
  quantity: string;
  highWater: string;
  maxDrawdownBps: number;
  trades: number;
  results: { name: string; equity: string; trades: number }[];
  status: "active" | "passed" | "failed" | "invalid";
  reason: string | null;
};
const Q = 100_000_000n;
const INITIAL = BigInt(SUITE.initialEquity);
const fresh = () => ({
  cash: INITIAL.toString(),
  quantity: "0",
  highWater: INITIAL.toString(),
  trades: 0,
});
export const initialEvaluation = (): Evaluation => ({
  step: 0,
  scenario: 0,
  tick: 0,
  ...fresh(),
  maxDrawdownBps: 0,
  results: [],
  status: "active",
  reason: null,
});
const abs = (v: bigint) => (v < 0n ? -v : v);
function price(s: Evaluation) {
  return BigInt(SUITE.scenarios[s.scenario]!.prices[s.tick]!) * 1_000_000n;
}
function equity(s: Evaluation) {
  return BigInt(s.cash) + (BigInt(s.quantity) * price(s)) / Q;
}
function fee(notional: bigint) {
  return (abs(notional) * BigInt(SUITE.feeBps) + 9999n) / 10000n;
}
function mark(s: Evaluation) {
  const e = equity(s),
    high = BigInt(s.highWater) > e ? BigInt(s.highWater) : e;
  s.highWater = high.toString();
  const dd = e >= high ? 0 : Number(((high - e) * 10000n + high - 1n) / high);
  s.maxDrawdownBps = Math.max(dd, s.maxDrawdownBps);
  if (e <= 0n || dd > SUITE.maxDrawdownBps) {
    s.status = "failed";
    s.reason = "DRAWDOWN_LIMIT";
  }
}
export function observation(s: Evaluation) {
  return {
    step: s.step,
    status: s.status,
    scenario: SUITE.scenarios[s.scenario]?.name ?? null,
    tick: s.tick,
    price: s.status === "active" ? price(s).toString() : null,
    equity: s.status === "active" ? equity(s).toString() : null,
    quantity: s.quantity,
    maxDrawdownBps: s.maxDrawdownBps,
    results: s.results,
    reason: s.reason,
    suiteHash: SUITE_HASH,
  };
}
export function advance(
  previous: Evaluation,
  step: number,
  action: Action,
): Evaluation {
  ensure(previous.status === "active", "RUN_FINISHED", 409);
  ensure(step === previous.step, "STEP_CONFLICT", 409);
  const s = structuredClone(previous);
  mark(s);
  if (s.status !== "active") return s;
  if (action.kind === "target") {
    const e = equity(s),
      target = (e * BigInt(action.targetBps)) / 10000n;
    const quantity = (target * Q) / price(s);
    const delta = quantity - BigInt(s.quantity),
      cost = (delta * price(s)) / Q;
    if (abs(cost) > (e * BigInt(SUITE.maxOrderBps)) / 10000n) {
      s.status = "failed";
      s.reason = "ORDER_LIMIT";
      return s;
    }
    if (delta !== 0n) {
      s.cash = (BigInt(s.cash) - cost - fee(cost)).toString();
      s.quantity = quantity.toString();
      s.trades++;
    }
    if (
      abs((quantity * price(s)) / Q) >
      (equity(s) * BigInt(SUITE.maxExposureBps)) / 10000n
    ) {
      s.status = "failed";
      s.reason = "EXPOSURE_LIMIT";
      return s;
    }
  }
  s.step++;
  const scenario = SUITE.scenarios[s.scenario]!;
  if (s.tick < scenario.prices.length - 1) {
    s.tick++;
    mark(s);
    return s;
  }
  const closeValue = (BigInt(s.quantity) * price(s)) / Q;
  s.cash = (BigInt(s.cash) + closeValue - fee(closeValue)).toString();
  s.quantity = "0";
  mark(s);
  s.results.push({ name: scenario.name, equity: s.cash, trades: s.trades });
  if (s.status !== "active") return s;
  if (s.trades < SUITE.minVoluntaryTradesPerScenario) {
    s.status = "failed";
    s.reason = "INSUFFICIENT_ACTIVITY";
    return s;
  }
  if (s.scenario === SUITE.scenarios.length - 1) {
    const total = s.results.reduce((n, r) => n + BigInt(r.equity), 0n);
    s.status =
      total >=
      (INITIAL * 3n * BigInt(10000 + SUITE.minAggregateReturnBps)) / 10000n
        ? "passed"
        : "failed";
    s.reason = s.status === "passed" ? null : "RETURN_FLOOR";
    return s;
  }
  s.scenario++;
  s.tick = 0;
  Object.assign(s, fresh());
  return s;
}
