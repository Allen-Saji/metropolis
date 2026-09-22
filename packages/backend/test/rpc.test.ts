import { test } from "node:test";
import assert from "node:assert/strict";
import { requestGate } from "../src/rpc.js";
test("concurrent RPC readers reserve separate request slots", async () => {
  const gate = requestGate(30),
    starts: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      await gate();
      starts.push(Date.now());
    }),
  );
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i]! - starts[i - 1]! >= 20);
});
