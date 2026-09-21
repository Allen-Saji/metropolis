import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateEquity, positionIds } from "./accounting.js";

test("bitmap boundaries match all four SDK banks without treating metadata as positions", () => {
  assert.deepEqual(positionIds([(1n << 16n) | (1n << 252n) | (7n << 253n), 1n | (1n << 255n), 1n, 1n << 255n]),
    [16n, 252n, 253n, 508n, 509n, 1020n]);
  assert.throws(() => positionIds([0n]), /bitmap/);
  assert.throws(() => positionIds([-1n, 0n, 0n, 0n]), /bitmap/);
});

const position = { depositCNS: 30n, pnlCNS: -5n, deltaPnlCNS: -3n, premiumPnlCNS: -2n, markPriceValid: true };
test("position margin and PnL are included once; order locks are not added to equity", () => {
  assert.deepEqual(estimateEquity(10n, 70n, 20n, [position]), {
    estimatedEquityCNS: 105n, unlockedExchangeBalanceCNS: 50n,
  });
});
test("locked balance can exceed balance; a negative equity estimate remains visible", () => {
  assert.deepEqual(estimateEquity(0n, 1n, 2n, [{ ...position, pnlCNS: -40n, deltaPnlCNS: -38n }]), {
    estimatedEquityCNS: -9n, unlockedExchangeBalanceCNS: 0n,
  });
});
test("invalid marks and inconsistent PnL fail closed", () => {
  assert.throws(() => estimateEquity(0n, 1n, 0n, [{ ...position, markPriceValid: false }]), /mark price/);
  assert.throws(() => estimateEquity(0n, 1n, 0n, [{ ...position, pnlCNS: 5n }]), /reconcile/);
});
test("recovered account has zero equity", () => {
  assert.deepEqual(estimateEquity(0n, 0n, 0n, []), { estimatedEquityCNS: 0n, unlockedExchangeBalanceCNS: 0n });
});

test("historical BTC opening snapshot reconciles to initial funding less fee and unrealized loss", () => {
  const result = estimateEquity(0n, 57_013_629n, 0n, [{
    depositCNS: 42_956_750n, pnlCNS: -28_000n, deltaPnlCNS: -28_000n,
    premiumPnlCNS: 0n, markPriceValid: true,
  }]);
  assert.equal(result.estimatedEquityCNS, 100_000_000n - 29_621n - 28_000n);
});
