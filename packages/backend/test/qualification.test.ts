import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advance,
  initialEvaluation,
  observation,
  SUITE_HASH,
  type Action,
} from "../src/qualification.js";
function reference() {
  let s = initialEvaluation();
  while (s.status === "active")
    s = advance(
      s,
      s.step,
      s.tick === 0 ? { kind: "target", targetBps: 1000 } : { kind: "hold" },
    );
  return s;
}
test("reference policy completes three scenarios deterministically", () => {
  const a = reference();
  assert.equal(a.status, "passed");
  assert.equal(a.results.length, 3);
  assert.deepEqual(a, reference());
  assert.match(SUITE_HASH, /^0x[0-9a-f]{64}$/);
});
test("hold-only agent cannot qualify and stale actions cannot advance a run", () => {
  let s = initialEvaluation();
  assert.throws(() => advance(s, 1, { kind: "hold" }), /STEP_CONFLICT/);
  while (s.status === "active") s = advance(s, s.step, { kind: "hold" });
  assert.equal(s.reason, "INSUFFICIENT_ACTIVITY");
  assert.throws(() => advance(s, s.step, { kind: "hold" }), /RUN_FINISHED/);
});
test("oversized action fails instead of being silently clamped", () => {
  const s = advance(initialEvaluation(), 0, {
    kind: "target",
    targetBps: 3000,
  });
  assert.equal(s.status, "failed");
  assert.equal(s.reason, "ORDER_LIMIT");
});
test("observations expose only current prices and no mutable scenario array", () => {
  const s = initialEvaluation(),
    o = observation(s);
  assert.equal(o.price, "100000000");
  assert.equal("prices" in o, false);
  advance(s, 0, { kind: "hold" });
  assert.equal(s.step, 0);
});
test("fees are charged on opening and final liquidation; short accounting remains signed", () => {
  const s = advance(initialEvaluation(), 0, {
    kind: "target",
    targetBps: -1000,
  });
  assert.ok(BigInt(s.quantity) < 0n);
  assert.ok(BigInt(observation(s).equity!) < 1000000000n);
  const result = reference();
  assert.ok(BigInt(result.results[1]!.equity) < 1000000000n);
});
test("public crash scenario can fail a progressively leveraged agent on drawdown", () => {
  let s = initialEvaluation();
  let guard = 0;
  while (s.status === "active" && guard++ < 100) {
    let action: Action = { kind: "hold" };
    if (s.scenario < 2 && s.tick === 0)
      action = { kind: "target", targetBps: 1000 };
    if (s.scenario === 2 && s.tick < 4)
      action = { kind: "target", targetBps: (s.tick + 1) * 2000 };
    s = advance(s, s.step, action);
  }
  assert.equal(s.status, "failed");
  assert.ok(["DRAWDOWN_LIMIT", "ORDER_LIMIT"].includes(s.reason!));
});
