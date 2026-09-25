import { locked } from "./db.js";
import { ensure, Fault, json } from "./common.js";
import type { Service } from "./service.js";
import type { Job, State } from "./types.js";

function needsRiskCheckpoint(s: State): boolean {
  if (!s.riskAvailable || !s.risk) return true;
  try {
    const risk = s.risk as Record<string, string>;
    const equity = BigInt(risk.equity!);
    const btc = BigInt(risk.btcNotional!);
    const eth = BigInt(risk.ethNotional!);
    const highWater = BigInt(s.highWaterEquity as string);
    return (
      equity * 10_000n < highWater * 9_000n ||
      btc > equity ||
      eth > equity ||
      btc + eth > 2n * equity
    );
  } catch {
    return true;
  }
}

export class Worker {
  private running = false;
  constructor(
    readonly service: Service,
    readonly recoveryChunk = 100_000_000n,
  ) {}
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.service.expire();
      const s = await this.service.chain.state();
      await this.index(BigInt(s.blockNumber));
      await this.service.db.query(
        "INSERT INTO snapshots(block_number,block_hash,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [s.blockNumber, s.blockHash, json(s)],
      );
      await locked(this.service.db, async (sql) => {
        const [last] = await sql.query<Job>(
          "SELECT * FROM jobs WHERE kind='keeper' ORDER BY created_at DESC LIMIT 1",
        );
        if (
          last &&
          (["queued", "prepared"].includes(last.status) ||
            this.service.now().getTime() - new Date(last.created_at).getTime() <
              30000)
        )
          return;
        let method: string | undefined, argument: string | undefined;
        if (s.state === 1 && needsRiskCheckpoint(s)) method = "checkpointRisk";
        else if (s.state === 2) {
          const open = s.positions.find((p) => BigInt(p.lotLNS) > 0n);
          if (open) {
            method = "closePosition";
            argument = open.perpId;
          } else if (BigInt(s.exchangeBalance) > 0n) {
            method = "recoverCollateral";
            argument = (
              BigInt(s.exchangeBalance) < this.recoveryChunk
                ? BigInt(s.exchangeBalance)
                : this.recoveryChunk
            ).toString();
          } else method = "finishSettlement";
        }
        if (method)
          await sql.query(
            "INSERT INTO jobs(id,kind,payload) VALUES($1,'keeper',$2) ON CONFLICT DO NOTHING",
            [
              `keeper:${s.blockNumber}:${method}`,
              json({ method, ...(argument === undefined ? {} : { argument }) }),
            ],
          );
      });
      await this.prepare();
      const pending = await this.service.db.query<Job>(
        "SELECT * FROM jobs WHERE status='prepared' ORDER BY created_at LIMIT 20",
      );
      for (const job of pending) {
        try {
          const result = await this.service.chain.receipt(job.hash!);
          if (result) {
            await this.service.db.query(
              "UPDATE jobs SET status=$2,error_code=NULL,updated_at=now() WHERE id=$1",
              [job.id, result],
            );
            continue;
          }
          if (
            await this.service.chain.nonceConsumed(
              job.signer!,
              Number(job.nonce),
            )
          ) {
            await this.service.db.query(
              "UPDATE jobs SET error_code='NONCE_CONSUMED_RECONCILIATION_REQUIRED',updated_at=now() WHERE id=$1",
              [job.id],
            );
            continue; // Keep this signer blocked. Never infer success or make a replacement transaction.
          }
          await this.service.chain.broadcast(job.raw!);
          await this.service.db.query(
            "UPDATE jobs SET error_code=NULL,updated_at=now() WHERE id=$1",
            [job.id],
          );
        } catch {
          // The node may have accepted the exact signed bytes before disconnecting.
          await this.service.db.query(
            "UPDATE jobs SET error_code='BROADCAST_OR_RECEIPT_UNCERTAIN',updated_at=now() WHERE id=$1",
            [job.id],
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
  async prepare() {
    await locked(this.service.db, async (sql) => {
      const jobs = await sql.query<Job>(
        "SELECT DISTINCT ON (kind) * FROM jobs WHERE status='queued' ORDER BY kind,created_at",
      );
      for (const job of jobs) {
        // One configured key per internal lane. Persisted rows serialize multiple worker processes.
        const lane = await sql.query(
          "SELECT id FROM jobs WHERE kind=$1 AND status='prepared'",
          [job.kind],
        );
        if (lane.length) continue;
        try {
          const p = await this.service.chain.prepare(job);
          const collision = await sql.query(
            "SELECT id FROM jobs WHERE signer=$1 AND (nonce=$2 OR status='prepared')",
            [p.signer, p.nonce],
          );
          if (collision.length) continue;
          await sql.query(
            "UPDATE jobs SET status='prepared',signer=$2,nonce=$3,raw=$4,hash=$5,updated_at=now() WHERE id=$1",
            [job.id, p.signer, p.nonce, p.raw, p.hash],
          );
        } catch (error) {
          // Definitive stale consent/expiry needs a new run. RPC/simulation failures stay retryable.
          const blocked =
            error instanceof Fault &&
            [
              "IDENTITY_OWNER_CHANGED",
              "QUALIFICATION_EXPIRED",
              "INVALID_KEEPER_METHOD",
              "STALE_KEEPER_ACTION",
            ].includes(error.code);
          await sql.query(
            "UPDATE jobs SET status=$2,error_code=$3,updated_at=now() WHERE id=$1",
            [
              job.id,
              blocked ? "blocked" : "queued",
              error instanceof Fault ? error.code : "PREPARATION_UNAVAILABLE",
            ],
          );
        }
      }
    });
  }
  async index(finalized: bigint) {
    await locked(this.service.db, async (sql) => {
      const [cursor] = await sql.query<{
        block_number: string;
        block_hash: string;
      }>("SELECT * FROM cursor WHERE id=1 FOR UPDATE");
      const previous = cursor
        ? BigInt(cursor.block_number)
        : this.service.chain.deploymentBlock - 1n;
      if (cursor)
        ensure(
          (await this.service.chain.blockHash(previous)) === cursor.block_hash,
          "FINALIZED_CURSOR_MISMATCH",
          503,
        );
      const from = previous + 1n;
      if (from > finalized) return;
      const to = from + 99n < finalized ? from + 99n : finalized;
      const hash = await this.service.chain.blockHash(to);
      const events = await this.service.chain.events(from, to);
      for (const event of events)
        await sql.query(
          "INSERT INTO events(block_number,block_hash,tx_hash,log_index,address,name,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [
            event.blockNumber,
            event.blockHash,
            event.txHash,
            event.logIndex,
            event.address,
            event.name,
            json(event.data),
          ],
        );
      ensure(
        (await this.service.chain.blockHash(to)) === hash,
        "INDEX_BLOCK_CHANGED",
        503,
      );
      await sql.query(
        "INSERT INTO cursor(id,block_number,block_hash) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET block_number=$1,block_hash=$2",
        [to.toString(), hash],
      );
    });
  }
}
