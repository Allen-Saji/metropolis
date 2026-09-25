import { randomUUID } from "node:crypto";
import { createSiweMessage } from "viem/siwe";
import { type Address, type Hex } from "viem";
import { type Database, locked, type Sql } from "./db.js";
import { digest, ensure, evidenceHash, json, token } from "./common.js";
import {
  advance,
  initialEvaluation,
  observation,
  SUITE_HASH,
  type Action,
} from "./qualification.js";
import type { Gateway, Job, Run } from "./types.js";

export class Service {
  constructor(
    readonly db: Database,
    readonly chain: Gateway,
    readonly origin: string,
    readonly now = () => new Date(),
  ) {}
  async challenge(wallet: Address) {
    const nonce = token(),
      issuedAt = this.now(),
      expiry = new Date(issuedAt.getTime() + 300_000);
    const message = createSiweMessage({
      address: wallet,
      chainId: this.chain.chainId,
      domain: new URL(this.origin).host,
      uri: this.origin,
      version: "1",
      nonce,
      issuedAt,
      expirationTime: expiry,
      statement:
        "Sign in to Metropolis. This does not authorize token transfers.",
    });
    await this.db.query(
      "INSERT INTO challenges(nonce,address,message,expires_at) VALUES($1,$2,$3,$4)",
      [nonce, wallet, message, expiry],
    );
    return { nonce, message, expiresAt: expiry };
  }
  async login(nonce: string, signature: Hex) {
    const [challenge] = await this.db.query<{
      address: Address;
      message: string;
      expires_at: Date;
    }>("SELECT * FROM challenges WHERE nonce=$1", [nonce]);
    ensure(
      challenge && new Date(challenge.expires_at) > this.now(),
      "CHALLENGE_EXPIRED",
      401,
    );
    ensure(
      await this.chain.verify(challenge.address, challenge.message, signature),
      "INVALID_SIGNATURE",
      401,
    );
    const bearer = token(),
      expiry = new Date(this.now().getTime() + 3_600_000);
    await this.db.transaction(async (sql) => {
      const rows = await sql.query(
        "DELETE FROM challenges WHERE nonce=$1 AND expires_at>$2 RETURNING nonce",
        [nonce, this.now()],
      );
      ensure(rows.length === 1, "CHALLENGE_CONSUMED", 401);
      await sql.query(
        "INSERT INTO sessions(token_hash,address,expires_at) VALUES($1,$2,$3)",
        [digest(bearer), challenge.address, expiry],
      );
    });
    return { token: bearer, expiresAt: expiry, address: challenge.address };
  }
  async authenticate(bearer: string | undefined): Promise<Address> {
    ensure(
      bearer && bearer.startsWith("Bearer ") && bearer.length === 71,
      "UNAUTHENTICATED",
      401,
    );
    const [row] = await this.db.query<{ address: Address }>(
      "SELECT address FROM sessions WHERE token_hash=$1 AND expires_at>$2",
      [digest(bearer.slice(7)), this.now()],
    );
    ensure(row, "SESSION_EXPIRED", 401);
    return row.address;
  }
  async start(agentId: string, owner: Address, operator: Address) {
    ensure(
      (await this.chain.identityOwner(agentId)).toLowerCase() === owner,
      "NOT_IDENTITY_OWNER",
      403,
    );
    const id = randomUUID();
    await locked(this.db, async (sql) => {
      const active = await sql.query(
        "SELECT id FROM runs WHERE agent_id=$1 AND status='active'",
        [agentId],
      );
      const pending = await sql.query(
        "SELECT id FROM jobs WHERE kind='qualification' AND payload->>'agentId'=$1 AND status IN ('queued','prepared')",
        [agentId],
      );
      ensure(!active.length && !pending.length, "AGENT_BUSY", 409);
      await sql.query(
        "INSERT INTO runs(id,agent_id,owner,operator,suite_hash,state,status,deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          id,
          agentId,
          owner,
          operator,
          SUITE_HASH,
          json(initialEvaluation()),
          "active",
          new Date(this.now().getTime() + 900_000),
        ],
      );
    });
    return this.run(id, owner);
  }
  async run(id: string, wallet: Address) {
    const [run] = await this.db.query<Run>("SELECT * FROM runs WHERE id=$1", [
      id,
    ]);
    ensure(run, "RUN_NOT_FOUND", 404);
    ensure(wallet === run.owner || wallet === run.operator, "FORBIDDEN", 403);
    const [publication] = await this.db.query(
      "SELECT status,hash,error_code FROM jobs WHERE id=$1",
      [`qualification:${id}`],
    );
    return {
      id,
      agentId: run.agent_id,
      operator: run.operator,
      observation: observation(run.state),
      deadline: run.deadline,
      evidence: run.evidence,
      evidenceHash: run.evidence_hash,
      publication: publication ?? null,
    };
  }
  async act(id: string, wallet: Address, step: number, action: Action) {
    await locked(this.db, async (sql) => {
      const [run] = await sql.query<Run>(
        "SELECT * FROM runs WHERE id=$1 FOR UPDATE",
        [id],
      );
      ensure(run, "RUN_NOT_FOUND", 404);
      ensure(wallet === run.operator, "NOT_RUN_OPERATOR", 403);
      const actionHash = evidenceHash({ step, action });
      const prior = run.actions.find((a) => a.step === step);
      if (prior) {
        ensure(prior.hash === actionHash, "ACTION_CONFLICT", 409);
        return;
      }
      ensure(new Date(run.deadline) > this.now(), "RUN_EXPIRED", 409);
      const next = advance(run.state, step, action);
      run.actions.push({ step, action, hash: actionHash });
      run.state = next;
      run.status = next.status;
      await sql.query(
        "UPDATE runs SET state=$2,actions=$3,status=$4 WHERE id=$1",
        [id, json(next), json(run.actions), next.status],
      );
      if (next.status !== "active") await this.finalize(sql, run);
    });
    return this.run(id, wallet);
  }
  async finalize(sql: Sql, run: Run) {
    const finishedAt = this.now();
    const evidence = {
      version: 1,
      runId: run.id,
      agentId: run.agent_id,
      owner: run.owner,
      operator: run.operator,
      suiteHash: run.suite_hash,
      startedAt: new Date(run.created_at).toISOString(),
      finishedAt: finishedAt.toISOString(),
      actions: run.actions,
      result: run.state,
    };
    const hash = evidenceHash(evidence);
    await sql.query(
      "UPDATE runs SET evidence=$2,evidence_hash=$3 WHERE id=$1",
      [run.id, json(evidence), hash],
    );
    await sql.query("INSERT INTO jobs(id,kind,payload) VALUES($1,$2,$3)", [
      `qualification:${run.id}`,
      "qualification",
      json({
        runId: run.id,
        agentId: run.agent_id,
        owner: run.owner,
        operator: run.operator,
        suite: run.suite_hash,
        evidence: hash,
        passed: run.status === "passed",
        expiresAt: Math.floor(finishedAt.getTime() / 1000) + 7 * 86400,
      }),
    ]);
  }
  async expire() {
    await locked(this.db, async (sql) => {
      const runs = await sql.query<Run>(
        "SELECT * FROM runs WHERE status='active' AND deadline<=$1 FOR UPDATE",
        [this.now()],
      );
      for (const run of runs) {
        run.status = "invalid";
        run.state.status = "invalid";
        run.state.reason = "TIMEOUT";
        await sql.query("UPDATE runs SET status=$2,state=$3 WHERE id=$1", [
          run.id,
          "invalid",
          json(run.state),
        ]);
        await this.finalize(sql, run);
      }
      await sql.query("DELETE FROM challenges WHERE expires_at<$1", [
        this.now(),
      ]);
      await sql.query("DELETE FROM sessions WHERE expires_at<$1", [this.now()]);
    });
  }
  async trade(wallet: Address, idempotencyKey: string, raw: Hex) {
    const id = `trade:${wallet}:${idempotencyKey}`;
    const [prior] = await this.db.query<Job>("SELECT * FROM jobs WHERE id=$1", [
      id,
    ]);
    if (prior) {
      ensure(prior.raw === raw, "IDEMPOTENCY_CONFLICT", 409);
      return this.job(id, wallet);
    }
    const prepared = await this.chain.validateTrade(raw, wallet);
    await locked(this.db, async (sql) => {
      const [again] = await sql.query<Job>("SELECT * FROM jobs WHERE id=$1", [
        id,
      ]);
      if (again) {
        ensure(again.raw === raw, "IDEMPOTENCY_CONFLICT", 409);
        return;
      }
      const busy = await sql.query(
        "SELECT id FROM jobs WHERE (signer=$1 AND (status='prepared' OR nonce=$2)) OR hash=$3",
        [prepared.signer, prepared.nonce, prepared.hash],
      );
      ensure(!busy.length, "SIGNER_OR_TRANSACTION_BUSY", 409);
      await sql.query(
        "INSERT INTO jobs(id,kind,payload,status,signer,nonce,raw,hash) VALUES($1,'trade',$2,'prepared',$3,$4,$5,$6)",
        [
          id,
          json({ wallet }),
          prepared.signer,
          prepared.nonce,
          prepared.raw,
          prepared.hash,
        ],
      );
    });
    // The bytes are durable before broadcast. A short-lived IOC order cannot wait
    // for the next worker tick; any uncertain send is retried with these same bytes.
    try {
      await this.chain.broadcast(raw);
    } catch {
      await this.db.query(
        "UPDATE jobs SET error_code='BROADCAST_OR_RECEIPT_UNCERTAIN',updated_at=now() WHERE id=$1",
        [id],
      );
    }
    return this.job(id, wallet);
  }
  async job(id: string, wallet: Address) {
    const [row] = await this.db.query<Job>("SELECT * FROM jobs WHERE id=$1", [
      id,
    ]);
    ensure(row, "JOB_NOT_FOUND", 404);
    ensure(
      row.kind === "trade" && row.payload.wallet === wallet,
      "FORBIDDEN",
      403,
    );
    return {
      id: row.id,
      status: row.status,
      hash: row.hash,
      errorCode: row.error_code,
    };
  }
}
