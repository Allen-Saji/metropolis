import { test } from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service.js";
import { Worker } from "../src/worker.js";
import { api } from "../src/api.js";
import {
  database,
  FakeChain,
  owner,
  operator,
  outsider,
  lower,
} from "./helpers.js";
import type { Job } from "../src/types.js";
import { evidenceHash } from "../src/common.js";

test("SIWE challenge is exact, single-use and session tokens are hashed", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const chain = new FakeChain(),
    s = new Service(db, chain, "http://localhost:3000");
  const c = await s.challenge(lower(owner.address));
  await assert.rejects(
    s.login(
      c.nonce,
      await owner.signMessage({ message: c.message + " tampered" }),
    ),
    /INVALID_SIGNATURE/,
  );
  const session = await s.login(
    c.nonce,
    await owner.signMessage({ message: c.message }),
  );
  assert.equal(
    await s.authenticate(`Bearer ${session.token}`),
    lower(owner.address),
  );
  await assert.rejects(
    s.login(c.nonce, await owner.signMessage({ message: c.message })),
    /CHALLENGE_EXPIRED/,
  );
  const rows = await db.query<{ token_hash: string }>(
    "SELECT token_hash FROM sessions",
  );
  assert.notEqual(rows[0]!.token_hash, session.token);
});

test("qualification requires owner consent; actions are operator-only and idempotent", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const s = new Service(db, new FakeChain(), "http://localhost:3000");
  await assert.rejects(
    s.start("7", lower(outsider.address), lower(operator.address)),
    /NOT_IDENTITY_OWNER/,
  );
  const r = await s.start("7", lower(owner.address), lower(operator.address));
  await assert.rejects(
    s.start("7", lower(owner.address), lower(operator.address)),
    /AGENT_BUSY/,
  );
  await assert.rejects(
    s.act(r.id, lower(owner.address), 0, { kind: "hold" }),
    /NOT_RUN_OPERATOR/,
  );
  const a = await s.act(r.id, lower(operator.address), 0, {
    kind: "target",
    targetBps: 1000,
  });
  const b = await s.act(r.id, lower(operator.address), 0, {
    kind: "target",
    targetBps: 1000,
  });
  assert.deepEqual(a, b);
  await assert.rejects(
    s.act(r.id, lower(operator.address), 0, { kind: "hold" }),
    /ACTION_CONFLICT/,
  );
});

test("concurrent actions advance once; completed run publishes immutable evidence", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const s = new Service(db, new FakeChain(), "http://localhost:3000");
  let r = await s.start("7", lower(owner.address), lower(operator.address));
  await Promise.all([
    s.act(r.id, lower(operator.address), 0, {
      kind: "target",
      targetBps: 1000,
    }),
    s.act(r.id, lower(operator.address), 0, {
      kind: "target",
      targetBps: 1000,
    }),
  ]);
  r = await s.run(r.id, lower(operator.address));
  assert.equal(r.observation.step, 1);
  while (r.observation.status === "active")
    r = await s.act(
      r.id,
      lower(operator.address),
      r.observation.step,
      r.observation.tick === 0
        ? { kind: "target", targetBps: 1000 }
        : { kind: "hold" },
    );
  assert.equal(r.observation.status, "passed");
  assert.equal(r.evidenceHash, evidenceHash(r.evidence));
  const jobs = await db.query<Job>("SELECT * FROM jobs");
  assert.equal(jobs.length, 1);
  assert.equal("passed" in jobs[0]!.payload && jobs[0]!.payload.passed, true);
  await assert.rejects(
    s.start("7", lower(owner.address), lower(operator.address)),
    /AGENT_BUSY/,
  );
  const restarted = new Service(db, s.chain, s.origin);
  assert.deepEqual(await restarted.run(r.id, lower(owner.address)), r);
});

test("timeout is persisted and published as a non-passing attempt", async (t) => {
  const db = await database();
  t.after(() => db.close());
  let now = new Date();
  const s = new Service(
    db,
    new FakeChain(),
    "http://localhost:3000",
    () => now,
  );
  const r = await s.start("7", lower(owner.address), lower(operator.address));
  now = new Date(now.getTime() + 901000);
  await s.expire();
  assert.equal(
    (await s.run(r.id, lower(owner.address))).observation.status,
    "invalid",
  );
  const [job] = await db.query<Job>("SELECT * FROM jobs");
  assert.equal("passed" in job!.payload && job!.payload.passed, false);
});

test("ambiguous broadcast survives restart and reuses the same signed transaction", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const chain = new FakeChain(),
    s = new Service(db, chain, "http://localhost:3000");
  await s.trade(lower(operator.address), "request_01", "0x1234");
  chain.throwAfterBroadcast = true;
  await new Worker(s).tick();
  const [before] = await db.query<Job>("SELECT * FROM jobs");
  assert.equal(before!.status, "prepared");
  chain.throwAfterBroadcast = false;
  await new Worker(new Service(db, chain, s.origin)).tick();
  assert.deepEqual(chain.broadcasts, ["0x1234", "0x1234"]);
  assert.equal(chain.prepared, 0);
  chain.result = "confirmed";
  await new Worker(s).tick();
  assert.equal(
    (await s.job(before!.id, lower(operator.address))).status,
    "confirmed",
  );
  await assert.rejects(
    s.trade(lower(operator.address), "request_01", "0x4567"),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("nonce consumed by an unknown transaction blocks signer instead of issuing replacements", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const chain = new FakeChain(),
    s = new Service(db, chain, "http://localhost:3000");
  await s.trade(lower(operator.address), "request_01", "0x1234");
  chain.consumed = true;
  await new Worker(s).tick();
  assert.equal(chain.broadcasts.length, 0);
  const [row] = await db.query<Job>("SELECT * FROM jobs");
  assert.match(row!.error_code!, /RECONCILIATION_REQUIRED/);
  await assert.rejects(
    s.trade(lower(operator.address), "request_02", "0x5678"),
    /SIGNER_OR_TRANSACTION_BUSY/,
  );
});

test("keeper plans close-only recovery and event backfill deduplicates", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const chain = new FakeChain(),
    s = new Service(db, chain, "http://localhost:3000");
  chain.current = {
    ...chain.current,
    state: 2,
    accountId: "1",
    exchangeBalance: "50",
    positions: [{ perpId: "16", lotLNS: "10" }],
  };
  chain.logs = [
    {
      blockNumber: "1",
      blockHash: chain.hash,
      txHash: chain.hash,
      logIndex: 1,
      address: chain.vault,
      name: "TradeExecuted",
      data: {},
    },
  ];
  await new Worker(s).tick();
  await new Worker(s).tick();
  const rows = await db.query<Job>("SELECT * FROM jobs WHERE kind='keeper'");
  assert.equal(rows.length, 1);
  assert.equal(
    "method" in rows[0]!.payload && rows[0]!.payload.method,
    "closePosition",
  );
  assert.equal((await db.query("SELECT * FROM events")).length, 1);
  chain.hash = "0xabcdef";
  await assert.rejects(new Worker(s).tick(), /FINALIZED_CURSOR_MISMATCH/);
});

test("HTTP routes validate inputs and authorization; no manager mutation endpoint", async (t) => {
  const db = await database();
  const app = await api(
    new Service(db, new FakeChain(), "http://localhost:3000"),
    false,
  );
  t.after(async () => {
    await app.close();
    await db.close();
  });
  assert.equal(
    (await app.inject({ method: "GET", url: "/health" })).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/auth/nonce",
        payload: { address: "broken" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/agents/7/qualification-runs",
        payload: { operator: operator.address, publish: true },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/vaults/x/pause" }))
      .statusCode,
    404,
  );
  const challenge = (
    await app.inject({
      method: "POST",
      url: "/v1/auth/nonce",
      payload: { address: owner.address },
    })
  ).json();
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: {
      nonce: challenge.nonce,
      signature: await owner.signMessage({ message: challenge.message }),
    },
  });
  assert.equal(response.statusCode, 200);
  const session = response.json();
  const run = await app.inject({
    method: "POST",
    url: "/v1/agents/7/qualification-runs",
    headers: { authorization: `Bearer ${session.token}` },
    payload: { operator: operator.address, publish: true },
  });
  assert.equal(run.statusCode, 200);
});

test("expired challenges and sessions cannot authenticate", async (t) => {
  const db = await database();
  t.after(() => db.close());
  let now = new Date();
  const s = new Service(
    db,
    new FakeChain(),
    "http://localhost:3000",
    () => now,
  );
  const c = await s.challenge(lower(owner.address));
  now = new Date(now.getTime() + 300001);
  await assert.rejects(
    s.login(c.nonce, await owner.signMessage({ message: c.message })),
    /CHALLENGE_EXPIRED/,
  );
  const fresh = await s.challenge(lower(owner.address));
  const session = await s.login(
    fresh.nonce,
    await owner.signMessage({ message: fresh.message }),
  );
  now = new Date(now.getTime() + 3600001);
  await assert.rejects(
    s.authenticate(`Bearer ${session.token}`),
    /SESSION_EXPIRED/,
  );
});

test("preparation failure does not broadcast or invent a transaction hash", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const chain = new FakeChain(),
    s = new Service(db, chain, "http://localhost:3000");
  const r = await s.start("7", lower(owner.address), lower(operator.address));
  await s.act(r.id, lower(operator.address), 0, {
    kind: "target",
    targetBps: 3000,
  });
  chain.prepare = async () => {
    throw new Error("RPC unavailable");
  };
  await new Worker(s).tick();
  const [row] = await db.query<Job>("SELECT * FROM jobs");
  assert.equal(row!.status, "queued");
  assert.equal(row!.hash, null);
  assert.equal(chain.broadcasts.length, 0);
});

test("definitive reverted receipt remains distinct from qualification success", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const chain = new FakeChain(),
    s = new Service(db, chain, "http://localhost:3000");
  await s.trade(lower(operator.address), "reverted_01", "0x1234");
  chain.result = "reverted";
  await new Worker(s).tick();
  assert.equal(
    (
      await s.job(
        `trade:${lower(operator.address)}:reverted_01`,
        lower(operator.address),
      )
    ).status,
    "reverted",
  );
  assert.equal(chain.broadcasts.length, 0);
});

test("finalized backfill respects the public RPC 100-block range limit", async (t) => {
  const db = await database();
  t.after(() => db.close());
  const chain = new FakeChain();
  chain.events = async (from, to) => {
    assert.ok(to - from + 1n <= 100n);
    return [];
  };
  const worker = new Worker(new Service(db, chain, "http://localhost:3000"));
  await worker.index(250n);
  await worker.index(250n);
  await worker.index(250n);
  const [cursor] = await db.query<{ block_number: string }>(
    "SELECT block_number FROM cursor",
  );
  assert.equal(String(cursor!.block_number), "250");
});
